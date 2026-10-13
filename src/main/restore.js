'use strict';

// Восстановление истории из резервных копий базы.
//
// Копии появляются рядом с battles.db сами:
//   · battles.db.<время>.bak — перед миграцией схемы и перед очисткой истории
//     (Db.backup, VACUUM INTO);
//   · battles.db.corrupt-<время> — испорченная база, отложенная при запуске
//     (Db.open, с 1.0.2), иногда с журналом -wal рядом.
// До 1.0.4 вернуть из них бои можно было только руками. Теперь — из настроек.
//
// Правила, которые здесь соблюдаются:
//   · оригиналы НЕ ОТКРЫВАЮТСЯ ВОВСЕ: файл (и его -wal) копируется во
//     временную папку, и всё дальнейшее — миграция старой схемы, проверка,
//     спасение читаемого — делается с копией. Открыть базу SQLite «только на
//     чтение» недостаточно: при открытии она может доиграть журнал в главный
//     файл, то есть изменить его;
//   · копия доводится до текущей схемы тем же кодом, что и рабочая база
//     (new Db → init → migrate), а испорченная спасается тем же способом, что
//     и при запуске (Db.open → salvage): что читается — переносится, что нет —
//     перечисляется человеку;
//   · бой, который уже есть в текущей базе, не дублируется: совпадение по
//     ключу сервера или по времени начала (время начала у одного боя одно, и
//     совпадение по нему строже пары «начало, конец»);
//   · восстановленный бой помечается «без входа» (trust='guest',
//     origin='backup') и на сервер не уходит никогда: под каким входом он был
//     записан, по копии уже не узнать, а загрузка накопленной истории на
//     сервер запрещена (см. sync.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Db } = require('./db');

const BASE = 'battles.db';

/**
 * Время из имени копии: «2026-08-15T04-24-44-748Z» → миллисекунды.
 * В имени двоеточия и точка заменены дефисами (Windows их не любит).
 */
function stampTime(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp || '');
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Что за файл перед нами, по имени. null — не копия базы (или журнал копии).
 * @returns {{kind: 'backup'|'corrupt', stamp: string}|null}
 */
function classify(name) {
  if (!name.startsWith(`${BASE}.`)) return null;
  const rest = name.slice(BASE.length + 1);
  let m = /^(.+)\.bak$/.exec(rest);
  if (m) return { kind: 'backup', stamp: m[1] };
  // Журнал и индекс отложенной базы лежат рядом под её же именем с -wal/-shm:
  // это не отдельные копии, они едут вместе с главным файлом.
  m = /^corrupt-(.+?)$/.exec(rest);
  if (m && !/-(wal|shm|journal)$/.test(m[1])) return { kind: 'corrupt', stamp: m[1] };
  return null;
}

/**
 * Копии рядом с базой, от свежих к старым.
 * @param {string} dir - папка с battles.db
 */
function findBackups(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const kind = classify(name);
    if (!kind) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      file,
      name,
      kind: kind.kind,
      // Время из имени — момент, когда копия сделана; если имя чужого
      // формата, — время изменения файла.
      madeAt: stampTime(kind.stamp) ?? stat.mtimeMs,
      size: stat.size,
    });
  }
  return out.sort((a, b) => b.madeAt - a.madeAt);
}

/**
 * Готовит копию к чтению: копирует во временную папку и открывает там как
 * обычную базу программы — со всеми миграциями и со спасением испорченного.
 *
 * @param {string} file - копия рядом с базой
 * @param {string} workRoot - где заводить временные папки
 * @returns {{dir: string, db: Db, recovery: object|null}}
 */
function prepare(file, workRoot = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(workRoot, 'sightline-restore-'));
  fs.copyFileSync(file, path.join(dir, BASE));
  // Журнал едет вместе с файлом: без него копия испорченной базы — это база
  // на момент последней контрольной точки, а свежее лежит как раз в журнале.
  // -shm не копируем: это индекс журнала, SQLite построит его заново.
  if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, path.join(dir, `${BASE}-wal`));
  const db = new Db(dir);
  return { dir, db, recovery: db.recovery };
}

/** Убрать временную папку. Ошибку глотаем: это мусор во временном каталоге. */
function discard(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Файл мог остаться занятым — Windows удалит его вместе с временными.
  }
}

/**
 * Бои копии, которых нет в текущей базе.
 *
 * Бои, пришедшие в копию с сервера (origin='server', копии с 1.0.4), не
 * берутся вовсе: они лежат на сервере и возвращаются оттуда сами, со своим
 * хозяином и отметкой доверия, — а из копии они легли бы «без входа» и без
 * хозяина, то есть в историю любого, кто войдёт на этой машине. Копия к этому
 * моменту уже доведена до текущей схемы, так что колонка origin в ней есть.
 */
function newBattleIds(source, target) {
  const rows = source.db
    .prepare(
      "SELECT id, started_at, server_key FROM battles WHERE origin <> 'server' ORDER BY started_at, id"
    )
    .all();
  const exists = target.db.prepare(
    `SELECT 1 FROM battles
      WHERE started_at = ? OR (? IS NOT NULL AND server_key = ?)
      LIMIT 1`
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    // Внутри одной копии один бой тоже мог лечь дважды (старые версии писали
    // его заново при каждом сохранении) — берём первую запись.
    if (seen.has(r.started_at)) continue;
    seen.add(r.started_at);
    if (exists.get(r.started_at, r.server_key ?? null, r.server_key ?? null)) continue;
    out.push(r.id);
  }
  return out;
}

/**
 * Посмотреть копию: сколько в ней боёв, за какие дни, сколько из них новых,
 * что не прочиталось.
 */
function inspect(entry, target, workRoot) {
  const info = {
    file: entry.file,
    name: entry.name,
    kind: entry.kind,
    madeAt: entry.madeAt,
    size: entry.size,
    battles: 0,
    newBattles: 0,
    firstAt: null,
    lastAt: null,
    salvaged: null,
    unreadable: [],
    error: null,
    workDir: null,
  };
  let prepared;
  try {
    prepared = prepare(entry.file, workRoot);
  } catch (e) {
    info.error = e.message;
    return info;
  }
  try {
    info.workDir = prepared.dir;
    const r = prepared.db.db
      .prepare('SELECT COUNT(*) n, MIN(started_at) a, MAX(started_at) b FROM battles')
      .get();
    info.battles = r.n;
    info.firstAt = r.a;
    info.lastAt = r.b;
    info.newBattles = newBattleIds(prepared.db, target).length;
    if (prepared.recovery) {
      // Копия оказалась испорченной (это бывает и с .bak) — перенесено то,
      // что читалось; таблицы, где чтение оборвалось, называем.
      info.salvaged = prepared.recovery.salvaged;
      info.unreadable = prepared.recovery.unreadable || [];
      info.error = prepared.recovery.error;
    }
  } catch (e) {
    info.error = e.message;
  } finally {
    prepared.db.close();
  }
  return info;
}

/**
 * Переносит новые бои из подготовленной копии в текущую базу вместе со
 * связанными строками: игроками, составом, вылетами, наградами, дуэлями.
 *
 * Номера игроков в копии и в базе разные — сводим по нику. Строку, которая
 * ссылается на игрока, не прочитавшегося из испорченной копии, пропускаем и
 * считаем (orphans).
 *
 * @param {Db} target - рабочая база
 * @param {string} workDir - папка, подготовленная prepare()
 * @returns {{imported: number, skipped: number, orphans: number}}
 */
function importInto(target, workDir) {
  const source = new Db(workDir);
  try {
    const ids = newBattleIds(source, target);
    const total = source.db.prepare('SELECT COUNT(*) n FROM battles').get().n;
    const result = { imported: 0, skipped: total - ids.length, orphans: 0 };
    if (!ids.length) return result;

    const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const common = (table) => {
      const theirs = new Set(cols(source.db, table));
      return cols(target.db, table).filter((c) => theirs.has(c));
    };

    // Бой: общие колонки, кроме своих отметок — их задаём сами.
    const OWN = new Set(['id', 'trust', 'origin', 'owner_id', 'hidden', 'server_key']);
    const battleCols = common('battles').filter((c) => !OWN.has(c));
    const readBattle = source.db.prepare(`SELECT ${battleCols.join(', ')} FROM battles WHERE id = ?`);
    const insBattle = target.db.prepare(
      `INSERT INTO battles (${battleCols.join(', ')}, trust, origin, owner_id, hidden, server_key)
       VALUES (${battleCols.map(() => '?').join(', ')}, 'guest', 'backup', NULL, 0, NULL)`
    );

    const readPlayer = source.db.prepare('SELECT nick, first_seen, last_seen FROM players WHERE id = ?');
    const upsertPlayer = target.db.prepare(
      `INSERT INTO players (nick, first_seen, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(nick) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen),
                                       last_seen  = MAX(last_seen, excluded.last_seen)`
    );
    const findPlayer = target.db.prepare('SELECT id FROM players WHERE nick = ?');
    const playerMap = new Map();
    /** Номер игрока в базе по номеру в копии; null — игрок не прочитался. */
    const mapPlayer = (oldId) => {
      if (playerMap.has(oldId)) return playerMap.get(oldId);
      const p = readPlayer.get(oldId);
      let id = null;
      if (p?.nick) {
        upsertPlayer.run(p.nick, p.first_seen ?? 0, p.last_seen ?? 0);
        id = findPlayer.get(p.nick).id;
      }
      playerMap.set(oldId, id);
      return id;
    };

    // Связанные таблицы: какие колонки ссылаются на игроков.
    const CHILDREN = [
      ['battle_players', ['player_id']],
      ['sorties', ['player_id']],
      ['awards', ['player_id']],
      ['duels', ['killer_id', 'victim_id']],
    ];
    const children = CHILDREN.map(([table, refs]) => {
      const list = common(table);
      if (!list.includes('battle_id')) return null;
      return {
        list,
        refs,
        read: source.db.prepare(`SELECT ${list.join(', ')} FROM ${table} WHERE battle_id = ?`),
        insert: target.db.prepare(
          `INSERT OR IGNORE INTO ${table} (${list.join(', ')}) VALUES (${list.map(() => '?').join(', ')})`
        ),
      };
    }).filter(Boolean);

    target.db.exec('BEGIN');
    try {
      for (const oldId of ids) {
        const b = readBattle.get(oldId);
        if (!b) continue;
        const newId = insBattle.run(...battleCols.map((c) => b[c])).lastInsertRowid;
        for (const child of children) {
          for (const row of child.read.all(oldId)) {
            const values = { ...row, battle_id: newId };
            let ok = true;
            for (const ref of child.refs) {
              const mapped = mapPlayer(row[ref]);
              if (mapped === null) ok = false;
              values[ref] = mapped;
            }
            if (!ok) {
              result.orphans += 1;
              continue;
            }
            child.insert.run(...child.list.map((c) => values[c]));
          }
        }
        result.imported += 1;
      }
      target.db.exec('COMMIT');
    } catch (e) {
      target.db.exec('ROLLBACK');
      throw e;
    }
    return result;
  } finally {
    source.close();
  }
}

/**
 * Сессия восстановления для окна: список копий с подготовленными временными
 * папками и перенос выбранных. Папки живут до close().
 */
class Restore {
  constructor(db, { workRoot = os.tmpdir() } = {}) {
    this.db = db;
    this.workRoot = workRoot;
    /** @type {Map<string, object>} путь копии → результат inspect */
    this.items = new Map();
  }

  /** Найти и осмотреть копии рядом с базой. Прежний осмотр выбрасывается. */
  list() {
    this.close();
    const dir = path.dirname(this.db.file);
    for (const entry of findBackups(dir)) {
      const info = inspect(entry, this.db, this.workRoot);
      // Пустая целая копия — это снимок только что созданной базы (миграция
      // схемы делает копию и при первом запуске): показывать нечего, а список
      // из десятка пустых строк прячет нужную. Испорченная или нечитаемая
      // показывается всегда — о ней человек должен узнать.
      if (!info.battles && entry.kind === 'backup' && !info.error) {
        if (info.workDir) discard(info.workDir);
        continue;
      }
      this.items.set(entry.file, info);
    }
    return [...this.items.values()].map(({ workDir, ...rest }) => rest);
  }

  /**
   * Перенести бои из выбранных копий. Перед переносом — копия текущей базы
   * (как перед любым массовым изменением истории).
   * @param {string[]} files - пути копий из list()
   */
  import(files) {
    const chosen = (Array.isArray(files) ? files : [])
      .map((f) => this.items.get(f))
      .filter((item) => item?.workDir);
    if (!chosen.length) return { backup: null, results: [] };
    const backup = this.db.backup();
    const results = [];
    // От старых к новым: если один бой лежит в нескольких копиях, возьмётся
    // самая ранняя его запись — та, что сделана ближе к самому бою.
    for (const item of chosen.sort((a, b) => a.madeAt - b.madeAt)) {
      try {
        results.push({ file: item.file, name: item.name, ...importInto(this.db, item.workDir) });
      } catch (e) {
        results.push({ file: item.file, name: item.name, imported: 0, error: e.message });
      }
    }
    return { backup, results };
  }

  /** Убрать временные папки. */
  close() {
    for (const item of this.items.values()) if (item.workDir) discard(item.workDir);
    this.items.clear();
  }
}

module.exports = { Restore, findBackups, classify, stampTime, prepare, inspect, importInto, newBattleIds };

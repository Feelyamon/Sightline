'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./migrations');

// SQLite встроен в Node внутри Electron — нативных модулей и пересборки под ABI
// не требуется, в собранный .exe база едет сама.

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS battles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,          -- unix ms, время начала записи боя
  ended_at    INTEGER NOT NULL,
  duration    INTEGER NOT NULL,          -- секунды по часам кил-фида
  my_kills    INTEGER NOT NULL DEFAULT 0,
  my_deaths   INTEGER NOT NULL DEFAULT 0,
  my_assists  INTEGER NOT NULL DEFAULT 0,
  my_vehicles TEXT    NOT NULL DEFAULT '[]',
  players_seen INTEGER NOT NULL DEFAULT 0,
  result      TEXT    NOT NULL DEFAULT 'unknown', -- win | loss | unknown
  -- Сдвиг местного времени от UTC в минутах на момент боя (Москва = 180).
  -- started_at всегда в UTC; сдвиг нужен, чтобы «в какие часы я играю»
  -- считалось по местному времени игрока и на сервере, где системного
  -- часового пояса игрока уже нет. NULL — у записей, сделанных до появления
  -- колонки: неизвестно, а не «ноль».
  tz_offset   INTEGER,
  -- Бой с заведомо неполными данными. В статистику не идёт вообще: ни в
  -- счётчики, ни в винрейт, ни в топы игроков. Показывается только в списке
  -- боёв, с пометкой и без КДА.
  cancelled     INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_battles_started ON battles(started_at);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nick       TEXT NOT NULL UNIQUE,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS battle_players (
  battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team      TEXT    NOT NULL,            -- ally | enemy | unknown
  kills     INTEGER NOT NULL DEFAULT 0,
  deaths    INTEGER NOT NULL DEFAULT 0,
  assists   INTEGER NOT NULL DEFAULT 0,
  vehicles  TEXT    NOT NULL DEFAULT '[]',
  left_battle INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (battle_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_bp_player ON battle_players(player_id);

-- Счётчики хранят не число боёв, а момент обнуления: сами числа считаются
-- запросом. Поэтому «сбросить» — это одна строка UPDATE, а удаление истории
-- обнуляет все счётчики автоматически.
-- reset_id — «водяной знак»: id последнего боя на момент сброса. Считать по
-- времени нельзя: бой, записанный в ту же миллисекунду, что и сброс, попадал
-- бы в счёт или нет случайно. reset_at остаётся только для показа «с такого-то».
CREATE TABLE IF NOT EXISTS counters (
  name     TEXT PRIMARY KEY,
  reset_at INTEGER NOT NULL,
  reset_id INTEGER NOT NULL DEFAULT 0
);
`;

// Счётчики боёв в шапке статистики. Новое имя достаточно дописать сюда:
// строка в таблице заводится при старте, а окно считает windowStart().
const COUNTERS = ['session', 'today', 'week', 'month', 'year'];

/** Экранирует спецсимволы LIKE, чтобы ник вроде «100%_pro» искался буквально. */
const escapeLike = (s) => String(s || '').replace(/[\\%_]/g, (c) => `\\${c}`);

// Потолок на список совпадений в поиске: у SQLite ограничено число параметров
// в запросе. Упереться в него можно только запросом из одной буквы по большой
// базе — а такой запрос и так возвращает «почти всё».
const MAX_MATCHES = 5000;

/** Начало суток/недели/месяца по локальному времени. */
function windowStart(name, now = Date.now()) {
  const d = new Date(now);
  switch (name) {
    case 'today':
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    case 'week': {
      d.setHours(0, 0, 0, 0);
      const shift = (d.getDay() + 6) % 7; // неделя с понедельника
      d.setDate(d.getDate() - shift);
      return d.getTime();
    }
    case 'month':
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      return d.getTime();
    // Календарный год, а не «последние 365 дней»: «в этом году» люди понимают
    // как «с января», и в январе такой период честно окажется коротким.
    case 'year':
      d.setHours(0, 0, 0, 0);
      d.setMonth(0, 1);
      return d.getTime();
    default:
      return 0; // session — только по ручному сбросу
  }
}

// Коды SQLite, означающие «файл испорчен», а не «занят» или «нет места».
// SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26.
const CORRUPT_CODES = new Set([11, 26]);

/** Испорчена ли база — по ошибке, которую бросил node:sqlite. */
function isCorruption(e) {
  if (CORRUPT_CODES.has(e?.errcode)) return true;
  return /malformed|not a database|file is encrypted/i.test(String(e?.message || ''));
}

// Таблицы в порядке, при котором ссылки не повисают: сначала то, на что
// ссылаются.
const SALVAGE_TABLES = [
  'players',
  'battles',
  'battle_players',
  'sorties',
  'duels',
  'awards',
  'player_notes',
  'counters',
  'app_meta',
];

class Db {
  constructor(userDataDir, { file = 'battles.db' } = {}) {
    this.file = path.join(userDataDir, file);
    fs.mkdirSync(userDataDir, { recursive: true });
    /**
     * Что случилось при открытии, если база оказалась испорчена:
     * { corruptFile, salvaged: {таблица: строк}, error }. null — всё в порядке.
     * Окно показывает это человеку: молча начать с пустой историей значило бы
     * получить жалобу «пропала вся статистика» без единой зацепки.
     */
    this.recovery = null;
    this.open();
  }

  /**
   * Открывает базу. Испорченную — НЕ удаляет и не перезаписывает: файл (вместе
   * с -wal и -shm) откладывается рядом под именем .corrupt-<время>, а в новую
   * базу переносится всё, что из старой ещё читается.
   *
   * Раньше испорченная база роняла программу на запуске, и единственным
   * «лечением», которое оставалось человеку, было удалить файл — вместе с тем,
   * что ещё можно было спасти.
   */
  open() {
    try {
      this.init();
      // Быстрая проверка целостности. Стоит миллисекунды на базе в несколько
      // мегабайт, а находит порчу до того, как её найдёт запрос посреди боя.
      const check = this.db.prepare('PRAGMA quick_check').get();
      const verdict = check && Object.values(check)[0];
      if (verdict !== 'ok') {
        throw Object.assign(new Error(`quick_check: ${verdict}`), { errcode: 11 });
      }
    } catch (e) {
      if (!isCorruption(e)) throw e;
      try {
        this.db?.close();
      } catch {
        // Закрыть испорченную базу удаётся не всегда — неважно, файл всё равно
        // откладывается ниже.
      }
      const corruptFile = this.setAside();
      this.init();
      const unreadable = [];
      const salvaged = this.salvage(corruptFile, unreadable);
      // unreadable — таблицы, чтение которых оборвалось на испорченной
      // странице (прочитанное до неё перенесено). Нужен восстановлению из
      // копий: человек должен знать, что взято не всё.
      this.recovery = { corruptFile, salvaged, unreadable, error: e.message };
      console.error(`база боёв испорчена (${e.message}), отложена в ${corruptFile}`);
    }
  }

  /** Открыть файл, создать схему, довести миграциями. */
  init() {
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);

    // Вылеты и дуэли появились позже — без них не построить статистику по
    // своей технике и досье на противника.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sorties (
        battle_id  INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        vehicle    TEXT    NOT NULL,
        kills      INTEGER NOT NULL DEFAULT 0,
        destroyed  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (battle_id, player_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_sorties_vehicle ON sorties(vehicle);
      -- Фильтр «мои бои на этой машине» ходит по паре игрок+техника.
      CREATE INDEX IF NOT EXISTS idx_sorties_player_vehicle ON sorties(player_id, vehicle);

      CREATE TABLE IF NOT EXISTS duels (
        battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        killer_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        victim_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        count     INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (battle_id, killer_id, victim_id)
      );
      CREATE INDEX IF NOT EXISTS idx_duels_victim ON duels(victim_id);

      -- Награды за бой: игра пишет их в кил-фид, поэтому они собираются
      -- по каждому игроку и сохраняются вместе с боем.
      -- tier — степень награды, отделённая от названия («Снайпер II» →
      -- «Снайпер», 2). 0 означает «награда без степеней».
      CREATE TABLE IF NOT EXISTS awards (
        battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        name      TEXT    NOT NULL,
        count     INTEGER NOT NULL DEFAULT 1,
        tier      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (battle_id, player_id, name)
      );

      -- Ручные пометки на игрока: всплывают при следующей встрече.
      CREATE TABLE IF NOT EXISTS player_notes (
        player_id  INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        note       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Схема доводится до актуальной версии до первого запроса к данным.
    // Бэкап делается только если есть что применять — см. migrations.js.
    this.migration = migrate(this.db, { backup: () => this.backup() });

    const now = Date.now();
    const ins = this.db.prepare(
      'INSERT INTO counters(name, reset_at, reset_id) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING'
    );
    for (const name of COUNTERS) ins.run(name, now);
  }

  /**
   * Откладывает испорченную базу в сторону, ничего не удаляя.
   * @returns {string} путь, под которым она теперь лежит
   */
  setAside() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${this.file}.corrupt-${stamp}`;
    // -wal и -shm переезжают вместе с файлом и под тем же именем: без журнала
    // главный файл — это база на момент последней контрольной точки, а всё
    // свежее лежит как раз в журнале.
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(this.file + suffix)) fs.renameSync(this.file + suffix, target + suffix);
    }
    return target;
  }

  /**
   * Переносит из отложенной базы всё, что читается. По строке: испорченная
   * страница обрывает чтение таблицы, но прочитанное до неё остаётся.
   * Колонки берутся общие для старой и новой схемы — отложенная база могла
   * быть от старой версии программы.
   * @param {string[]} [unreadable] - сюда дописываются таблицы, чтение
   *   которых оборвалось
   * @returns {Object<string, number>} сколько строк перенесено, по таблицам
   */
  salvage(corruptFile, unreadable = []) {
    const result = {};
    let old;
    try {
      old = new DatabaseSync(corruptFile, { readOnly: true });
    } catch {
      unreadable.push('*');
      return result;
    }
    // Ссылки здесь не проверяем: строка участника может прочитаться, а игрок,
    // на которого она ссылается, — оказаться на испорченной странице. Лучше
    // сохранить такую строку, чем потерять её из-за соседней.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (const table of SALVAGE_TABLES) {
        let moved = 0;
        try {
          const mine = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          const theirs = new Set(
            old.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
          );
          const cols = mine.filter((c) => theirs.has(c));
          if (!cols.length) continue;
          const list = cols.join(', ');
          const insert = this.db.prepare(
            `INSERT OR REPLACE INTO ${table} (${list}) VALUES (${cols.map(() => '?').join(', ')})`
          );
          for (const row of old.prepare(`SELECT ${list} FROM ${table}`).iterate()) {
            insert.run(...cols.map((c) => row[c]));
            moved += 1;
          }
        } catch {
          // Таблица оборвалась на испорченной странице — берём, что успели.
          unreadable.push(table);
        } finally {
          result[table] = moved;
        }
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
      try {
        old.close();
      } catch {
        // Отложенный файл остаётся на диске как есть.
      }
    }
    return result;
  }

  lastBattleId() {
    return this.db.prepare('SELECT COALESCE(MAX(id), 0) id FROM battles').get().id;
  }

  /**
   * id игрока по нику из настроек. В базе ник лежит с клан-тегом
   * («[CLAN] Username»), а пользователь вводит его без тега — поэтому ищем
   * и точное совпадение, и хвост строки.
   * @returns {number|null}
   */
  selfId(nick) {
    const self = String(nick || '').trim();
    if (!self) return null;
    const row = this.db
      .prepare("SELECT id FROM players WHERE nick = ? OR nick LIKE ? ESCAPE '\\' LIMIT 1")
      .get(self, `% ${escapeLike(self)}`);
    return row?.id ?? null;
  }

  /**
   * Обнуляет счётчик «с запуска». Вызывается приложением явно: делать это в
   * конструкторе нельзя — тогда любое открытие файла (скриптом, утилитой)
   * сбрасывало бы счётчик пользователя.
   */
  startSession() {
    this.resetCounter('session');
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Закрываемся при выходе — падать тут незачем.
    }
  }

  /**
   * Пишет завершённый бой. Возвращает id или null, если писать нечего.
   * @param {object} snapshot - снапшот BattleState
   */
  saveBattle(
    snapshot,
    { startedAt, endedAt, result = 'unknown', cancelReason = null, guest = false } = {}
  ) {
    const players = snapshot.players || [];
    if (!players.length) return null;

    const now = Date.now();
    const start = startedAt || now;
    const end = endedAt || now;
    const me = players.find((p) => p.isSelf);

    const tx = () => {
      const battleId = this.db
        .prepare(
          `INSERT INTO battles (started_at, ended_at, duration, my_kills, my_deaths, my_assists, my_vehicles, players_seen, result, tz_offset, cancelled, cancel_reason, trust)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          start,
          end,
          snapshot.clock || 0,
          me ? me.kills : 0,
          me ? me.deaths : 0,
          me ? me.assists || 0 : 0,
          JSON.stringify(me ? me.vehicles : []),
          players.length,
          result,
          // getTimezoneOffset() возвращает «сколько минут прибавить к местному,
          // чтобы получить UTC» — знак обратный привычному. Москва даёт -180,
          // а человек ожидает +180, поэтому переворачиваем здесь, один раз.
          -new Date(start).getTimezoneOffset(),
          cancelReason ? 1 : 0,
          cancelReason,
          // 'guest' — бой записан без входа и навсегда остаётся только здесь:
          // на сервер он не отправляется (см. sync.js), и ключ сервера к нему
          // не приклеится (см. setBattleKey). 'local' — обычный бой, ещё не
          // отправленный.
          guest ? 'guest' : 'local'
        ).lastInsertRowid;

      const upsertPlayer = this.db.prepare(
        `INSERT INTO players (nick, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(nick) DO UPDATE SET last_seen = excluded.last_seen`
      );
      const findPlayer = this.db.prepare('SELECT id FROM players WHERE nick = ?');
      const insBp = this.db.prepare(
        `INSERT INTO battle_players (battle_id, player_id, team, kills, deaths, assists, vehicles, left_battle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const insSortie = this.db.prepare(
        `INSERT INTO sorties (battle_id, player_id, seq, vehicle, kills, destroyed)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insDuel = this.db.prepare(
        `INSERT INTO duels (battle_id, killer_id, victim_id, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(battle_id, killer_id, victim_id) DO UPDATE SET count = count + excluded.count`
      );
      const insAward = this.db.prepare(
        `INSERT INTO awards (battle_id, player_id, name, count, tier) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(battle_id, player_id, name) DO UPDATE SET
           count = excluded.count,
           tier  = MAX(tier, excluded.tier)`
      );
      const ids = new Map();

      for (const p of players) {
        upsertPlayer.run(p.nick, start, end);
        const { id } = findPlayer.get(p.nick);
        ids.set(p.nick, id);

        // Вылеты — основа статистики «моя техника» и «что выкатывают против».
        (p.sorties || []).forEach((s, seq) => {
          if (!s.vehicle) return;
          insSortie.run(battleId, id, seq, s.vehicle, s.kills || 0, s.destroyed ? 1 : 0);
        });

        for (const a of p.awards || []) {
          insAward.run(battleId, id, a.name, a.count || 1, a.tier || 0);
        }

        insBp.run(
          battleId,
          id,
          p.team,
          p.kills,
          p.deaths,
          p.assists || 0,
          JSON.stringify(p.vehicles || []),
          p.status === 'left' ? 1 : 0
        );
      }

      // Личные счёты: без них не показать «против тебя 8/3».
      for (const d of snapshot.duels || []) {
        const killerId = ids.get(d.killer);
        const victimId = ids.get(d.victim);
        if (killerId && victimId) insDuel.run(battleId, killerId, victimId, d.count);
      }

      return battleId;
    };

    this.db.exec('BEGIN');
    try {
      const id = tx();
      this.db.exec('COMMIT');
      return id;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Перезаписывает уже сохранённый бой. Нужен, чтобы один бой оставался одной
   * записью: раньше повторные сохранения вставляли его заново, и статистика
   * росла в разы.
   */
  updateBattle(id, snapshot, opts = {}) {
    // Запись могли удалить из-под нас (очистка истории, удаление боя вручную) —
    // тогда просто пишем бой заново.
    const exists = this.db.prepare('SELECT 1 FROM battles WHERE id = ?').get(id);
    if (!exists) return this.saveBattle(snapshot, opts);

    this.db.exec('BEGIN');
    try {
      // Дочерние строки проще пересобрать, чем сверять по одной.
      this.db.prepare('DELETE FROM battle_players WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM sorties WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM duels WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM awards WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM battles WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.saveBattle(snapshot, opts);
  }

  /** Счётчики: сколько боёв попало в окно с момента последнего сброса. */
  counters() {
    const rows = this.db.prepare('SELECT name, reset_at, reset_id FROM counters').all();
    const resets = Object.fromEntries(rows.map((r) => [r.name, r]));
    // Водяной знак по номеру годится только для боёв, записанных здесь: их
    // номера растут вместе со временем. Бой, пришедший с сервера или из
    // копии, получает свежий номер, хотя сыгран давно, — по номеру он попал бы
    // в «с запуска» и пережил бы любой сброс. Для них граница — время сброса.
    const count = this.db.prepare(
      `SELECT COUNT(*) n FROM battles
        WHERE started_at >= ? AND cancelled = 0 AND hidden = 0
          AND CASE WHEN origin = 'recorded' THEN id > ? ELSE started_at >= ? END`
    );

    const out = {};
    for (const name of COUNTERS) {
      const r = resets[name] || { reset_at: 0, reset_id: 0 };
      // Две независимые границы: номер боя на момент ручного сброса и начало
      // календарного окна (для today/week/month).
      const from = Math.max(r.reset_at || 0, windowStart(name));
      // «С запуска» — всегда от времени запуска. Остальные — от времени
      // ручного сброса, если он был (reset_id > 0): reset_at у них проставлен
      // и при заведении строки, и считать от него значило бы потерять
      // пришедшие бои, сыгранные до первого запуска на этой машине.
      const foreignFrom = name === 'session' || r.reset_id > 0 ? r.reset_at || 0 : 0;
      out[name] = {
        battles: count.get(windowStart(name), r.reset_id || 0, foreignFrom).n,
        from,
      };
    }
    return out;
  }

  resetCounter(name) {
    if (!COUNTERS.includes(name)) throw new Error(`Неизвестный счётчик: ${name}`);
    this.db
      .prepare('UPDATE counters SET reset_at = ?, reset_id = ? WHERE name = ?')
      .run(Date.now(), this.lastBattleId(), name);
  }

  /**
   * Условие отбора боёв — общее для выдачи строк и для итогов по ним.
   * Собирается динамически, но значения всегда идут плейсхолдерами: склеивать
   * пользовательский ввод в SQL нельзя даже в локальной базе.
   * @returns {{sql: string, params: Array}}
   */
  battleFilter({ query = '', from = 0, to = 0, result = '', myVehicle = '', selfNick = '' } = {}) {
    // Бои другого аккаунта, пришедшие с сервера, на время чужого входа
    // спрятаны (см. setViewer) — ни в списке, ни в итогах их нет.
    const where = ['b.hidden = 0'];
    const params = [];

    if (from) {
      where.push('b.started_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('b.started_at <= ?');
      params.push(to);
    }
    if (result) {
      where.push('b.result = ?');
      params.push(result);
    }

    // Одна строка поиска на ник и на технику: человек ищет «кого-то или
    // что-то», а не выбирает заранее, по какому полю искать.
    //
    // Совпадение ищем в JS, а не через LIKE. LIKE в SQLite приводит регистр
    // только для латиницы, а у нас кириллические ники и названия техники из
    // русского клиента: «т-80» не нашло бы «Т-80БВМ». Сканируем справочники
    // (игроки и список машин — тысячи строк, не сотни тысяч), а по боям идём
    // уже готовым списком id.
    const q = String(query || '').trim();
    if (q) {
      // toLowerCase, а не toLocaleLowerCase: последний зависит от языка
      // системы. В турецкой локали «I» превращается в «ı» без точки, и
      // турецкий игрок, ищущий «isu», не нашёл бы «ISU» в своей же базе.
      // Здесь нужна предсказуемость, а не языковая правильность.
      const needle = q.toLowerCase();
      const matches = (s) => String(s || '').toLowerCase().includes(needle);

      const playerIds = this.db
        .prepare('SELECT id, nick FROM players')
        .all()
        .filter((p) => matches(p.nick))
        .map((p) => p.id)
        .slice(0, MAX_MATCHES);
      const vehicles = this.db
        .prepare('SELECT DISTINCT vehicle FROM sorties')
        .all()
        .map((r) => r.vehicle)
        .filter(matches)
        .slice(0, MAX_MATCHES);

      const parts = [];
      if (playerIds.length) {
        parts.push(
          `EXISTS (SELECT 1 FROM battle_players bp WHERE bp.battle_id = b.id
                   AND bp.player_id IN (${playerIds.map(() => '?').join(',')}))`
        );
        params.push(...playerIds);
      }
      if (vehicles.length) {
        parts.push(
          `EXISTS (SELECT 1 FROM sorties s WHERE s.battle_id = b.id
                   AND s.vehicle IN (${vehicles.map(() => '?').join(',')}))`
        );
        params.push(...vehicles);
      }
      // Ни одного совпадения в справочниках — искать в боях нечего.
      where.push(parts.length ? `(${parts.join(' OR ')})` : '0 = 1');
    }

    if (myVehicle) {
      const me = this.selfId(selfNick);
      if (me === null) {
        // Ник не задан или ещё не встречался — «моих боёв» на этой машине нет.
        where.push('0 = 1');
      } else {
        where.push(
          `EXISTS (SELECT 1 FROM sorties s
                   WHERE s.battle_id = b.id AND s.player_id = ? AND s.vehicle = ?)`
        );
        params.push(me, myVehicle);
      }
    }

    return { sql: where.join(' AND '), params };
  }

  /**
   * Бои с фильтрами и постраничной выдачей. Итоги (винрейт, КДА) считаются по
   * той же выборке, что и строки: иначе фильтр показывал бы одно, а сводка над
   * ним — статистику по всей базе.
   * @returns {{rows: Array, total: number, summary: object}}
   */
  searchBattles(opts = {}) {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 5000));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const { sql, params } = this.battleFilter(opts);

    const rows = this.db
      .prepare(
        `SELECT id, started_at, duration, my_kills, my_deaths, my_assists, my_vehicles,
                players_seen, result, cancelled, cancel_reason, trust, origin
         FROM battles b
         WHERE ${sql}
         ORDER BY started_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map((b) => ({ ...b, my_vehicles: JSON.parse(b.my_vehicles || '[]') }));

    // total считается по всей выдаче — от него зависит постраничная загрузка.
    // А суммы и винрейт — только по незачёркнутым боям: отменённый бой в
    // списке видно, но в цифры он не входит.
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN b.cancelled = 1 THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN b.cancelled = 0 AND b.result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN b.cancelled = 0 AND b.result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(CASE WHEN b.cancelled = 0 THEN b.my_kills   ELSE 0 END), 0) AS kills,
                COALESCE(SUM(CASE WHEN b.cancelled = 0 THEN b.my_deaths  ELSE 0 END), 0) AS deaths,
                COALESCE(SUM(CASE WHEN b.cancelled = 0 THEN b.my_assists ELSE 0 END), 0) AS assists
         FROM battles b WHERE ${sql}`
      )
      .get(...params);

    const total = agg.total || 0;
    const cancelled = agg.cancelled || 0;
    const counted = total - cancelled;
    const wins = agg.wins || 0;
    const losses = agg.losses || 0;
    const decided = wins + losses;

    return {
      rows,
      total,
      summary: {
        battles: counted,
        cancelled,
        wins,
        losses,
        unknown: counted - decided,
        percent: decided ? Math.round((wins / decided) * 100) : null,
        kills: agg.kills,
        deaths: agg.deaths,
        assists: agg.assists,
        // Тот же расчёт, что в плашке КДА: без смертей делить не на что.
        kda: agg.deaths > 0 ? (agg.kills + agg.assists) / agg.deaths : agg.kills + agg.assists,
      },
    };
  }

  /**
   * Свои спорные бои — те, по которым чужая запись разошлась с нашей.
   *
   * Нужны для жалобы «ложное обвинение»: без списка человеку пришлось бы
   * описывать словами, какой именно бой он оспаривает, а по словам разобрать
   * расхождение невозможно.
   *
   * Только СВОИ и только спорные. Чужие сюда не попадают в принципе: поле
   * жалобы, куда можно приложить чужой бой, превратилось бы в способ
   * жаловаться на чужие профили.
   */
  disputedBattles(limit = 50) {
    return this.db
      .prepare(
        `SELECT id, started_at, duration, my_kills, my_deaths, my_assists,
                my_vehicles, result, server_key
           FROM battles
          WHERE trust = 'disputed' AND cancelled = 0 AND hidden = 0
          ORDER BY started_at DESC
          LIMIT ?`
      )
      .all(Math.max(1, Math.min(Number(limit) || 50, 200)))
      .map((b) => ({ ...b, my_vehicles: JSON.parse(b.my_vehicles || '[]') }));
  }

  /** Последние бои без фильтров. */
  recentBattles(limit = 50) {
    return this.searchBattles({ limit }).rows;
  }

  /** Состав одного боя — для раскрывающейся строки во вкладке «Бои». */
  battleDetails(id) {
    const battle = this.db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
    if (!battle) return null;
    const players = this.db
      .prepare(
        `SELECT p.nick, bp.team, bp.kills, bp.deaths, bp.assists, bp.vehicles, bp.left_battle
         FROM battle_players bp JOIN players p ON p.id = bp.player_id
         WHERE bp.battle_id = ?
         ORDER BY bp.kills DESC, bp.deaths ASC`
      )
      .all(id)
      .map((r) => ({ ...r, vehicles: JSON.parse(r.vehicles || '[]') }));

    // Награды подкладываем к своим игрокам, чтобы их было видно в составе боя.
    const awards = this.db
      .prepare(
        `SELECT p.nick, a.name, a.count, a.tier FROM awards a
         JOIN players p ON p.id = a.player_id WHERE a.battle_id = ?`
      )
      .all(id);
    for (const p of players) {
      p.awards = awards
        .filter((a) => a.nick === p.nick)
        .map((a) => ({ name: a.name, count: a.count, tier: a.tier }));
    }

    return {
      ...battle,
      my_vehicles: JSON.parse(battle.my_vehicles || '[]'),
      players,
    };
  }

  deleteBattle(id) {
    this.db.prepare('DELETE FROM battles WHERE id = ?').run(id);
  }

  /**
   * Запоминает ключ, под которым бой лежит на сервере.
   *
   * Ключ считает сервер (хэш от состава), и без него нельзя спросить, чем
   * кончилась сверка: локальный номер боя на сервере ничего не значит — там
   * тот же бой есть и у других игроков, под их номерами.
   */
  setBattleKey(id, key) {
    this.db
      // Гостевой бой ключа не получает никогда, даже если его как-то прислали:
      // отметка «записан без входа» не должна смениться на «ждёт сверки».
      .prepare(
        "UPDATE battles SET server_key = ?, trust = CASE WHEN trust = 'local' THEN 'pending' ELSE trust END WHERE id = ? AND trust <> 'guest' AND origin = 'recorded'"
      )
      .run(key, id);
  }

  /** Ключи боёв, про которые ещё имеет смысл спрашивать сверку. */
  battleKeysToRefresh(limit = 200) {
    return this.db
      .prepare(
        // Подтверждённый бой переспрашивать незачем: подтверждение не
        // отзывается. А вот спорный и ожидающий — да: свидетель может
        // прислать свою запись через час после боя.
        `SELECT server_key FROM battles
          WHERE server_key IS NOT NULL AND trust IN ('pending', 'alone', 'disputed')
            AND hidden = 0
          ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit)
      .map((r) => r.server_key);
  }

  /** @param {Array<{battle_key: string, trust: string}>} rows */
  applyTrust(rows) {
    // Ключ боя одинаков у всех его участников: если на этой машине лежит и
    // бой другого аккаунта с тем же ключом (спрятанный), его отметку ответ
    // про наш бой трогать не должен. Гостевая отметка не меняется никогда.
    const update = this.db.prepare(
      "UPDATE battles SET trust = ? WHERE server_key = ? AND hidden = 0 AND trust <> 'guest'"
    );
    let changed = 0;
    for (const r of rows) {
      if (!r?.battle_key || !r?.trust) continue;
      changed += update.run(r.trust, r.battle_key).changes;
    }
    return changed;
  }

  // --- Чья история на экране -----------------------------------------------
  //
  // Бои, пришедшие с сервера, помечены номером аккаунта (owner_id). Если на
  // этой машине входили под разными аккаунтами, в базе лежат истории обоих —
  // и показывать их вперемешку нельзя: чужие бои попали бы в свой винрейт.
  //
  // Правило: на экране история ОДНОГО аккаунта — того, кто вошёл, а после
  // выхода — того, кто входил последним (выход ничего не прячет: это всё ещё
  // его история на его компьютере). Бои другого аккаунта не удаляются, а
  // прячутся (hidden = 1) и возвращаются, когда войдёт он сам. Бои без
  // хозяина — записанные здесь, гостевые, восстановленные из копий — видны
  // всегда: это история этого компьютера, как и до 1.0.4.

  meta(key) {
    return this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, String(value));
  }

  /** Чья история сейчас на экране: номер аккаунта или null — «ничья». */
  viewer() {
    const raw = this.meta('viewer');
    return raw === null || raw === '' ? null : Number(raw);
  }

  /**
   * Показывать историю этого аккаунта. null — вошёл человек, чей номер ещё
   * неизвестен (первый вход на этой машине): тогда прячутся бои ВСЕХ
   * аккаунтов, пока ответ сервера не назовёт номер.
   * @returns {number} сколько записей сменили видимость
   */
  setViewer(ownerId) {
    const id = Number.isInteger(ownerId) ? ownerId : null;
    this.setMeta('viewer', id === null ? '' : id);
    return this.db
      .prepare(
        `UPDATE battles
            SET hidden = CASE WHEN owner_id IS NOT NULL AND (?1 IS NULL OR owner_id <> ?1) THEN 1 ELSE 0 END
          WHERE hidden <> CASE WHEN owner_id IS NOT NULL AND (?1 IS NULL OR owner_id <> ?1) THEN 1 ELSE 0 END`
      )
      .run(id).changes;
  }

  /** Запомнить номер аккаунта по логину — чтобы при следующем входе сразу. */
  rememberLogin(login, ownerId) {
    const key = String(login || '').trim().toLowerCase();
    if (!key || !Number.isInteger(ownerId)) return;
    this.setMeta(`login:${key}`, ownerId);
  }

  /** Номер аккаунта по логину, если он уже приходил с сервера. */
  ownerForLogin(login) {
    const key = String(login || '').trim().toLowerCase();
    if (!key) return null;
    const raw = this.meta(`login:${key}`);
    return raw === null ? null : Number(raw);
  }

  /**
   * Можно ли отправить этот бой на сервер. Только записанный здесь и не
   * гостевой: пришедший с сервера там уже лежит, а восстановленный из копии
   * записан неизвестно под каким входом. Проверка — в базе, по самой записи,
   * а не по тому, откуда позвали: обойти её другим путём нельзя.
   */
  uploadAllowed(id) {
    const row = this.db.prepare('SELECT origin, trust FROM battles WHERE id = ?').get(id);
    return !!row && row.origin === 'recorded' && row.trust !== 'guest';
  }

  // --- История с сервера ----------------------------------------------------

  /**
   * Есть ли уже этот бой здесь — для этого аккаунта или без хозяина.
   * Совпадение по ключу сервера ИЛИ по времени начала: время начала сервер
   * получил от программы как есть, до миллисекунды, и по нему находится бой,
   * который ушёл на сервер, но ключ которого не успел вернуться (ответ
   * потерялся). Два разных боя одного человека в одну миллисекунду не
   * начинаются.
   * @returns {{id: number, server_key: string|null, trust: string}|null}
   */
  findServerBattle(key, startedAt, ownerId) {
    return (
      this.db
        .prepare(
          `SELECT id, server_key, trust FROM battles
            WHERE (owner_id IS NULL OR owner_id = ?)
              AND ((? IS NOT NULL AND server_key = ?) OR started_at = ?)
            ORDER BY (server_key = ?) DESC
            LIMIT 1`
        )
        .get(ownerId ?? null, key ?? null, key ?? null, startedAt, key ?? null) || null
    );
  }

  /**
   * Вписывает страницу боёв с сервера (GET /v1/battles/mine). Уже известные
   * пропускаются; новые пишутся с origin='server', хозяином ownerId и
   * отметкой доверия сервера. На сервер такие бои не уходят никогда — см.
   * uploadAllowed и sync.js.
   *
   * @param {Array<object>} battles - как отдаёт сервер
   * @param {number} ownerId - номер аккаунта из того же ответа
   * @returns {{inserted: number, known: number, invalid: number}}
   */
  mergeServerBattles(battles, ownerId) {
    const out = { inserted: 0, known: 0, invalid: 0 };
    if (!Array.isArray(battles) || !battles.length) return out;
    if (!Number.isInteger(ownerId)) throw new Error('у истории с сервера нет номера аккаунта');
    const viewer = this.viewer();
    const hidden = viewer === ownerId ? 0 : 1;

    const insBattle = this.db.prepare(
      `INSERT INTO battles (started_at, ended_at, duration, my_kills, my_deaths, my_assists,
                            my_vehicles, players_seen, result, tz_offset, cancelled, cancel_reason,
                            trust, server_key, origin, owner_id, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', ?, ?)`
    );
    // Порядок боёв с сервера произвольный, поэтому «впервые видели» и
    // «последний раз» — по минимуму и максимуму, а не «последний записанный».
    const upsertPlayer = this.db.prepare(
      `INSERT INTO players (nick, first_seen, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(nick) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen),
                                       last_seen  = MAX(last_seen, excluded.last_seen)`
    );
    const findPlayer = this.db.prepare('SELECT id FROM players WHERE nick = ?');
    const insBp = this.db.prepare(
      `INSERT OR IGNORE INTO battle_players (battle_id, player_id, team, kills, deaths, assists, vehicles, left_battle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSortie = this.db.prepare(
      `INSERT OR IGNORE INTO sorties (battle_id, player_id, seq, vehicle, kills, destroyed)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const heal = this.db.prepare(
      `UPDATE battles SET server_key = ?, trust = ?
        WHERE id = ? AND server_key IS NULL AND origin = 'recorded' AND trust = 'local'`
    );

    const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
    const RESULTS = new Set(['win', 'loss']);
    const TRUSTS = new Set(['pending', 'alone', 'confirmed', 'disputed']);
    const TEAMS = new Set(['ally', 'enemy']);

    this.db.exec('BEGIN');
    try {
      for (const b of battles) {
        const key = typeof b?.battle_key === 'string' && b.battle_key ? b.battle_key : null;
        const start = Date.parse(b?.started_at);
        const end = Date.parse(b?.ended_at);
        if (!key || !Number.isFinite(start) || !Number.isFinite(end)) {
          out.invalid += 1;
          continue;
        }
        const trust = TRUSTS.has(b.trust) ? b.trust : 'pending';

        const existing = this.findServerBattle(key, start, ownerId);
        if (existing) {
          // Бой ушёл на сервер, а ключ не вернулся (ответ потерялся по
          // дороге): теперь ключ известен — приклеиваем, и сверка заработает.
          if (!existing.server_key) heal.run(key, trust, existing.id);
          out.known += 1;
          continue;
        }

        const players = Array.isArray(b.players) ? b.players : [];
        const battleId = insBattle.run(
          start,
          end,
          int(b.duration_sec ?? Math.round((end - start) / 1000)),
          int(b.my_kills),
          int(b.my_deaths),
          int(b.my_assists),
          JSON.stringify(Array.isArray(b.my_vehicles) ? b.my_vehicles.map(String) : []),
          int(b.players_seen ?? players.length),
          RESULTS.has(b.result) ? b.result : 'unknown',
          Number.isFinite(b.tz_offset) ? Math.trunc(b.tz_offset) : null,
          b.cancelled ? 1 : 0,
          b.cancelled ? (b.cancel_reason ?? null) : null,
          trust,
          key,
          ownerId,
          hidden
        ).lastInsertRowid;

        for (const p of players) {
          const nick = typeof p?.nick === 'string' ? p.nick.trim() : '';
          if (!nick) continue;
          upsertPlayer.run(nick, start, end);
          const { id } = findPlayer.get(nick);
          const sorties = (Array.isArray(p.sorties) ? p.sorties : []).filter(
            (s) => typeof s?.vehicle === 'string' && s.vehicle
          );
          insBp.run(
            battleId,
            id,
            TEAMS.has(p.team) ? p.team : 'unknown',
            int(p.kills),
            int(p.deaths),
            int(p.assists),
            JSON.stringify([...new Set(sorties.map((s) => s.vehicle))]),
            p.left_battle ? 1 : 0
          );
          sorties.forEach((s, i) => {
            insSortie.run(battleId, id, Number.isInteger(s.seq) ? s.seq : i, s.vehicle, int(s.kills), s.destroyed ? 1 : 0);
          });
        }
        out.inserted += 1;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  /**
   * Топ игроков. side='ally' — с кем чаще играю, 'enemy' — против кого.
   * since — граница окна (например, месяц), minBattles — порог показа.
   */
  topPlayers({ side = 'enemy', since = 0, minBattles = 1, limit = 50, excludeNick = '' } = {}) {
    // Себя в топах показывать незачем — в своей же команде игрок встречается
    // в каждом бою. В кил-фиде ник идёт с клан-тегом, поэтому отсекаем и
    // точное совпадение, и вариант «<тег> <ник>».
    const self = String(excludeNick || '').trim();
    const escaped = escapeLike(self);
    return this.db
      .prepare(
        `SELECT p.nick,
                COUNT(*) AS battles,
                SUM(bp.kills)   AS kills,
                SUM(bp.deaths)  AS deaths,
                SUM(bp.assists) AS assists,
                MAX(b.started_at) AS last_seen
         FROM battle_players bp
         JOIN players p ON p.id = bp.player_id
         JOIN battles b ON b.id = bp.battle_id
         WHERE bp.team = ? AND b.started_at >= ? AND b.cancelled = 0 AND b.hidden = 0
           AND (? = '' OR (p.nick <> ? AND p.nick NOT LIKE ? ESCAPE '\\'))
         GROUP BY p.id
         HAVING battles >= ?
         ORDER BY battles DESC, last_seen DESC
         LIMIT ?`
      )
      .all(side, since, self, self, `% ${escaped}`, minBattles, limit);
  }

  /** Вся история встреч с конкретным игроком. */
  playerCard(nick) {
    const player = this.db.prepare('SELECT * FROM players WHERE nick = ?').get(nick);
    if (!player) return null;
    const rows = this.db
      .prepare(
        `SELECT b.id, b.started_at, bp.team, bp.kills, bp.deaths, bp.assists, bp.vehicles
         FROM battle_players bp JOIN battles b ON b.id = bp.battle_id
         WHERE bp.player_id = ? AND b.cancelled = 0 AND b.hidden = 0
         ORDER BY b.started_at DESC LIMIT 200`
      )
      .all(player.id)
      .map((r) => ({ ...r, vehicles: JSON.parse(r.vehicles || '[]') }));
    return { ...player, encounters: rows };
  }

  /**
   * Досье на игроков для показа прямо в бою: сколько раз встречались, какая
   * техника у него обычно, личный счёт против меня и ручная пометка.
   * Берём пачкой на весь бой — по запросу на игрока было бы расточительно.
   */
  dossier(nicks, selfNick = '') {
    const list = (nicks || []).filter(Boolean);
    if (!list.length) return {};

    const holes = list.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT p.id, p.nick, COUNT(*) AS battles, MAX(b.started_at) AS last_seen
         FROM battle_players bp
         JOIN players p ON p.id = bp.player_id
         JOIN battles b ON b.id = bp.battle_id
         WHERE p.nick IN (${holes}) AND b.cancelled = 0 AND b.hidden = 0
         GROUP BY p.id`
      )
      .all(...list);
    if (!rows.length) return {};

    const byId = new Map(rows.map((r) => [r.id, r]));
    const idHoles = [...byId.keys()].map(() => '?').join(',');
    const idList = [...byId.keys()];

    // Любимая техника — та, на которой игрока видели в наибольшем числе вылетов.
    const favourites = this.db
      .prepare(
        `SELECT s.player_id, s.vehicle, COUNT(*) AS n, SUM(s.kills) AS kills
         FROM sorties s JOIN battles b ON b.id = s.battle_id
         WHERE s.player_id IN (${idHoles}) AND b.hidden = 0
         GROUP BY s.player_id, s.vehicle ORDER BY n DESC`
      )
      .all(...idList);

    const me = this.selfId(selfNick);

    let duelRows = [];
    if (me !== null) {
      duelRows = this.db
        .prepare(
          `SELECT d.killer_id, d.victim_id, SUM(d.count) AS n
             FROM duels d JOIN battles b ON b.id = d.battle_id
            WHERE b.hidden = 0
              AND ((d.killer_id = ? AND d.victim_id IN (${idHoles}))
                OR (d.victim_id = ? AND d.killer_id IN (${idHoles})))
            GROUP BY d.killer_id, d.victim_id`
        )
        .all(me, ...idList, me, ...idList);
    }

    const notes = this.db
      .prepare(`SELECT player_id, note FROM player_notes WHERE player_id IN (${idHoles})`)
      .all(...idList);

    const out = {};
    for (const r of rows) {
      const fav = favourites.filter((f) => f.player_id === r.id).slice(0, 3);
      const killedMe = duelRows
        .filter((d) => d.killer_id === r.id && d.victim_id === me)
        .reduce((s, d) => s + d.n, 0);
      const killedByMe = duelRows
        .filter((d) => d.victim_id === r.id && d.killer_id === me)
        .reduce((s, d) => s + d.n, 0);
      out[r.nick] = {
        battles: r.battles,
        lastSeen: r.last_seen,
        favourite: fav.map((f) => ({ vehicle: f.vehicle, sorties: f.n, kills: f.kills })),
        killedMe,
        killedByMe,
        note: notes.find((n) => n.player_id === r.id)?.note || '',
      };
    }
    return out;
  }

  /** Статистика по своей технике: вылеты, фраги, потери, винрейт. */
  myVehicles(selfNick = '', { since = 0 } = {}) {
    const me = this.selfId(selfNick);
    if (me === null) return [];

    return this.db
      .prepare(
        `SELECT s.vehicle,
                COUNT(*)             AS sorties,
                SUM(s.kills)         AS kills,
                SUM(s.destroyed)     AS losses,
                COUNT(DISTINCT s.battle_id) AS battles,
                SUM(CASE WHEN b.result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN b.result = 'loss' THEN 1 ELSE 0 END) AS losses_battles,
                MAX(b.started_at)    AS last_used
         FROM sorties s JOIN battles b ON b.id = s.battle_id
         WHERE s.player_id = ? AND b.started_at >= ? AND b.cancelled = 0 AND b.hidden = 0
         GROUP BY s.vehicle
         ORDER BY sorties DESC`
      )
      .all(me, since);
  }

  /** Что чаще всего выкатывают против меня — к чему готовиться. */
  enemyVehicles({ since = 0, limit = 25 } = {}) {
    return this.db
      .prepare(
        `SELECT s.vehicle, COUNT(*) AS sorties, SUM(s.kills) AS kills,
                COUNT(DISTINCT s.player_id) AS players
         FROM sorties s
         JOIN battle_players bp
           ON bp.battle_id = s.battle_id AND bp.player_id = s.player_id
         JOIN battles b ON b.id = s.battle_id
         WHERE bp.team = 'enemy' AND b.started_at >= ? AND b.cancelled = 0 AND b.hidden = 0
         GROUP BY s.vehicle
         ORDER BY sorties DESC
         LIMIT ?`
      )
      .all(since, limit);
  }

  /**
   * Бои по часам суток — «когда я вообще играю» и в какие часы выигрываю.
   * Час берётся по местному времени: интересует режим дня игрока, а не UTC.
   * Возвращает ровно 24 строки, включая пустые часы — иначе на графике
   * ночные провалы схлопывались бы, и сутки читались бы неправильно.
   */
  activityByHour({ from = 0, to = 0 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                COUNT(*) AS battles,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(my_kills), 0)   AS kills,
                COALESCE(SUM(my_deaths), 0)  AS deaths,
                COALESCE(SUM(my_assists), 0) AS assists
         FROM battles
         WHERE started_at >= ? AND (? = 0 OR started_at <= ?) AND cancelled = 0 AND hidden = 0
         GROUP BY hour`
      )
      .all(from, to, to);

    const byHour = new Map(rows.map((r) => [r.hour, r]));
    return Array.from({ length: 24 }, (_, hour) => {
      const r = byHour.get(hour);
      return r || { hour, battles: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0 };
    });
  }

  /**
   * Сводка по дням — основа и для линий «КДА/винрейт по дням», и для
   * календаря активности. Дни без боёв не возвращаются: их дорисовывает
   * тот, кто строит сетку.
   */
  dailyStats({ from = 0, to = 0 } = {}) {
    return this.db
      .prepare(
        `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS battles,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(my_kills), 0)   AS kills,
                COALESCE(SUM(my_deaths), 0)  AS deaths,
                COALESCE(SUM(my_assists), 0) AS assists
         FROM battles
         WHERE started_at >= ? AND (? = 0 OR started_at <= ?) AND cancelled = 0 AND hidden = 0
         GROUP BY day
         ORDER BY day`
      )
      .all(from, to, to);
  }

  /**
   * Серии побед и поражений. Бои с нераспознанным исходом серию не рвут и не
   * продолжают — их просто нет в расчёте: иначе один неопознанный бой посреди
   * вечера обнулял бы честную серию из десяти побед.
   * @param {object} [opts]
   * @param {number} [opts.recent] - сколько последних боёв вернуть полоской.
   */
  /**
   * @param {object} [opts]
   * @param {number} [opts.recent] - сколько последних боёв отдать полоской
   * @param {number} [opts.from] - считать только с этого момента; 0 — вся история
   */
  streaks({ recent = 50, from = 0 } = {}) {
    // Серия за период считается по боям этого периода, а не обрезается из
    // общей: серия, начавшаяся до его начала, к вопросу «как я играл в этом
    // месяце» отношения не имеет.
    const all = this.db
      .prepare(
        `SELECT id, started_at, result FROM battles
          WHERE cancelled = 0 AND hidden = 0 AND started_at >= ?
          ORDER BY started_at, id`
      )
      .all(from || 0);

    let current = { type: 'none', length: 0 };
    let bestWin = 0;
    let worstLoss = 0;

    for (const b of all) {
      if (b.result !== 'win' && b.result !== 'loss') continue;
      if (current.type === b.result) current.length += 1;
      else current = { type: b.result, length: 1 };

      if (current.type === 'win') bestWin = Math.max(bestWin, current.length);
      else worstLoss = Math.max(worstLoss, current.length);
    }

    return {
      current,
      bestWin,
      worstLoss,
      // Полоска рисуется слева направо по времени, поэтому хвост, а не голова.
      recent: all.slice(-Math.max(1, recent)).map((b) => ({ id: b.id, result: b.result })),
    };
  }

  /** Винрейт за период. Бои без распознанного исхода не искажают числа. */
  winrate({ since = 0 } = {}) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
         FROM battles WHERE started_at >= ? AND cancelled = 0 AND hidden = 0`
      )
      .get(since);
    const decided = (r.wins || 0) + (r.losses || 0);
    return {
      total: r.total || 0,
      wins: r.wins || 0,
      losses: r.losses || 0,
      unknown: (r.total || 0) - decided,
      percent: decided ? Math.round((r.wins / decided) * 100) : null,
    };
  }

  setNote(nick, note) {
    const p = this.db.prepare('SELECT id FROM players WHERE nick = ?').get(nick);
    if (!p) return false;
    const text = String(note || '').trim();
    if (!text) {
      this.db.prepare('DELETE FROM player_notes WHERE player_id = ?').run(p.id);
      return true;
    }
    this.db
      .prepare(
        `INSERT INTO player_notes (player_id, note, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
      )
      .run(p.id, text, Date.now());
    return true;
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    // battles — видимые сейчас; hidden — бои другого аккаунта, спрятанные до
    // его возвращения (в файле они есть, на экране — нет).
    const battles = one('SELECT COUNT(*) n FROM battles WHERE hidden = 0').n;
    const hidden = one('SELECT COUNT(*) n FROM battles WHERE hidden <> 0').n;
    const players = one('SELECT COUNT(*) n FROM players').n;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      // База может быть ещё не сброшена на диск — не страшно.
    }
    return { battles, hidden, players, sizeBytes: size, file: this.file };
  }

  /**
   * Копия базы рядом с ней — делается перед любым разрушительным сбросом и
   * перед миграциями.
   *
   * Через VACUUM INTO, а не копированием файла. База работает в режиме WAL:
   * свежие записи лежат в журнале (-wal), а главный файл догоняет его только
   * на контрольной точке. Раньше здесь была контрольная точка и копия файла;
   * если точка не проходила целиком (базу в этот момент читал кто-то ещё),
   * в копию попадал главный файл без журнала — база многодневной давности, а
   * то и пустая. Такой «бэкап» хуже никакого: глядя на него, решают, что
   * данных и не было. VACUUM INTO пишет согласованный снимок с учётом журнала.
   */
  backup() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${this.file}.${stamp}.bak`;
    this.db.prepare('VACUUM INTO ?').run(target);
    return target;
  }

  /** Удаляет историю боёв. Игроки остаются, если keepPlayers. */
  clearHistory({ keepPlayers = true } = {}) {
    const backup = this.backup();
    this.db.exec('DELETE FROM battle_players');
    this.db.exec('DELETE FROM battles');
    if (!keepPlayers) this.db.exec('DELETE FROM players');
    // Боёв больше нет — водяные знаки возвращаем в ноль.
    const now = Date.now();
    const upd = this.db.prepare('UPDATE counters SET reset_at = ?, reset_id = 0 WHERE name = ?');
    for (const name of COUNTERS) upd.run(now, name);
    this.db.exec('VACUUM');
    return backup;
  }

  clearPlayers() {
    const backup = this.backup();
    this.db.exec('DELETE FROM battle_players');
    this.db.exec('DELETE FROM players');
    this.db.exec('VACUUM');
    return backup;
  }
}

module.exports = { Db, COUNTERS, windowStart, isCorruption };

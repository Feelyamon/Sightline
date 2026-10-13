'use strict';

// Восстановление истории из резервных копий (1.0.4).
//
// Решение владельца: вернуть бои из копий — общей функцией в настройках, а не
// разовой правкой. Обещания, которые здесь проверяются:
//   · копии находятся по именам, которые даёт сама программа (.bak и
//     .corrupt-*), журналы копий отдельными копиями не считаются;
//   · оригиналы не меняются НИ НА БАЙТ — всё делается с временной копией;
//   · старая схема доводится до текущей тем же кодом миграций;
//   · дубликатов нет: по ключу сервера или по времени начала;
//   · восстановленное помечено «без входа» и на сервер не уходит никогда;
//   · из испорченной копии берётся то, что читается, а что не прочиталось —
//     называется.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { Db } = require('../src/main/db');
const { BattleState } = require('../src/main/battle-state');
const { Sync } = require('../src/main/sync');
const {
  Restore,
  findBackups,
  classify,
  stampTime,
  prepare,
  inspect,
  importInto,
} = require('../src/main/restore');

const tmpDir = (tag = 'restore') => fs.mkdtempSync(path.join(os.tmpdir(), `sightline-${tag}-`));
const T0 = Date.parse('2026-08-10T18:00:00.000Z');
const HOUR = 3600 * 1000;

/** Бой с наградой и дуэлью — чтобы было что переносить кроме самого боя. */
function snapshot(foe = 'Foe') {
  const s = new BattleState('Me');
  s.ingest({ id: 1, msg: `Me (Т-80БВМ) уничтожил ${foe} (M1A2)`, time: 10 });
  s.ingest({ id: 2, msg: 'Me (Т-80БВМ) получил "Снайпер II"', time: 20 });
  return s.snapshot();
}

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** Живая база с n боями и её .bak с заданным временем в имени. */
function liveWithBackup(n, { at = T0, made = Date.parse('2026-08-15T04:24:44.748Z') } = {}) {
  const dir = tmpDir();
  const db = new Db(dir);
  for (let i = 0; i < n; i++) {
    db.saveBattle(snapshot(`Foe${i}`), { startedAt: at + i * HOUR, endedAt: at + i * HOUR + 600_000 });
  }
  const bak = path.join(dir, `battles.db.${stamp(made)}.bak`);
  db.db.prepare('VACUUM INTO ?').run(bak);
  return { dir, db, bak };
}

/**
 * База формата первых версий: без наград, вылетов, дуэлей, без assists, result,
 * tz_offset, trust и без номера схемы (user_version = 0).
 */
function oldSchemaFile(file, n) {
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE battles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration INTEGER NOT NULL,
      my_kills INTEGER NOT NULL DEFAULT 0, my_deaths INTEGER NOT NULL DEFAULT 0,
      my_vehicles TEXT NOT NULL DEFAULT '[]', players_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE players (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL UNIQUE,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
    CREATE TABLE battle_players (
      battle_id INTEGER NOT NULL, player_id INTEGER NOT NULL, team TEXT NOT NULL,
      kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0,
      vehicles TEXT NOT NULL DEFAULT '[]', left_battle INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (battle_id, player_id)
    );
    CREATE TABLE counters (name TEXT PRIMARY KEY, reset_at INTEGER NOT NULL);
  `);
  const insB = raw.prepare(
    'INSERT INTO battles (started_at, ended_at, duration, my_kills, my_deaths, my_vehicles, players_seen) VALUES (?, ?, ?, ?, ?, ?, 2)'
  );
  raw.prepare("INSERT INTO players (nick, first_seen, last_seen) VALUES ('Me', 1, 2), ('OldFoe', 1, 2)").run();
  const insBp = raw.prepare(
    'INSERT INTO battle_players (battle_id, player_id, team, kills, deaths) VALUES (?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < n; i++) {
    const id = insB.run(T0 - 30 * 24 * HOUR + i * HOUR, T0 - 30 * 24 * HOUR + i * HOUR + 1, 300, 2, 1, '["ИС-2"]').lastInsertRowid;
    insBp.run(id, 1, 'ally', 2, 1);
    insBp.run(id, 2, 'enemy', 1, 2);
  }
  raw.close();
}

/** Портит предпоследнюю страницу — как в db-safety.test.js. */
function corrupt(file) {
  const buf = fs.readFileSync(file);
  const pageSize = buf.readUInt16BE(16);
  const at = buf.length - 2 * pageSize;
  buf.fill(0xa5, at, at + pageSize);
  fs.writeFileSync(file, buf);
}

// --- Поиск копий ----------------------------------------------------------------

test('копии узнаются по именам, которые даёт программа', () => {
  assert.deepEqual(classify('battles.db.2026-08-15T04-24-44-748Z.bak'), {
    kind: 'backup',
    stamp: '2026-08-15T04-24-44-748Z',
  });
  assert.deepEqual(classify('battles.db.corrupt-2026-09-01T10-00-00-000Z'), {
    kind: 'corrupt',
    stamp: '2026-09-01T10-00-00-000Z',
  });
  for (const name of [
    'battles.db',
    'battles.db-wal',
    'battles.db-shm',
    'battles.db.corrupt-2026-09-01T10-00-00-000Z-wal',
    'battles.db.corrupt-2026-09-01T10-00-00-000Z-shm',
    'settings.json',
    'other.db.2026-08-15T04-24-44-748Z.bak',
  ]) {
    assert.equal(classify(name), null, name);
  }
  assert.equal(stampTime('2026-08-15T04-24-44-748Z'), Date.parse('2026-08-15T04:24:44.748Z'));
  assert.equal(stampTime('вчера'), null);
});

test('список копий — от свежих к старым, без журналов и без самой базы', () => {
  const dir = tmpDir();
  const db = new Db(dir);
  db.backup();
  db.close();
  fs.writeFileSync(path.join(dir, 'battles.db.2026-08-15T04-24-44-748Z.bak'), 'x');
  fs.writeFileSync(path.join(dir, 'battles.db.corrupt-2026-09-01T10-00-00-000Z'), 'x');
  fs.writeFileSync(path.join(dir, 'battles.db.corrupt-2026-09-01T10-00-00-000Z-wal'), 'x');
  fs.writeFileSync(path.join(dir, 'outbox.json'), '{}');
  const found = findBackups(dir);
  // Две копии сделала сама программа: при создании базы (миграция схемы) и
  // по db.backup(); ещё две — подложены.
  assert.equal(found.length, 4);
  assert.deepEqual(found.map((f) => f.kind), ['backup', 'backup', 'corrupt', 'backup']);
  for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].madeAt >= found[i].madeAt);
  assert.ok(found.every((f) => !f.name.endsWith('-wal')));
  assert.equal(findBackups(path.join(dir, 'нет-такой')).length, 0);
});

// --- Оригиналы не трогаются -------------------------------------------------------

test('осмотр и перенос не меняют оригинал ни на байт', () => {
  const { dir, db, bak } = liveWithBackup(5);
  db.clearHistory(); // «пропала вся статистика»
  const before = hash(bak);
  const mtime = fs.statSync(bak).mtimeMs;

  const restore = new Restore(db, { workRoot: tmpDir('work') });
  const list = restore.list();
  restore.import(list.map((i) => i.file));
  restore.close();

  assert.equal(hash(bak), before);
  assert.equal(fs.statSync(bak).mtimeMs, mtime);
  // И рядом с оригиналом не появилось его журнала: базу открывали не здесь.
  assert.equal(fs.existsSync(`${bak}-wal`), false);
  assert.equal(fs.existsSync(`${bak}-shm`), false);
  assert.ok(fs.readdirSync(dir).every((f) => !f.includes('restore')));
  db.close();
});

test('старая схема мигрирует во временной копии, а оригинал остаётся старым', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'battles.db.2026-08-15T04-24-44-748Z.bak');
  oldSchemaFile(file, 4);
  const before = hash(file);

  const target = new Db(tmpDir());
  const entry = findBackups(dir)[0];
  const info = inspect(entry, target, tmpDir('work'));
  assert.equal(info.error, null);
  assert.equal(info.battles, 4);
  assert.equal(info.newBattles, 4);

  const prepared = prepare(file, tmpDir('work'));
  assert.ok(prepared.db.migration.applied.length > 0, 'миграции прошли в копии');
  prepared.db.close();

  assert.equal(hash(file), before);
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 0);
  raw.close();

  const r = importInto(target, info.workDir);
  assert.equal(r.imported, 4);
  const rows = target.searchBattles().rows;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((b) => b.trust === 'guest' && b.origin === 'backup'));
  assert.equal(rows[0].result, 'unknown', 'колонка из миграции — со значением по умолчанию');
  const d = target.battleDetails(rows[0].id);
  assert.deepEqual(d.players.map((p) => p.nick).sort(), ['Me', 'OldFoe']);
  target.close();
});

// --- Перенос ------------------------------------------------------------------------

test('19 боёв из копии возвращаются со всем составом, наградами и дуэлями', () => {
  const { db } = liveWithBackup(19);
  const before = db.db.prepare('SELECT COUNT(*) n FROM awards').get().n;
  assert.ok(before > 0);
  db.clearHistory();
  db.db.exec('DELETE FROM awards; DELETE FROM sorties; DELETE FROM duels');
  assert.equal(db.stats().battles, 0);

  const restore = new Restore(db, { workRoot: tmpDir('work') });
  const list = restore.list();
  // Своя копия и та, что сделала очистка истории; пустая копия новой базы
  // в список не попадает.
  assert.equal(list.length, 2);
  const item = list.find((i) => i.name === 'battles.db.2026-08-15T04-24-44-748Z.bak');
  assert.equal(item.battles, 19);
  assert.equal(item.newBattles, 19);
  assert.equal(item.kind, 'backup');
  assert.equal(item.madeAt, Date.parse('2026-08-15T04:24:44.748Z'));

  const { backup, results } = restore.import([item.file]);
  assert.ok(fs.existsSync(backup), 'перед переносом — копия текущей базы');
  assert.equal(results[0].imported, 19);
  assert.equal(results[0].orphans, 0);
  restore.close();

  assert.equal(db.stats().battles, 19);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM awards').get().n, before);
  assert.ok(db.db.prepare('SELECT COUNT(*) n FROM duels').get().n > 0);
  assert.ok(db.db.prepare('SELECT COUNT(*) n FROM sorties').get().n > 0);
  const card = db.playerCard('Foe3');
  assert.equal(card.encounters.length, 1);
  // Восстановленное идёт в статистику, как и раньше.
  assert.equal(db.searchBattles().summary.battles, 19);
  assert.equal(db.dossier(['Foe3'], 'Me').Foe3.killedByMe, 1);
  db.close();
});

test('бой, который уже есть, второй раз не появляется', () => {
  const { db, bak } = liveWithBackup(5);
  // Два боя из пяти пропали, три остались.
  const ids = db.searchBattles().rows.map((b) => b.id);
  db.deleteBattle(ids[0]);
  db.deleteBattle(ids[1]);

  const restore = new Restore(db, { workRoot: tmpDir('work') });
  const item = restore.list().find((i) => i.file === bak);
  assert.equal(item.newBattles, 2);
  const { results } = restore.import([item.file]);
  assert.equal(results[0].imported, 2);
  assert.equal(results[0].skipped, 3);
  assert.equal(db.stats().battles, 5);

  // Второй перенос той же копии — ноль.
  const again = restore.list().find((i) => i.file === bak);
  assert.equal(again.newBattles, 0);
  assert.equal(restore.import([bak]).results[0].imported, 0);
  assert.equal(db.stats().battles, 5);
  restore.close();
  db.close();
});

test('совпадение по ключу сервера — тоже дубликат', () => {
  const dir = tmpDir();
  const src = new Db(dir);
  const id = src.saveBattle(snapshot(), { startedAt: T0 });
  src.setBattleKey(id, 'k-1');
  const bak = path.join(dir, `battles.db.${stamp(T0)}.bak`);
  src.db.prepare('VACUUM INTO ?').run(bak);
  src.close();

  const target = new Db(tmpDir());
  // Тот же бой пришёл с сервера с чуть другим временем начала.
  target.setViewer(1);
  target.mergeServerBattles(
    [{ battle_key: 'k-1', started_at: new Date(T0 + 3000).toISOString(), ended_at: new Date(T0 + 600_000).toISOString(), players: [] }],
    1
  );
  const info = inspect(findBackups(dir).find((f) => f.file === bak), target, tmpDir('work'));
  assert.equal(info.newBattles, 0);
  target.close();
});

test('один бой в нескольких копиях переносится один раз', () => {
  const { dir, db } = liveWithBackup(3, { made: T0 + 100 * HOUR });
  db.db.prepare('VACUUM INTO ?').run(path.join(dir, `battles.db.${stamp(T0 + 200 * HOUR)}.bak`));
  db.clearHistory(); // и это третья копия с теми же тремя боями
  const restore = new Restore(db, { workRoot: tmpDir('work') });
  const list = restore.list().filter((i) => i.newBattles);
  assert.equal(list.length, 3);
  const { results } = restore.import(list.map((i) => i.file));
  assert.equal(results.reduce((n, r) => n + r.imported, 0), 3);
  assert.equal(db.stats().battles, 3);
  restore.close();
  db.close();
});

test('бои с сервера из копии не переносятся — они вернутся с сервера', () => {
  const dir = tmpDir();
  const src = new Db(dir);
  src.setViewer(7);
  src.mergeServerBattles(
    [{ battle_key: 'srv', started_at: new Date(T0).toISOString(), ended_at: new Date(T0 + 1000).toISOString(), players: [] }],
    7
  );
  src.saveBattle(snapshot(), { startedAt: T0 + HOUR });
  const bak = path.join(dir, `battles.db.${stamp(T0 + 2 * HOUR)}.bak`);
  src.db.prepare('VACUUM INTO ?').run(bak);
  src.close();

  const target = new Db(tmpDir());
  const info = inspect(findBackups(dir).find((f) => f.file === bak), target, tmpDir('work'));
  assert.equal(info.battles, 2);
  assert.equal(info.newBattles, 1);
  const r = importInto(target, info.workDir);
  assert.equal(r.imported, 1);
  assert.equal(target.searchBattles().rows[0].origin, 'backup');
  target.close();
});

// --- На сервер не уходит ------------------------------------------------------------

test('восстановленный бой помечен «без входа» и на сервер не уходит', () => {
  const { dir, db } = liveWithBackup(2);
  // В копии бои были отправлены и подтверждены — неважно: по копии не узнать,
  // под чьим входом они записаны.
  db.db.exec("UPDATE battles SET trust = 'confirmed', server_key = 'k-' || id");
  const bak = path.join(dir, `battles.db.${stamp(T0 + 999 * HOUR)}.bak`);
  db.db.prepare('VACUUM INTO ?').run(bak);
  db.clearHistory();

  const restore = new Restore(db, { workRoot: tmpDir('work') });
  restore.list();
  restore.import([bak]);
  restore.close();
  const rows = db.searchBattles().rows;
  assert.equal(rows.length, 2);
  for (const b of rows) {
    const d = db.battleDetails(b.id);
    assert.equal(d.trust, 'guest');
    assert.equal(d.origin, 'backup');
    assert.equal(d.server_key, null);
    assert.equal(d.owner_id, null);
    assert.equal(db.uploadAllowed(b.id), false);
  }
  // Ни сверка, ни ключ отправки к ним не прилипают.
  assert.deepEqual(db.battleKeysToRefresh(), []);
  db.setBattleKey(rows[0].id, 'x');
  assert.equal(db.battleDetails(rows[0].id).trust, 'guest');

  // Очередь отправки под входом их не принимает.
  const account = { isSignedIn: true, request: async () => ({ results: [] }) };
  const sync = new Sync(dir, account, db, { setTimer: () => 1, clearTimer: () => {} });
  sync.beginSession();
  assert.equal(sync.enqueue(rows[0].id, { started_at: 'x' }, sync.recording()), false);
  db.close();
});

test('восстановленные бои видны любому аккаунту — это история компьютера', () => {
  const { db, bak } = liveWithBackup(2);
  db.clearHistory();
  const restore = new Restore(db, { workRoot: tmpDir('work') });
  restore.list();
  restore.import([bak]);
  restore.close();
  db.setViewer(1);
  assert.equal(db.stats().battles, 2);
  db.setViewer(2);
  assert.equal(db.stats().battles, 2);
  db.close();
});

// --- Испорченные копии ----------------------------------------------------------------

test('из испорченной базы переносится читаемое, а нечитаемое называется', () => {
  const dir = tmpDir();
  const src = new Db(dir);
  for (let i = 0; i < 30; i++) src.saveBattle(snapshot(`Foe${i}`), { startedAt: T0 + i * HOUR });
  src.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  src.close();
  const file = path.join(dir, 'battles.db.corrupt-2026-09-01T10-00-00-000Z');
  fs.renameSync(path.join(dir, 'battles.db'), file);
  for (const s of ['-wal', '-shm']) fs.rmSync(path.join(dir, `battles.db${s}`), { force: true });
  corrupt(file);
  const before = hash(file);

  const target = new Db(tmpDir());
  const restore = new Restore(target, { workRoot: tmpDir('work') });
  // Копии ищутся рядом с РАБОЧЕЙ базой — подменяем папку на ту, где копия.
  target.file = path.join(dir, 'battles.db');
  const item = restore.list().find((i) => i.file === file);
  assert.equal(item.kind, 'corrupt');
  assert.ok(item.error, 'порча замечена');
  assert.ok(item.salvaged, 'спасение прошло');
  assert.ok(item.unreadable.length > 0, `названо нечитаемое: ${JSON.stringify(item)}`);
  assert.equal(item.newBattles, item.battles);

  const { results } = restore.import([item.file]);
  assert.equal(results[0].imported, item.battles);
  restore.close();
  assert.equal(hash(file), before, 'испорченный оригинал не тронут');
  target.close();
});

test('файл, который вовсе не база, не роняет список', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'battles.db.corrupt-2026-09-01T10-00-00-000Z'), Buffer.alloc(8192, 0x42));
  const target = new Db(dir);
  const restore = new Restore(target, { workRoot: tmpDir('work') });
  const list = restore.list();
  assert.equal(list.length, 1, 'пустая копия новой базы не показывается, испорченная — да');
  const [item] = list;
  assert.equal(item.kind, 'corrupt');
  assert.equal(item.battles, 0);
  assert.equal(item.newBattles, 0);
  assert.ok(item.error);
  restore.close();
  target.close();
});

test('журнал испорченной базы едет вместе с ней', () => {
  // Свежие бои живут в -wal до контрольной точки: без журнала их бы не было.
  const dir = tmpDir();
  const src = new Db(dir);
  src.db.exec('PRAGMA wal_autocheckpoint = 0');
  for (let i = 0; i < 3; i++) src.saveBattle(snapshot(), { startedAt: T0 + i * HOUR });
  const name = 'battles.db.corrupt-2026-09-01T10-00-00-000Z';
  // Снимаем файлы, пока база открыта: журнал ещё не слит в главный файл.
  fs.copyFileSync(path.join(dir, 'battles.db'), path.join(dir, name));
  fs.copyFileSync(path.join(dir, 'battles.db-wal'), path.join(dir, `${name}-wal`));
  src.close();

  const target = new Db(tmpDir());
  const info = inspect(findBackups(dir).find((f) => f.name === name), target, tmpDir('work'));
  assert.equal(info.battles, 3);
  target.close();
});

// --- Временные папки -------------------------------------------------------------------

test('временные копии убираются', () => {
  const { db } = liveWithBackup(1);
  const work = tmpDir('work');
  const restore = new Restore(db, { workRoot: work });
  restore.list();
  assert.ok(fs.readdirSync(work).length > 0);
  restore.close();
  assert.deepEqual(fs.readdirSync(work), []);
  db.close();
});

test('перенос из копии, которой нет в списке, ничего не делает', () => {
  const { db } = liveWithBackup(1);
  const restore = new Restore(db, { workRoot: tmpDir('work') });
  restore.list();
  assert.deepEqual(restore.import(['C:/нет/такого/файла.bak']), { backup: null, results: [] });
  restore.close();
  db.close();
});

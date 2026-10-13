'use strict';

// Сохранность локальной истории.
//
// Жалоба владельца: «пропала вся статистика». Разбор показал две слабости,
// которые эти тесты закрывают:
//   · бэкап копировал главный файл базы без журнала (-wal) и мог оказаться
//     снимком многодневной давности или вовсе пустым;
//   · испорченная база роняла программу на запуске, и оставалось только
//     удалить файл — вместе с тем, что ещё читалось.
// И одна новая обязанность: бой, записанный без входа, помечен в базе как
// гостевой и такой отметки не теряет.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { Db, isCorruption } = require('../src/main/db');
const { BattleState } = require('../src/main/battle-state');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-db-'));

function battle(n = 1, selfNick = 'Me') {
  const s = new BattleState(selfNick);
  for (let i = 0; i < n; i++) s.ingest({ id: i + 1, msg: `Me (Т-80БВМ) уничтожил Foe${i} (M1A2)`, time: i * 10 });
  return s.snapshot();
}

const count = (file, table = 'battles') => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
};

// --- Гостевые бои ---------------------------------------------------------

test('бой без входа пишется с отметкой guest', () => {
  const db = new Db(tmpDir());
  const id = db.saveBattle(battle(), { guest: true });
  assert.equal(db.battleDetails(id).trust, 'guest');
  assert.equal(db.searchBattles().rows[0].trust, 'guest');
  db.close();
});

test('обычный бой пишется как local — «ещё не отправлен»', () => {
  const db = new Db(tmpDir());
  const id = db.saveBattle(battle());
  assert.equal(db.battleDetails(id).trust, 'local');
  db.close();
});

test('перезапись боя сохраняет гостевую отметку', () => {
  const db = new Db(tmpDir());
  const id = db.saveBattle(battle(1), { guest: true });
  const again = db.updateBattle(id, battle(3), { guest: true });
  assert.equal(db.battleDetails(again).trust, 'guest');
  assert.equal(db.stats().battles, 1);
  db.close();
});

test('гостевой бой не получает ключ сервера', () => {
  const db = new Db(tmpDir());
  const id = db.saveBattle(battle(), { guest: true });
  db.setBattleKey(id, 'key-1');
  const row = db.battleDetails(id);
  assert.equal(row.trust, 'guest');
  assert.equal(row.server_key, null);
  assert.deepEqual(db.battleKeysToRefresh(), [], 'и сверку про него не спрашиваем');
  db.close();
});

test('гостевые бои остаются в личной статистике', () => {
  // На сервер не уходят, но это бои человека: локальные счётчики и итоги
  // их считают, как и раньше.
  const db = new Db(tmpDir());
  db.saveBattle(battle(), { guest: true, result: 'win' });
  db.saveBattle(battle(), { result: 'loss' });
  const { summary } = db.searchBattles();
  assert.equal(summary.battles, 2);
  assert.equal(summary.wins, 1);
  db.close();
});

// --- Бэкап ----------------------------------------------------------------

test('бэкап содержит свежие бои из журнала, а не только главный файл', () => {
  const dir = tmpDir();
  const db = new Db(dir);
  // Держим второе соединение с открытым чтением: контрольная точка при нём
  // не может перенести журнал в главный файл. Именно так старый бэкап
  // (контрольная точка + копия файла) терял свежие записи.
  const reader = new DatabaseSync(db.file);
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM battles').get();
  for (let i = 0; i < 5; i++) db.saveBattle(battle());

  const bak = db.backup();
  reader.exec('COMMIT');
  reader.close();

  assert.equal(count(bak), 5, 'в копии все пять боёв');
  db.close();
});

test('бэкап — самостоятельная база без журнала рядом', () => {
  const dir = tmpDir();
  const db = new Db(dir);
  db.saveBattle(battle());
  const bak = db.backup();
  assert.ok(!fs.existsSync(`${bak}-wal`));
  const check = new DatabaseSync(bak, { readOnly: true });
  assert.equal(Object.values(check.prepare('PRAGMA integrity_check').get())[0], 'ok');
  check.close();
  db.close();
});

test('очистка истории оставляет бэкап со всеми боями', () => {
  const db = new Db(tmpDir());
  for (let i = 0; i < 3; i++) db.saveBattle(battle());
  const bak = db.clearHistory();
  assert.equal(db.stats().battles, 0);
  assert.equal(count(bak), 3);
  db.close();
});

test('миграции делают бэкап только когда есть что применять', () => {
  const dir = tmpDir();
  new Db(dir).close();
  const before = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));
  new Db(dir).close();
  const after = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));
  assert.deepEqual(after, before, 'повторный запуск копий не плодит');
});

// --- Испорченная база -----------------------------------------------------

/** База с боями, у которой испорчена одна страница данных. */
function damagedDb(battles = 30) {
  const dir = tmpDir();
  const db = new Db(dir);
  for (let i = 0; i < battles; i++) db.saveBattle(battle(3));
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const file = path.join(dir, 'battles.db');
  const buf = fs.readFileSync(file);
  const pageSize = buf.readUInt16BE(16);
  // Портим предпоследнюю страницу: заголовок базы и схема целы, а таблица —
  // нет. Это и есть «database disk image is malformed».
  const at = buf.length - 2 * pageSize;
  buf.fill(0xa5, at, at + pageSize);
  fs.writeFileSync(file, buf);
  return { dir, file };
}

test('испорченная база не роняет программу', () => {
  const { dir } = damagedDb();
  const db = new Db(dir);
  assert.ok(db.recovery, 'порча замечена');
  // Новая база работает.
  const id = db.saveBattle(battle());
  assert.ok(id > 0);
  db.close();
});

test('испорченная база не удаляется, а откладывается рядом', () => {
  const { dir, file } = damagedDb();
  const original = fs.readFileSync(file);
  const db = new Db(dir);
  const { corruptFile } = db.recovery;
  assert.ok(corruptFile.startsWith(`${file}.corrupt-`));
  assert.ok(fs.existsSync(corruptFile));
  assert.deepEqual(fs.readFileSync(corruptFile), original, 'отложен байт в байт');
  db.close();
});

test('из испорченной базы переносится всё, что читается', () => {
  const { dir } = damagedDb(30);
  const db = new Db(dir);
  const moved = db.recovery.salvaged;
  assert.equal(typeof moved.battles, 'number');
  assert.equal(db.stats().battles, moved.battles);
  // Счётчики заводятся заново, если их строки не прочитались.
  assert.equal(Object.keys(db.counters()).length, 5);
  db.close();
});

test('файл, который вовсе не база, тоже откладывается, а не стирается', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'battles.db');
  fs.writeFileSync(file, Buffer.alloc(8192, 0x42));
  const db = new Db(dir);
  assert.ok(db.recovery);
  assert.equal(fs.readFileSync(db.recovery.corruptFile).length, 8192);
  assert.equal(db.stats().battles, 0);
  db.close();
});

test('журнал испорченной базы откладывается вместе с ней', () => {
  const { dir, file } = damagedDb(5);
  fs.writeFileSync(`${file}-wal`, Buffer.alloc(100, 1));
  const db = new Db(dir);
  assert.ok(fs.existsSync(`${db.recovery.corruptFile}-wal`));
  db.close();
});

test('целая база открывается без всяких отложенных копий', () => {
  const dir = tmpDir();
  const db = new Db(dir);
  db.saveBattle(battle());
  db.close();
  const again = new Db(dir);
  assert.equal(again.recovery, null);
  assert.equal(again.stats().battles, 1);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')),
    []
  );
  again.close();
});

test('порча отличается от прочих ошибок', () => {
  assert.equal(isCorruption({ errcode: 11 }), true);
  assert.equal(isCorruption({ errcode: 26 }), true);
  assert.equal(isCorruption(new Error('database disk image is malformed')), true);
  assert.equal(isCorruption(new Error('file is not a database')), true);
  // «Занято» и «нет места» — не порча: откладывать из-за них базу нельзя.
  assert.equal(isCorruption({ errcode: 5, message: 'database is locked' }), false);
  assert.equal(isCorruption(new Error('disk I/O error')), false);
});

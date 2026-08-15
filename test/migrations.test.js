'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { Db } = require('../src/main/db');
const { migrate, LATEST } = require('../src/main/migrations');
const { normalizeAward, parseMessage } = require('../src/main/killfeed-parser');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wtvh-mig-'));

// --- Разбор степени награды ----------------------------------------------

test('степень отделяется от названия награды', () => {
  assert.deepEqual(normalizeAward('Снайпер II'), { name: 'Снайпер', tier: 2 });
  assert.deepEqual(normalizeAward('Тактик 2 степени'), { name: 'Тактик', tier: 2 });
  assert.deepEqual(normalizeAward('Тактик 3-й степени'), { name: 'Тактик', tier: 3 });
  assert.deepEqual(normalizeAward('Спасатель танков III степени'), {
    name: 'Спасатель танков',
    tier: 3,
  });
  assert.deepEqual(normalizeAward('Tank Rescuer 2 class'), { name: 'Tank Rescuer', tier: 2 });
  assert.deepEqual(normalizeAward('Базовый штурмовик IV'), { name: 'Базовый штурмовик', tier: 4 });
});

test('награда без степени остаётся как есть', () => {
  assert.deepEqual(normalizeAward('Снайпер'), { name: 'Снайпер', tier: 0 });
  assert.deepEqual(normalizeAward('Ударил первым'), { name: 'Ударил первым', tier: 0 });
  assert.deepEqual(normalizeAward('Последний удар'), { name: 'Последний удар', tier: 0 });
});

test('короткий остаток не принимается за название — лучше не разобрать', () => {
  // Иначе «М 2» превратилось бы в награду «М» второй степени.
  assert.deepEqual(normalizeAward('М 2'), { name: 'М 2', tier: 0 });
  assert.deepEqual(normalizeAward('II'), { name: 'II', tier: 0 });
  assert.deepEqual(normalizeAward(''), { name: '', tier: 0 });
});

test('парсер отдаёт награду уже без степени в названии', () => {
  const r = parseMessage('Username (Т-80БВМ) получил "Снайпер II"');
  assert.equal(r.type, 'award');
  assert.equal(r.award, 'Снайпер');
  assert.equal(r.tier, 2);
  assert.equal(r.count, 1);

  // Степень и множитель встречаются вместе: «Удар из тени III: x5».
  const both = parseMessage('Username (Т-80БВМ) получил "Удар из тени III: x5"');
  assert.equal(both.award, 'Удар из тени');
  assert.equal(both.tier, 3);
  assert.equal(both.count, 5);
});

// --- Механизм миграций ----------------------------------------------------

test('новая база сразу на актуальной версии схемы', () => {
  const db = new Db(tmpDir());
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, LATEST);
  db.close();
});

test('повторное открытие базы не прогоняет миграции заново', () => {
  const dir = tmpDir();
  const first = new Db(dir);
  assert.ok(first.migration.applied.length > 0, 'на пустой базе шаги применились один раз');
  first.close();

  const again = new Db(dir);
  assert.deepEqual(again.migration.applied, [], 'второй раз применять нечего');
  assert.equal(again.migration.from, LATEST);
  again.close();
});

test('упавшая миграция откатывается целиком', () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, 'x.db'));
  raw.exec('CREATE TABLE t (n INTEGER)');

  const broken = [
    {
      version: 1,
      name: 'ломается на середине',
      up(db) {
        db.prepare('INSERT INTO t (n) VALUES (1)').run();
        throw new Error('специально');
      },
    },
  ];
  // Прогоняем шаг вручную тем же способом, что и migrate(), чтобы проверить
  // именно поведение транзакции.
  assert.throws(() => {
    raw.exec('BEGIN');
    try {
      broken[0].up(raw);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  });

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM t').get().n, 0, 'вставка откатилась');
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 0, 'версия не поднялась');
  raw.close();
});

// --- Миграция наград ------------------------------------------------------

/** База в старом виде: степень зашита в название, колонки tier ещё нет. */
function legacyDb(dir) {
  const file = path.join(dir, 'battles.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE battles (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE awards (
      battle_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      name      TEXT    NOT NULL,
      count     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (battle_id, player_id, name)
    );
  `);
  return db;
}

test('старые награды по уровням схлопываются в одну запись', () => {
  const db = legacyDb(tmpDir());
  const ins = db.prepare('INSERT INTO awards (battle_id, player_id, name, count) VALUES (?,?,?,?)');
  // Один игрок в одном бою прошёл три степени одной награды.
  ins.run(1, 1, 'Тактик', 1);
  ins.run(1, 1, 'Тактик II', 1);
  ins.run(1, 1, 'Тактик 3 степени', 1);
  // Награда без степеней и множителем — её трогать не должны.
  ins.run(1, 1, 'Удар из тени', 4);
  // Другой бой — записи не должны смешаться с первым.
  ins.run(2, 1, 'Тактик II', 1);

  const result = migrate(db);
  assert.equal(result.to, LATEST);

  const rows = db
    .prepare('SELECT battle_id, name, count, tier FROM awards ORDER BY battle_id, name')
    .all();
  assert.deepEqual(rows, [
    { battle_id: 1, name: 'Тактик', count: 1, tier: 3 },
    { battle_id: 1, name: 'Удар из тени', count: 4, tier: 0 },
    { battle_id: 2, name: 'Тактик', count: 1, tier: 2 },
  ]);
  db.close();
});

test('миграция наград идемпотентна', () => {
  const dir = tmpDir();
  const db = legacyDb(dir);
  db.prepare('INSERT INTO awards (battle_id, player_id, name, count) VALUES (?,?,?,?)').run(
    1, 1, 'Снайпер II', 1
  );

  migrate(db);
  const after = db.prepare('SELECT name, tier FROM awards').all();

  // Повторный прогон с обнулённой версией — так ведёт себя база, которую
  // открыли старым приложением, не поднявшим номер.
  db.exec('PRAGMA user_version = 1');
  migrate(db);
  assert.deepEqual(db.prepare('SELECT name, tier FROM awards').all(), after);
  db.close();
});

test('перед миграцией делается копия базы', () => {
  const db = legacyDb(tmpDir());
  db.prepare('INSERT INTO awards (battle_id, player_id, name, count) VALUES (?,?,?,?)').run(
    1, 1, 'Снайпер II', 1
  );

  let called = 0;
  migrate(db, {
    backup: () => {
      called += 1;
      return 'backup.bak';
    },
  });
  assert.equal(called, 1, 'копия делается один раз на весь прогон');

  // Применять нечего — копию делать незачем.
  migrate(db, { backup: () => { called += 1; return ''; } });
  assert.equal(called, 1);
  db.close();
});

test('бой сохраняет сдвиг местного времени от UTC', () => {
  const { BattleState } = require('../src/main/battle-state');
  const db = new Db(tmpDir());

  const s = new BattleState('Me');
  s.ingest({ id: 1, msg: 'Me (Т-80) уничтожил Foe (M1A2)', time: 10 });
  const id = db.saveBattle(s.snapshot());

  const row = db.db.prepare('SELECT started_at, tz_offset FROM battles WHERE id = ?').get(id);
  // Знак привычный: восточнее Гринвича — плюс. У JS он обратный, и разворот
  // делается ровно в одном месте, здесь это и проверяется.
  assert.equal(row.tz_offset, -new Date(row.started_at).getTimezoneOffset());
  db.close();
});

test('у старых боёв сдвиг остаётся неизвестным, а не нулём', () => {
  // Ноль — это UTC, а не «не знаю». Записи, сделанные до появления колонки,
  // должны остаться NULL, иначе лондонцами станут все.
  const dir = tmpDir();
  const file = path.join(dir, 'battles.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE battles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration INTEGER NOT NULL
    );
    INSERT INTO battles (started_at, ended_at, duration) VALUES (1000, 2000, 10);
  `);
  raw.close();

  const db = new Db(dir);
  assert.equal(db.db.prepare('SELECT tz_offset FROM battles WHERE id = 1').get().tz_offset, null);
  db.close();
});

test('отменённый бой не попадает ни в одну статистику', () => {
  const { BattleState } = require('../src/main/battle-state');
  const db = new Db(tmpDir());

  const make = (nick) => {
    const s = new BattleState('Me');
    [`Me (Т-80) уничтожил ${nick} (M1A2)`, `Me (Т-80) уничтожил ${nick}2 (M1A2)`].forEach(
      (msg, i) => s.ingest({ id: i + 1, msg, time: i * 10 })
    );
    return s.snapshot();
  };

  const good = db.saveBattle(make('Foe'), { result: 'win' });
  const bad = db.saveBattle(make('Ghost'), { result: 'win', cancelReason: 'feedGap' });
  assert.ok(good && bad);

  // Сам бой в списке есть — человек должен видеть, что он был.
  const found = db.searchBattles({});
  assert.equal(found.rows.length, 2, 'обе строки в списке');
  assert.equal(found.total, 2);
  assert.equal(found.rows.find((r) => r.id === bad).cancelled, 1);
  assert.equal(found.rows.find((r) => r.id === bad).cancel_reason, 'feedGap');

  // А в цифры не входит.
  assert.equal(found.summary.battles, 1, 'в сводке только целый бой');
  assert.equal(found.summary.cancelled, 1);
  assert.equal(found.summary.wins, 1);
  assert.equal(found.summary.kills, 2, 'фраги отменённого не суммируются');

  assert.equal(db.counters().today.battles, 1, 'счётчики');
  assert.equal(db.winrate().total, 1, 'винрейт');
  assert.equal(db.streaks().bestWin, 1, 'серии');
  assert.equal(db.activityByHour().reduce((n, h) => n + h.battles, 0), 1, 'часы');
  assert.equal(db.dailyStats().reduce((n, d) => n + d.battles, 0), 1, 'дни');
  assert.equal(db.myVehicles('Me')[0].battles, 1, 'моя техника');

  // Игроки из отменённого боя не идут в топы и в досье.
  assert.equal(db.topPlayers({ side: 'enemy' }).some((p) => p.nick === 'Ghost'), false);
  assert.equal(db.topPlayers({ side: 'enemy' }).some((p) => p.nick === 'Foe'), true);
  assert.deepEqual(db.dossier(['Ghost'], 'Me'), {}, 'досье пустое');
  db.close();
});

test('награды со степенями доезжают до базы и обратно', () => {
  const { BattleState } = require('../src/main/battle-state');
  const db = new Db(tmpDir());

  const s = new BattleState('Me');
  [
    'Me (Т-80БВМ) уничтожил Foe (M1A2)',
    'Me (Т-80БВМ) получил "Тактик"',
    'Me (Т-80БВМ) получил "Тактик II"',
  ].forEach((msg, i) => s.ingest({ id: i + 1, msg, time: i * 10 }));

  const id = db.saveBattle(s.snapshot());
  const me = db.battleDetails(id).players.find((p) => p.nick === 'Me');
  assert.deepEqual(me.awards, [{ name: 'Тактик', count: 1, tier: 2 }]);
  db.close();
});

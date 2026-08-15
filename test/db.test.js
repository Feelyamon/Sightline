'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Db } = require('../src/main/db');
const { BattleState } = require('../src/main/battle-state');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtvh-'));
  return new Db(dir);
}

function battle(messages, selfNick = 'Me') {
  const s = new BattleState(selfNick);
  messages.forEach((msg, i) => s.ingest({ id: i + 1, msg, time: i * 10 }));
  return s.snapshot();
}

test('бой сохраняется вместе с участниками', () => {
  const db = tmpDb();
  const id = db.saveBattle(
    battle([
      'Me (Т-80БВМ) уничтожил Foe (M1A2)',
      'Ally (ИС-2) уничтожил Foe2 (Leopard 2A4)',
    ])
  );
  assert.ok(id > 0);

  const stats = db.stats();
  assert.equal(stats.battles, 1);
  assert.equal(stats.players, 4);

  const card = db.playerCard('Foe');
  assert.equal(card.encounters.length, 1);
  assert.equal(card.encounters[0].team, 'enemy');
  db.close();
});

test('пустой бой не пишется', () => {
  const db = tmpDb();
  assert.equal(db.saveBattle(battle([])), null);
  assert.equal(db.stats().battles, 0);
  db.close();
});

test('открытие базы не сбрасывает счётчик сессии', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtvh-'));
  const db = new Db(dir);
  db.saveBattle(battle(['Me (Т-80) уничтожил Foe (M1A2)']));
  assert.equal(db.counters().session.battles, 1);
  db.close();

  // Повторное открытие тем же или другим процессом счётчик трогать не должно.
  const again = new Db(dir);
  assert.equal(again.counters().session.battles, 1);
  again.startSession();
  assert.equal(again.counters().session.battles, 0, 'явный старт сессии обнуляет');
  again.close();
});

test('счётчики считают бои и сбрасываются по одному', () => {
  const db = tmpDb();
  const snap = battle(['Me (Т-80БВМ) уничтожил Foe (M1A2)']);
  db.saveBattle(snap);
  db.saveBattle(snap);

  let c = db.counters();
  assert.equal(c.session.battles, 2);
  assert.equal(c.today.battles, 2);
  assert.equal(c.month.battles, 2);

  db.resetCounter('session');
  c = db.counters();
  assert.equal(c.session.battles, 0, 'сессия обнулилась');
  assert.equal(c.today.battles, 2, 'остальные счётчики не тронуты');
  db.close();
});

test('топ противников фильтруется по числу встреч', () => {
  const db = tmpDb();
  const often = battle(['Me (Т-80) уничтожил Regular (M1A2)']);
  for (let i = 0; i < 6; i++) db.saveBattle(often);
  db.saveBattle(battle(['Me (Т-80) уничтожил Rare (Leopard 2A4)']));

  const top = db.topPlayers({ side: 'enemy', minBattles: 5 });
  assert.equal(top.length, 1);
  assert.equal(top[0].nick, 'Regular');
  assert.equal(top[0].battles, 6);
  db.close();
});

test('очистка истории обнуляет счётчики и делает бэкап', () => {
  const db = tmpDb();
  db.saveBattle(battle(['Me (Т-80) уничтожил Foe (M1A2)']));

  const backup = db.clearHistory({ keepPlayers: true });
  assert.ok(fs.existsSync(backup), 'файл бэкапа создан');
  assert.equal(db.stats().battles, 0);
  assert.equal(db.counters().today.battles, 0);
  assert.ok(db.stats().players > 0, 'игроки сохранены');

  db.clearPlayers();
  assert.equal(db.stats().players, 0);
  db.close();
});

test('повторное сохранение обновляет бой, а не плодит копии', () => {
  const db = tmpDb();
  const first = db.saveBattle(battle(['Me (Т-80) уничтожил Foe (M1A2)']));
  assert.equal(db.stats().battles, 1);

  // Бой продолжился: тот же бой сохраняем ещё раз.
  const updated = db.updateBattle(
    first,
    battle([
      'Me (Т-80) уничтожил Foe (M1A2)',
      'Me (Т-80) уничтожил Foe2 (Leopard 2A4)',
    ])
  );

  assert.equal(db.stats().battles, 1, 'записей по-прежнему одна');
  assert.equal(db.recentBattles()[0].id, updated);
  assert.equal(db.recentBattles()[0].my_kills, 2, 'данные обновились');

  const card = db.playerCard('Foe');
  assert.equal(card.encounters.length, 1, 'встреча не задвоилась');
  db.close();
});

test('удаление одного боя не трогает остальные', () => {
  const db = tmpDb();
  const snap = battle(['Me (Т-80) уничтожил Foe (M1A2)']);
  const first = db.saveBattle(snap);
  db.saveBattle(snap);

  db.deleteBattle(first);
  assert.equal(db.stats().battles, 1);
  assert.equal(db.recentBattles()[0].id !== first, true);
  db.close();
});

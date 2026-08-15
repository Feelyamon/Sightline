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

// --- Поиск и фильтры во вкладке «Бои» ------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** Три боя на разные дни, с разным исходом, техникой и противниками. */
function history(db) {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const at = (daysAgo, snapshot, result) =>
    db.saveBattle(snapshot, {
      startedAt: now - daysAgo * DAY,
      endedAt: now - daysAgo * DAY + 600_000,
      result,
    });

  const ids = {
    old: at(10, battle(['Me (Т-80БВМ) уничтожил Sniper (M1A2)']), 'win'),
    middle: at(3, battle(['Me (ИС-2) уничтожил Camper (Leopard 2A4)']), 'loss'),
    fresh: at(0, battle(['Me (Т-80БВМ) уничтожил Camper (M1A2)']), 'win'),
  };
  return { now, ids };
}

test('поиск находит бои по нику участника', () => {
  const db = tmpDb();
  const { ids } = history(db);

  const found = db.searchBattles({ query: 'Sniper' });
  assert.equal(found.total, 1);
  assert.equal(found.rows[0].id, ids.old);

  assert.equal(db.searchBattles({ query: 'Camper' }).total, 2);
  assert.equal(db.searchBattles({ query: 'нет такого' }).total, 0);
  db.close();
});

test('поиск находит бои по технике — своей и чужой', () => {
  const db = tmpDb();
  const { ids } = history(db);

  assert.equal(db.searchBattles({ query: 'Т-80' }).total, 2, 'моя техника');
  assert.equal(db.searchBattles({ query: 'Leopard' }).total, 1, 'техника противника');
  assert.equal(db.searchBattles({ query: 'ИС-2' }).rows[0].id, ids.middle);
  db.close();
});

test('поиск не зависит от регистра, включая кириллицу', () => {
  const db = tmpDb();
  history(db);
  db.saveBattle(battle(['Me (Т-80) уничтожил ЖуЖуКаТест (M1A2)']));

  // Латиница работала бы и на LIKE, кириллица — уже нет.
  assert.equal(db.searchBattles({ query: 'sniper' }).total, 1);
  assert.equal(db.searchBattles({ query: 'т-80бвм' }).total, 2);
  assert.equal(db.searchBattles({ query: 'жужука' }).total, 1);
  assert.equal(db.searchBattles({ query: 'ЖУЖУКА' }).total, 1);
  db.close();
});

test('спецсимволы в запросе ищутся буквально, а не как шаблон LIKE', () => {
  const db = tmpDb();
  db.saveBattle(battle(['Me (Т-80) уничтожил 100%_pro (M1A2)']));
  db.saveBattle(battle(['Me (Т-80) уничтожил Foe (M1A2)']));

  assert.equal(db.searchBattles({ query: '100%_pro' }).total, 1);
  // Без экранирования «%_» съел бы оба боя.
  assert.equal(db.searchBattles({ query: '%_' }).total, 1);
  db.close();
});

test('фильтры по периоду и исходу', () => {
  const db = tmpDb();
  const { now, ids } = history(db);

  const week = db.searchBattles({ from: now - 7 * DAY });
  assert.equal(week.total, 2, 'бой десятидневной давности за границей окна');

  const window = db.searchBattles({ from: now - 5 * DAY, to: now - 1 * DAY });
  assert.equal(window.total, 1);
  assert.equal(window.rows[0].id, ids.middle);

  assert.equal(db.searchBattles({ result: 'win' }).total, 2);
  assert.equal(db.searchBattles({ result: 'loss' }).rows[0].id, ids.middle);
  assert.equal(db.searchBattles({ result: 'unknown' }).total, 0);
  db.close();
});

test('фильтр «мои бои на этой машине» смотрит только на мои вылеты', () => {
  const db = tmpDb();
  history(db);

  assert.equal(db.searchBattles({ myVehicle: 'Т-80БВМ', selfNick: 'Me' }).total, 2);
  assert.equal(db.searchBattles({ myVehicle: 'ИС-2', selfNick: 'Me' }).total, 1);
  // M1A2 в этих боях выкатывал противник — под «моей техникой» он не проходит.
  assert.equal(db.searchBattles({ myVehicle: 'M1A2', selfNick: 'Me' }).total, 0);
  // Ник не задан — фильтровать нечего, выдача пуста, а не «вся история».
  assert.equal(db.searchBattles({ myVehicle: 'Т-80БВМ', selfNick: '' }).total, 0);
  db.close();
});

test('фильтры складываются', () => {
  const db = tmpDb();
  const { now, ids } = history(db);

  const found = db.searchBattles({
    query: 'Camper',
    from: now - 7 * DAY,
    result: 'win',
    myVehicle: 'Т-80БВМ',
    selfNick: 'Me',
  });
  assert.equal(found.total, 1);
  assert.equal(found.rows[0].id, ids.fresh);
  db.close();
});

test('итоги считаются по отфильтрованной выборке, а не по всей базе', () => {
  const db = tmpDb();
  history(db);

  const all = db.searchBattles({}).summary;
  assert.equal(all.battles, 3);
  assert.equal(all.wins, 2);
  assert.equal(all.percent, 67);

  const loss = db.searchBattles({ result: 'loss' }).summary;
  assert.equal(loss.battles, 1);
  assert.equal(loss.wins, 0);
  assert.equal(loss.percent, 0);
  assert.equal(loss.kills, 1, 'фраги только из отобранного боя');
  db.close();
});

test('пагинация выдаёт страницы без пропусков и повторов', () => {
  const db = tmpDb();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    db.saveBattle(battle(['Me (Т-80) уничтожил Foe (M1A2)']), {
      startedAt: now - i * 60_000,
      endedAt: now - i * 60_000 + 1000,
    });
  }

  const first = db.searchBattles({ limit: 2, offset: 0 });
  const second = db.searchBattles({ limit: 2, offset: 2 });
  const third = db.searchBattles({ limit: 2, offset: 4 });

  assert.equal(first.total, 5, 'total — по всей выборке, не по странице');
  assert.equal(first.rows.length, 2);
  assert.equal(third.rows.length, 1, 'последняя страница неполная');

  const ids = [...first.rows, ...second.rows, ...third.rows].map((b) => b.id);
  assert.equal(new Set(ids).size, 5, 'ни один бой не попал на две страницы');
  db.close();
});

// --- Данные для графиков -------------------------------------------------

/** Бой в конкретный местный час указанного дня. */
function battleAt(db, { y = 2026, m = 7, d = 15, hour = 12, result = 'win', kills = 2 }) {
  const startedAt = new Date(y, m, d, hour, 30).getTime();
  const messages = [];
  for (let i = 0; i < kills; i++) messages.push(`Me (Т-80) уничтожил Foe${i} (M1A2)`);
  messages.push(`Foe0 (M1A2) уничтожил Me (Т-80)`);
  return db.saveBattle(battle(messages), { startedAt, endedAt: startedAt + 600_000, result });
}

test('активность по часам отдаёт все 24 часа местного времени', () => {
  const db = tmpDb();
  battleAt(db, { hour: 3 });
  battleAt(db, { hour: 21, result: 'win' });
  battleAt(db, { hour: 21, result: 'loss' });

  const hours = db.activityByHour();
  assert.equal(hours.length, 24, 'пустые часы тоже в выдаче');
  assert.deepEqual(hours.map((h) => h.hour), [...Array(24).keys()], 'по порядку, 0..23');

  assert.equal(hours[3].battles, 1);
  assert.equal(hours[21].battles, 2);
  assert.equal(hours[21].wins, 1);
  assert.equal(hours[21].losses, 1);
  assert.equal(hours[12].battles, 0, 'час без боёв не выпадает из ряда');
  db.close();
});

test('сводка по дням группирует по местной дате', () => {
  const db = tmpDb();
  battleAt(db, { d: 10, hour: 23, result: 'win' });
  battleAt(db, { d: 11, hour: 1, result: 'loss' });
  battleAt(db, { d: 11, hour: 2, result: 'win' });

  const days = db.dailyStats();
  assert.equal(days.length, 2);
  assert.deepEqual(days.map((r) => r.day), ['2026-08-10', '2026-08-11'], 'по возрастанию');
  assert.equal(days[1].battles, 2);
  assert.equal(days[1].wins, 1);
  assert.equal(days[1].kills, 4, 'фраги суммируются за день');
  db.close();
});

test('сводка по дням уважает границы периода', () => {
  const db = tmpDb();
  battleAt(db, { d: 1 });
  battleAt(db, { d: 20 });

  const days = db.dailyStats({ from: new Date(2026, 7, 10).getTime() });
  assert.equal(days.length, 1);
  assert.equal(days[0].day, '2026-08-20');
  db.close();
});

test('серии считаются, а бои без исхода их не рвут', () => {
  const db = tmpDb();
  for (const [i, result] of ['win', 'win', 'win', 'loss', 'win'].entries()) {
    battleAt(db, { d: 1 + i, result });
  }
  // Неопознанный бой посреди серии: он не должен ни продолжать её, ни рвать.
  battleAt(db, { d: 7, result: 'unknown' });
  battleAt(db, { d: 8, result: 'win' });

  const s = db.streaks();
  assert.equal(s.bestWin, 3, 'лучшая серия побед');
  assert.equal(s.worstLoss, 1);
  assert.deepEqual(s.current, { type: 'win', length: 2 }, 'серия пережила бой без исхода');
  db.close();
});

test('полоска последних боёв идёт по времени, старые слева', () => {
  const db = tmpDb();
  for (const [i, result] of ['loss', 'win', 'win'].entries()) battleAt(db, { d: 1 + i, result });

  const s = db.streaks({ recent: 2 });
  assert.equal(s.recent.length, 2, 'только запрошенный хвост');
  assert.deepEqual(s.recent.map((b) => b.result), ['win', 'win']);
  db.close();
});

test('серии на пустой базе не падают', () => {
  const db = tmpDb();
  const s = db.streaks();
  assert.deepEqual(s.current, { type: 'none', length: 0 });
  assert.equal(s.bestWin, 0);
  assert.deepEqual(s.recent, []);
  assert.deepEqual(db.dailyStats(), []);
  assert.equal(db.activityByHour().length, 24);
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

test('ключ боя с сервера и отметка доверия', () => {
  const db = tmpDb();
  const id = db.saveBattle(battle(['Me (Т-80БВМ) уничтожил Foe (M1A2)']));

  // Пока бой никуда не уезжал, отметки нет: 'local' — это «не отправлялся», и
  // путать его с серверным 'alone' («отправлен, свидетелей не нашлось»)
  // нельзя, иначе в списке боёв появится смысл, которого там нет.
  assert.equal(db.searchBattles({}).rows[0].trust, 'local');
  assert.deepEqual(db.battleKeysToRefresh(), [], 'без ключа спрашивать нечего');

  db.setBattleKey(id, 'abc123');
  assert.equal(db.searchBattles({}).rows[0].trust, 'pending');
  assert.deepEqual(db.battleKeysToRefresh(), ['abc123']);

  assert.equal(db.applyTrust([{ battle_key: 'abc123', trust: 'confirmed' }]), 1);
  assert.equal(db.searchBattles({}).rows[0].trust, 'confirmed');

  // Подтверждённый переспрашивать незачем: подтверждение не отзывается.
  assert.deepEqual(db.battleKeysToRefresh(), []);
});

test('чужой ключ ничего не портит', () => {
  const db = tmpDb();
  db.saveBattle(battle(['Me (Т-80БВМ) уничтожил Foe (M1A2)']));
  assert.equal(db.applyTrust([{ battle_key: 'которого нет', trust: 'confirmed' }]), 0);
  assert.equal(db.searchBattles({}).rows[0].trust, 'local');
});

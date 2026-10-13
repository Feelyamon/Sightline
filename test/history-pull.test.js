'use strict';

// История аккаунта с сервера (1.0.4).
//
// Решения владельца, которые здесь проверяются:
//   · после переустановки и на новом компьютере в истории — все бои аккаунта
//     с сервера;
//   · пришедшее с сервера туда не возвращается: отправка — только того, что
//     записано на этой машине;
//   · без входа сервер не спрашивается вовсе; выход ничего не удаляет;
//   · бои одного аккаунта не попадают в статистику другого, вошедшего на этой
//     же машине (прячутся, а не удаляются).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Db } = require('../src/main/db');
const { BattleState } = require('../src/main/battle-state');
const { HistoryPull, stopAfter } = require('../src/main/history-pull');
const { Sync } = require('../src/main/sync');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-pull-'));

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-09-01T18:00:00.000Z');

/** Бой так, как его отдаёт GET /v1/battles/mine. */
function srv(i, extra = {}) {
  const start = extra.start ?? T0 + i * 3600 * 1000;
  return {
    battle_key: extra.key ?? `key-${i}`,
    started_at: new Date(start).toISOString(),
    ended_at: new Date(start + 600_000).toISOString(),
    tz_offset: 180,
    duration_sec: 600,
    my_kills: 3,
    my_deaths: 1,
    my_assists: 2,
    result: i % 2 ? 'loss' : 'win',
    players_seen: 2,
    cancelled: false,
    cancel_reason: null,
    trust: extra.trust ?? 'alone',
    my_vehicles: ['Т-80БВМ', 'M1A2'],
    players: [
      {
        nick: '[CLAN] Me',
        team: 'ally',
        kills: 3,
        deaths: 1,
        assists: 2,
        left_battle: false,
        is_self: true,
        sorties: [
          { seq: 0, vehicle: 'Т-80БВМ', kills: 2, destroyed: true },
          { seq: 1, vehicle: 'M1A2', kills: 1, destroyed: false },
        ],
      },
      {
        nick: `Foe${i}`,
        team: 'enemy',
        kills: 1,
        deaths: 2,
        assists: 0,
        left_battle: true,
        is_self: false,
        sorties: [{ seq: 0, vehicle: 'Leopard 2A6', kills: 1, destroyed: true }],
      },
    ],
  };
}

/** Снимок боя, как его пишет программа. */
function snapshot(selfNick = 'Me') {
  const s = new BattleState(selfNick);
  s.ingest({ id: 1, msg: 'Me (Т-80БВМ) уничтожил Foe (M1A2)', time: 10 });
  return s.snapshot();
}

/**
 * Сервер истории без сети: держит бои аккаунтов, отдаёт страницы так же, как
 * настоящий (от новых к старым, курсор — позиция), и запоминает запросы.
 */
function fakeServer(byAccount) {
  const server = {
    requests: [],
    /** login → номер аккаунта */
    ids: { alpha: 1, beta: 2 },
    login: 'alpha',
    isSignedIn: true,
    hold: null,
    fail: null,
    state() {
      return { login: server.login, signedIn: server.isSignedIn };
    },
    async request(route, opts) {
      server.requests.push(route);
      assert.equal(opts?.auth, true, 'история — только под входом');
      if (server.fail) throw server.fail;
      const url = new URL(`http://x${route}`);
      assert.equal(url.pathname, '/battles/mine');
      const limit = Number(url.searchParams.get('limit'));
      const before = url.searchParams.get('before');
      const id = server.ids[server.login];
      const all = [...(byAccount[id] || [])].sort(
        (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)
      );
      const from = before ? all.findIndex((b) => b.battle_key === before) + 1 : 0;
      const battles = all.slice(from, from + limit);
      if (server.hold) await server.hold();
      return {
        account_id: id,
        battles,
        next_before: battles.length === limit ? battles[battles.length - 1].battle_key : null,
      };
    },
  };
  return server;
}

function puller(server, db, opts = {}) {
  const sleeps = [];
  const pull = new HistoryPull(server, db, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pageSize: 3,
    ...opts,
  });
  return { pull, sleeps };
}

const visibleKeys = (db) =>
  db.db
    .prepare('SELECT server_key FROM battles WHERE hidden = 0 AND server_key IS NOT NULL ORDER BY started_at')
    .all()
    .map((r) => r.server_key);

// --- Запись боёв с сервера --------------------------------------------------

test('бой с сервера пишется целиком: состав, вылеты, свои машины, отметка', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  const r = db.mergeServerBattles([srv(0, { trust: 'confirmed' })], 1);
  assert.deepEqual(r, { inserted: 1, known: 0, invalid: 0 });

  const row = db.searchBattles().rows[0];
  assert.equal(row.origin, 'server');
  assert.equal(row.trust, 'confirmed');
  assert.equal(row.started_at, T0);
  assert.deepEqual(row.my_vehicles, ['Т-80БВМ', 'M1A2']);
  assert.equal(row.duration, 600);
  assert.equal(row.my_kills, 3);

  const d = db.battleDetails(row.id);
  assert.equal(d.owner_id, 1);
  assert.equal(d.server_key, 'key-0');
  assert.equal(d.tz_offset, 180);
  assert.equal(d.players.length, 2);
  const foe = d.players.find((p) => p.nick === 'Foe0');
  assert.equal(foe.team, 'enemy');
  assert.equal(foe.left_battle, 1);
  assert.deepEqual(foe.vehicles, ['Leopard 2A6']);
  const sorties = db.db.prepare('SELECT COUNT(*) n FROM sorties WHERE battle_id = ?').get(row.id).n;
  assert.equal(sorties, 3);
  db.close();
});

test('бои с сервера видны в итогах и графиках', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  db.mergeServerBattles([srv(0), srv(1), srv(2)], 1);
  assert.equal(db.searchBattles().summary.battles, 3);
  assert.equal(db.winrate().total, 3);
  assert.equal(db.dailyStats().reduce((n, d) => n + d.battles, 0), 3);
  assert.equal(db.activityByHour().reduce((n, h) => n + h.battles, 0), 3);
  assert.equal(db.streaks().recent.length, 3);
  assert.equal(db.enemyVehicles()[0].vehicle, 'Leopard 2A6');
  assert.equal(db.myVehicles('Me').find((v) => v.vehicle === 'Т-80БВМ').battles, 3);
  assert.equal(db.topPlayers({ side: 'enemy' }).length, 3);
  db.close();
});

test('повторная страница ничего не дублирует', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  db.mergeServerBattles([srv(0), srv(1)], 1);
  const again = db.mergeServerBattles([srv(0), srv(1)], 1);
  assert.deepEqual(again, { inserted: 0, known: 2, invalid: 0 });
  assert.equal(db.stats().battles, 2);
  db.close();
});

test('бой, записанный здесь и отправленный, узнаётся по ключу', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  const id = db.saveBattle(snapshot(), { startedAt: T0 + 5, endedAt: T0 + 600_000 });
  db.setBattleKey(id, 'key-0');
  const r = db.mergeServerBattles([srv(0)], 1);
  assert.deepEqual(r, { inserted: 0, known: 1, invalid: 0 });
  assert.equal(db.stats().battles, 1);
  assert.equal(db.battleDetails(id).origin, 'recorded', 'своя запись остаётся своей');
  db.close();
});

test('бой, ключ которого потерялся по дороге, узнаётся по времени начала — и получает ключ', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  const id = db.saveBattle(snapshot(), { startedAt: T0, endedAt: T0 + 600_000 });
  assert.equal(db.battleDetails(id).server_key, null);
  const r = db.mergeServerBattles([srv(0, { trust: 'confirmed' })], 1);
  assert.equal(r.known, 1);
  const d = db.battleDetails(id);
  assert.equal(d.server_key, 'key-0');
  assert.equal(d.trust, 'confirmed');
  db.close();
});

test('гостевой бой с тем же временем не получает ключа и не меняет отметки', () => {
  const db = new Db(tmpDir());
  const id = db.saveBattle(snapshot(), { startedAt: T0, endedAt: T0 + 600_000, guest: true });
  db.mergeServerBattles([srv(0)], 1);
  const d = db.battleDetails(id);
  assert.equal(d.trust, 'guest');
  assert.equal(d.server_key, null);
  db.close();
});

test('битые записи пропускаются и считаются', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  const r = db.mergeServerBattles(
    [srv(0), { battle_key: '', started_at: 'x' }, { ...srv(1), ended_at: 'нет' }, null],
    1
  );
  assert.deepEqual(r, { inserted: 1, known: 0, invalid: 3 });
  db.close();
});

test('без номера аккаунта история не пишется', () => {
  const db = new Db(tmpDir());
  assert.throws(() => db.mergeServerBattles([srv(0)], undefined));
  assert.equal(db.stats().battles, 0);
  db.close();
});

// --- Обратно на сервер не уходит -------------------------------------------

test('пришедшее с сервера не разрешено к отправке, записанное здесь — разрешено', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  db.mergeServerBattles([srv(0)], 1);
  const fromServer = db.searchBattles().rows[0].id;
  const recorded = db.saveBattle(snapshot(), { startedAt: T0 + 5 * DAY });
  const guest = db.saveBattle(snapshot(), { startedAt: T0 + 6 * DAY, guest: true });
  assert.equal(db.uploadAllowed(fromServer), false);
  assert.equal(db.uploadAllowed(recorded), true);
  assert.equal(db.uploadAllowed(guest), false);
  assert.equal(db.uploadAllowed(999999), false);
  db.close();
});

test('очередь отправки не принимает бой с сервера даже под входом', () => {
  const dir = tmpDir();
  const db = new Db(dir);
  db.setViewer(1);
  db.mergeServerBattles([srv(0)], 1);
  const fromServer = db.searchBattles().rows[0].id;
  const posts = [];
  const account = {
    isSignedIn: true,
    async request(route, opts) {
      if (route === '/battles') posts.push(opts.body);
      return route === '/battles' ? { results: [] } : [];
    },
  };
  const sync = new Sync(dir, account, db, { setTimer: () => 1, clearTimer: () => {} });
  sync.beginSession();
  const recording = sync.recording();
  assert.equal(sync.enqueue(fromServer, { started_at: 'x' }, recording), false);
  assert.equal(sync.state().pending, 0);
  // Записанный здесь в той же сессии — уходит, то есть отказ выше именно
  // из-за происхождения записи, а не из-за сессии.
  const recorded = db.saveBattle(snapshot(), { startedAt: T0 + 5 * DAY });
  assert.equal(sync.enqueue(recorded, { started_at: 'y' }, recording), true);
  db.close();
});

test('ключ сервера не приклеивается к бою с сервера повторно через отправку', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  db.mergeServerBattles([srv(0)], 1);
  const id = db.searchBattles().rows[0].id;
  db.setBattleKey(id, 'другой-ключ');
  assert.equal(db.battleDetails(id).server_key, 'key-0');
  db.close();
});

test('подтягивание истории ничего не отправляет на сервер', async () => {
  const db = new Db(tmpDir());
  const server = fakeServer({ 1: [srv(0), srv(1)] });
  const { pull } = puller(server, db);
  pull.signedIn();
  await pull.pull();
  assert.ok(server.requests.every((r) => r.startsWith('/battles/mine')), server.requests.join());
  db.close();
});

// --- Листание ---------------------------------------------------------------

test('после переустановки приходит вся история, по странице за запрос и с паузами', async () => {
  const db = new Db(tmpDir());
  const all = Array.from({ length: 8 }, (_, i) => srv(i));
  const server = fakeServer({ 1: all });
  const { pull, sleeps } = puller(server, db);
  pull.signedIn();
  const r = await pull.pull();
  assert.equal(r.inserted, 8);
  assert.equal(r.pages, 3, '3 + 3 + 2');
  assert.equal(r.stoppedBy, 'end');
  assert.equal(server.requests.length, 3);
  assert.equal(sleeps.length, 2, 'пауза между страницами, не перед первой');
  assert.ok(server.requests[0].includes('limit=3'));
  assert.ok(!server.requests[0].includes('before='));
  assert.ok(server.requests[1].includes('before=key-5'), server.requests[1]);
  assert.equal(db.stats().battles, 8);
  db.close();
});

test('страница из одних известных боёв останавливает листание', async () => {
  const db = new Db(tmpDir());
  const all = Array.from({ length: 9 }, (_, i) => srv(i));
  const server = fakeServer({ 1: all });
  const { pull } = puller(server, db);
  pull.signedIn();
  await pull.pull();
  server.requests.length = 0;

  // Сыграли два боя на другом компьютере.
  all.push(srv(20), srv(21));
  const r = await pull.pull();
  assert.equal(r.inserted, 2);
  // Первая страница: 2 новых + 1 известный — листаем дальше; вторая — три
  // известных: стоп, хотя курсор дальше есть.
  assert.equal(server.requests.length, 2);
  assert.equal(r.stoppedBy, 'caught-up');

  server.requests.length = 0;
  const idle = await pull.pull();
  assert.equal(idle.inserted, 0);
  assert.equal(server.requests.length, 1, 'ничего нового — один запрос');
  db.close();
});

test('бои, записанные здесь и отправленные, не тянутся второй раз', async () => {
  const db = new Db(tmpDir());
  for (let i = 0; i < 3; i++) {
    const id = db.saveBattle(snapshot(), { startedAt: T0 + i * 3600 * 1000 });
    db.setBattleKey(id, `key-${i}`);
  }
  const server = fakeServer({ 1: [srv(0), srv(1), srv(2)] });
  const { pull } = puller(server, db);
  pull.signedIn();
  const r = await pull.pull();
  assert.equal(r.inserted, 0);
  assert.equal(r.stoppedBy, 'caught-up');
  assert.equal(db.stats().battles, 3);
  db.close();
});

test('листание не бесконечно, даже если сервер зациклился', async () => {
  const db = new Db(tmpDir());
  let n = 0;
  const account = {
    isSignedIn: true,
    state: () => ({ login: 'alpha' }),
    async request() {
      n += 1;
      return { account_id: 1, battles: [srv(1000 + n), srv(2000 + n), srv(3000 + n)], next_before: 'same' };
    },
  };
  const pull = new HistoryPull(account, db, { sleep: async () => {}, pageSize: 3, maxPages: 4 });
  const r = await pull.pull();
  assert.equal(n, 4);
  assert.equal(r.stoppedBy, 'max-pages');
  db.close();
});

test('правило остановки', () => {
  assert.equal(stopAfter({ battles: [], next_before: null }, { known: 0, invalid: 0 }), 'end');
  assert.equal(stopAfter({ battles: [1, 2], next_before: 'c' }, { known: 2, invalid: 0 }), 'caught-up');
  assert.equal(stopAfter({ battles: [1, 2], next_before: 'c' }, { known: 1, invalid: 1 }), 'caught-up');
  assert.equal(stopAfter({ battles: [1, 2], next_before: 'c' }, { known: 1, invalid: 0 }), null);
  assert.equal(stopAfter({ battles: [1, 2], next_before: null }, { known: 0, invalid: 0 }), 'end');
});

test('два нажатия подряд — одно листание', async () => {
  const db = new Db(tmpDir());
  const server = fakeServer({ 1: [srv(0)] });
  const { pull } = puller(server, db);
  const [a, b] = await Promise.all([pull.pull(), pull.pull()]);
  assert.equal(a, b);
  assert.equal(server.requests.length, 1);
  db.close();
});

test('ошибка сети не трогает локальную историю', async () => {
  const db = new Db(tmpDir());
  db.saveBattle(snapshot(), { startedAt: T0 });
  const server = fakeServer({});
  server.fail = Object.assign(new Error('нет связи с сервером'), { offline: true });
  const { pull } = puller(server, db);
  await assert.rejects(pull.pull(), /нет связи/);
  assert.equal(pull.last.error, 'нет связи с сервером');
  assert.equal(db.stats().battles, 1);
  db.close();
});

// --- Без входа ----------------------------------------------------------------

test('без входа сервер не спрашивается', async () => {
  const db = new Db(tmpDir());
  const server = fakeServer({ 1: [srv(0)] });
  server.isSignedIn = false;
  const { pull } = puller(server, db);
  const r = await pull.pull();
  assert.deepEqual(r, { skipped: 'signed-out' });
  assert.equal(server.requests.length, 0);
  assert.equal(db.stats().battles, 0);
  db.close();
});

test('выход посреди листания обрывает его, и пришедшая страница не пишется', async () => {
  const db = new Db(tmpDir());
  const server = fakeServer({ 1: Array.from({ length: 6 }, (_, i) => srv(i)) });
  const { pull } = puller(server, db);
  pull.signedIn();
  server.hold = async () => {
    // Ответ уже в пути, а человек нажал «Выйти».
    server.isSignedIn = false;
    pull.signedOut();
  };
  const r = await pull.pull();
  assert.equal(r.stoppedBy, 'signed-out');
  assert.equal(r.inserted, 0);
  assert.equal(db.stats().battles, 0);
  db.close();
});

test('выход ничего не удаляет и не прячет', async () => {
  const db = new Db(tmpDir());
  const server = fakeServer({ 1: [srv(0), srv(1)] });
  const { pull } = puller(server, db);
  pull.signedIn();
  await pull.pull();
  server.isSignedIn = false;
  pull.signedOut();
  assert.equal(db.stats().battles, 2);
  assert.equal(db.searchBattles().rows.length, 2);
  db.close();
});

// --- Смена аккаунта -----------------------------------------------------------

test('другой аккаунт на этой машине не видит чужой истории, и она к нему возвращается', async () => {
  const db = new Db(tmpDir());
  // Бой, записанный здесь, — история компьютера: видна всем, как и до 1.0.4.
  db.saveBattle(snapshot(), { startedAt: T0 - 10 * DAY });
  const server = fakeServer({
    1: [srv(0, { key: 'a-0' }), srv(1, { key: 'a-1' })],
    2: [srv(5, { key: 'b-5' })],
  });
  const { pull } = puller(server, db);

  // Вошёл alpha.
  pull.signedIn();
  await pull.pull();
  assert.deepEqual(visibleKeys(db), ['a-0', 'a-1']);
  assert.equal(db.stats().battles, 3);

  // alpha вышел — его история остаётся на экране.
  pull.signedOut();
  assert.deepEqual(visibleKeys(db), ['a-0', 'a-1']);

  // Вошёл beta, первый раз на этой машине: истории alpha в его статистике нет
  // с первой секунды, ещё до ответа сервера.
  server.login = 'beta';
  pull.signedIn();
  assert.deepEqual(visibleKeys(db), []);
  assert.equal(db.stats().battles, 1);
  assert.equal(db.stats().hidden, 2);
  await pull.pull();
  assert.deepEqual(visibleKeys(db), ['b-5']);
  assert.equal(db.searchBattles().summary.battles, 2, 'свой бой с сервера + записанный здесь');
  assert.equal(db.winrate().total, 2);

  // Вернулся alpha — его бои снова на месте сразу (номер уже известен), а
  // beta спрятан. Ничего не удалялось.
  server.login = 'alpha';
  pull.signedIn();
  assert.deepEqual(visibleKeys(db), ['a-0', 'a-1']);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM battles').get().n, 4);
  db.close();
});

test('общий бой двух аккаунтов хранится у каждого свой, и отметка одного не трогает другого', async () => {
  const db = new Db(tmpDir());
  const shared = { key: 'same', start: T0 };
  const server = fakeServer({
    1: [srv(0, { ...shared, trust: 'pending' })],
    // beta был в том же бою, но записал его на своём компьютере на пару
    // секунд позже.
    2: [srv(0, { key: 'same', start: T0 + 2000, trust: 'pending' })],
  });
  const { pull } = puller(server, db);
  pull.signedIn();
  await pull.pull();
  server.login = 'beta';
  pull.signedIn();
  await pull.pull();
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM battles WHERE server_key = 'same'").get().n, 2);

  // Сверка под входом beta меняет только его запись.
  assert.deepEqual(db.battleKeysToRefresh(), ['same']);
  db.applyTrust([{ battle_key: 'same', trust: 'confirmed' }]);
  const rows = db.db.prepare('SELECT owner_id, trust FROM battles ORDER BY owner_id').all();
  assert.deepEqual(rows.map((r) => [r.owner_id, r.trust]), [[1, 'pending'], [2, 'confirmed']]);
  db.close();
});

test('чьи бои на экране — переживает перезапуск', async () => {
  const dir = tmpDir();
  const db = new Db(dir);
  const server = fakeServer({ 1: [srv(0)], 2: [srv(1)] });
  const { pull } = puller(server, db);
  pull.signedIn();
  await pull.pull();
  server.login = 'beta';
  pull.signedIn();
  await pull.pull();
  db.close();

  const again = new Db(dir);
  assert.equal(again.viewer(), 2);
  assert.equal(again.ownerForLogin('BETA'), 2, 'логин без учёта регистра');
  assert.equal(again.stats().battles, 1);
  again.close();
});

// --- Счётчики -------------------------------------------------------------------

test('бои с сервера не попадают в «с запуска», а в «сегодня» — по дате', () => {
  const db = new Db(tmpDir());
  db.setViewer(1);
  db.startSession();
  const now = Date.now();
  db.mergeServerBattles(
    [
      // Сыгран сегодня до запуска программы — на другом компьютере.
      srv(0, { start: Math.max(now - 60_000, new Date(now).setHours(0, 0, 0, 0)) }),
      // Сыгран месяц назад.
      srv(1, { start: now - 40 * DAY }),
    ],
    1
  );
  const c = db.counters();
  assert.equal(c.session.battles, 0, '«с запуска» — только записанное здесь после запуска');
  assert.equal(c.today.battles, 1);
  assert.equal(c.year.battles >= 1, true);

  // Ручной сброс «за сегодня» отсекает и пришедшее раньше сброса.
  db.resetCounter('today');
  db.saveBattle(snapshot(), { startedAt: Date.now() });
  assert.equal(db.counters().today.battles, 1);
  db.close();
});

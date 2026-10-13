'use strict';

// Игра «закрылась» посреди загрузки боя.
//
// Жалоба владельца: с настройкой «Спрятать программу, когда игра закрыта»
// окно исчезало при переходе из ангара в бой. Причина — на загрузке карты
// веб-сервер игры молчит по десять-двадцать секунд, а программа считала игру
// закрытой уже после трёх неудачных опросов подряд. Тесты ниже воспроизводят
// загрузочный экран подставным сервером, который на время «загрузки»
// перестаёт отвечать, и часами, которые двигает сам тест.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { WtClient, OFFLINE_GRACE_MS, OFFLINE_AFTER } = require('../src/main/wt-client');
const rules = require('../src/main/window-rules');

/**
 * Подставная игра с режимами: 'hangar' — valid=false, 'battle' — valid=true,
 * 'loading' — сервер отвечает 503 (так выглядит занятая загрузкой игра для
 * нашего клиента: ответа с данными нет), 'closed' — соединение сразу рвётся.
 */
async function fakeGame() {
  const game = { mode: 'hangar' };
  const server = http.createServer((req, res) => {
    if (game.mode === 'closed') {
      req.socket.destroy();
      return;
    }
    if (game.mode === 'loading') {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const valid = game.mode === 'battle';
    if (req.url.startsWith('/map_info')) {
      res.end(JSON.stringify({ valid, map_generation: 1, grid_zero: [0, 0] }));
    } else if (req.url.startsWith('/mission')) {
      res.end(JSON.stringify({ status: valid ? 'running' : 'success' }));
    } else if (req.url.startsWith('/hudmsg')) {
      res.end(JSON.stringify({ events: [], damage: [] }));
    } else if (req.url.startsWith('/gamechat')) {
      res.end('[]');
    } else {
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { game, server, port: server.address().port };
}

/** Клиент на подставных часах: время двигает тест, а не setTimeout. */
function clientOn(port, opts = {}) {
  const clock = { t: 1_000_000 };
  const client = new WtClient({ host: '127.0.0.1', port, now: () => clock.t, ...opts });
  const statuses = [];
  client.on('status', (s) => statuses.push(s.status));
  return { client, clock, statuses };
}

/** Опрашивает n раз, сдвигая часы на шаг перед каждым опросом. */
async function poll(client, clock, n, stepMs = 1000) {
  for (let i = 0; i < n; i++) {
    clock.t += stepMs;
    await client.tick();
  }
}

test('загрузка карты ангар → бой не считается закрытой игрой', async (t) => {
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  const { client, clock, statuses } = clientOn(port);

  await poll(client, clock, 2);
  assert.equal(client.status, 'idle');

  // Пятнадцать секунд загрузочного экрана — куда больше трёх опросов.
  game.mode = 'loading';
  await poll(client, clock, 15);
  assert.equal(client.status, 'idle', 'за время загрузки игра не «закрылась»');

  game.mode = 'battle';
  await poll(client, clock, 1);
  assert.equal(client.status, 'battle');
  assert.ok(!statuses.includes('offline'), `offline не должно было быть: ${statuses}`);
});

test('загрузка бой → ангар тоже не прячет окно', async (t) => {
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  const { client, clock, statuses } = clientOn(port);

  game.mode = 'battle';
  await poll(client, clock, 2);
  game.mode = 'loading';
  await poll(client, clock, 12);
  game.mode = 'hangar';
  await poll(client, clock, 1);
  assert.deepEqual(statuses, ['battle', 'idle']);
});

test('разорванные соединения на загрузке — тоже не выход из игры', async (t) => {
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  const { client, clock } = clientOn(port);

  await poll(client, clock, 1);
  game.mode = 'closed';
  await poll(client, clock, 10);
  assert.equal(client.status, 'idle');
});

test('настоящий выход из игры замечается после порога', async (t) => {
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  const { client, clock, statuses } = clientOn(port);

  await poll(client, clock, 1);
  game.mode = 'closed';
  // Шагами по секунде: до порога — ещё «в ангаре», после — «не запущена».
  await poll(client, clock, Math.floor(OFFLINE_GRACE_MS / 1000) - 1);
  assert.equal(client.status, 'idle');
  await poll(client, clock, 2);
  assert.equal(client.status, 'offline');
  assert.equal(statuses.at(-1), 'offline');
});

test('одной долгой паузы мало: нужны и несколько неудач подряд', async (t) => {
  // Компьютер уснул на минуту — первый же опрос после сна упал. Это одна
  // неудача, а не молчащая игра.
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  const { client, clock } = clientOn(port);

  await poll(client, clock, 1);
  game.mode = 'closed';
  await poll(client, clock, 1, 60_000);
  assert.equal(client.status, 'idle');
  await poll(client, clock, OFFLINE_AFTER - 1, 60_000);
  assert.equal(client.status, 'offline');
});

test('удачный ответ посреди полосы неудач начинает отсчёт заново', async (t) => {
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  const { client, clock } = clientOn(port);

  await poll(client, clock, 1);
  for (let round = 0; round < 4; round++) {
    // По десять секунд молчания с короткими ответами между ними: в сумме
    // сорок секунд «неудач», но ни одна полоса не длиннее порога.
    game.mode = 'loading';
    await poll(client, clock, 10);
    game.mode = 'hangar';
    await poll(client, clock, 1);
  }
  assert.equal(client.status, 'idle');
});

test('без игры при запуске статус остаётся «не запущена»', async (t) => {
  const { game, server, port } = await fakeGame();
  t.after(() => server.close());
  game.mode = 'closed';
  const { client, clock, statuses } = clientOn(port);
  await poll(client, clock, 3);
  assert.equal(client.status, 'offline');
  assert.deepEqual(statuses, [], 'переходов не было: игра так и не появилась');
});

test('опросы не накладываются друг на друга', async (t) => {
  // Таймаут запроса длиннее интервала опроса. Раньше два тика шли
  // одновременно, и неудачи копились вдвое быстрее.
  const { server, port } = await fakeGame();
  t.after(() => server.close());
  const client = new WtClient({ host: '127.0.0.1', port });
  let inFlight = 0;
  let maxInFlight = 0;
  client.tick = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2500));
    inFlight--;
  };
  client.start();
  await new Promise((r) => setTimeout(r, 3200));
  client.stop();
  assert.equal(maxInFlight, 1);
});

// --- Отложенное скрытие окна ----------------------------------------------

/** Таймеры, которыми управляет тест. */
function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    fire() {
      for (const [id, { fn }] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    get count() {
      return timers.size;
    },
  };
}

test('окно прячется только если игра так и не вернулась', () => {
  const timers = fakeTimers();
  let hidden = 0;
  const delay = new rules.HideDelay({ hide: () => hidden++, ...timers });

  delay.apply('hide', 'offline');
  assert.equal(hidden, 0, 'сразу не прячем');
  assert.ok(delay.pending);
  timers.fire();
  assert.equal(hidden, 1);
  assert.ok(!delay.pending);
});

test('игра вернулась за время ожидания — окно остаётся', () => {
  const timers = fakeTimers();
  let hidden = 0;
  const delay = new rules.HideDelay({ hide: () => hidden++, ...timers });

  delay.apply('hide', 'offline');
  delay.apply(null, 'battle');
  timers.fire();
  assert.equal(hidden, 0);
  assert.equal(timers.count, 0);
});

test('повторный сигнал «спрятать» не заводит второй таймер', () => {
  const timers = fakeTimers();
  let hidden = 0;
  const delay = new rules.HideDelay({ hide: () => hidden++, ...timers });
  delay.apply('hide', 'offline');
  delay.apply('hide', 'offline');
  assert.equal(timers.count, 1);
  timers.fire();
  assert.equal(hidden, 1);
});

test('пока игра не вернулась, «не запущена» ожидание не отменяет', () => {
  const timers = fakeTimers();
  let hidden = 0;
  const delay = new rules.HideDelay({ hide: () => hidden++, ...timers });
  delay.apply('hide', 'offline');
  delay.apply(null, 'offline');
  timers.fire();
  assert.equal(hidden, 1);
});

test('переход ангар ↔ бой окно не прячет и при включённой настройке', () => {
  const all = { showOnGameStart: true, hideOnGameExit: true };
  // Именно эти переходы и случаются на загрузке карты.
  for (const [a, b] of [
    ['idle', 'battle'],
    ['battle', 'idle'],
  ]) {
    assert.equal(rules.onGameStatus(a, b, all), null, `${a} → ${b}`);
  }
});

test('по умолчанию ожидание перед скрытием — несколько секунд', () => {
  assert.ok(rules.HIDE_DELAY_MS >= 5000);
  // Порог «игра закрыта» в клиенте — дольше типичной загрузки карты.
  assert.ok(OFFLINE_GRACE_MS >= 15_000);
});

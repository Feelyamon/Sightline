'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WtClient } = require('../src/main/wt-client');

/**
 * Поднимает подставной сервер вместо игры. Журнал задаётся снаружи, чтобы
 * воспроизвести скользящее окно и стык боёв — то, на чём ломалась смена боя.
 */
function fakeGame(getDamage, isValid = () => true) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/map_info')) {
      res.end(JSON.stringify({ valid: isValid(), map_generation: 1, grid_zero: [0, 0] }));
    } else if (req.url.startsWith('/mission')) {
      res.end(JSON.stringify({ status: isValid() ? 'running' : 'success' }));
    } else if (req.url.startsWith('/hudmsg')) {
      res.end(JSON.stringify({ events: [], damage: getDamage() }));
    } else {
      res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// На первом тике клиент всегда сообщает о начале боя (переход «ангар → бой»),
// поэтому в тестах считаем сбросы уже после него.
test('id сквозные по сессии: новый бой ловится по падению time', async (t) => {
  let log = [
    { id: 100, time: 600, msg: 'A (Т-80) уничтожил B (M1A2)' },
    { id: 101, time: 640, msg: 'A (Т-80) уничтожил C (M1A2)' },
  ];
  const server = await fakeGame(() => log);
  t.after(() => server.close());
  const { port } = server.address();

  const client = new WtClient({ host: '127.0.0.1', port });
  const seen = [];
  let resets = 0;
  client.on('damage', (d) => seen.push(d.id));
  client.on('reset', () => resets++);

  await client.tick();
  assert.deepEqual(seen, [100, 101]);
  const baseline = resets;

  // Следующий бой: id продолжают расти, а time начинается заново.
  log = log.concat([
    { id: 102, time: 30, msg: 'D (Leopard) уничтожил E (Т-72)' },
    { id: 103, time: 45, msg: 'D (Leopard) уничтожил F (Т-72)' },
  ]);
  await client.tick();

  assert.equal(resets - baseline, 1, 'падение time трактуется как новый бой');
  assert.deepEqual(seen, [100, 101, 102, 103]);
});

test('скользящее окно не вызывает ложных сбросов', async (t) => {
  let log = [
    { id: 200, time: 100, msg: 'A (Т-80) уничтожил B (M1A2)' },
    { id: 201, time: 110, msg: 'A (Т-80) уничтожил C (M1A2)' },
  ];
  const server = await fakeGame(() => log);
  t.after(() => server.close());
  const { port } = server.address();

  const client = new WtClient({ host: '127.0.0.1', port });
  let resets = 0;
  client.on('reset', () => resets++);

  await client.tick();
  const baseline = resets;

  // Старые записи вытеснены из окна, бой тот же самый.
  log = [
    { id: 201, time: 110, msg: 'A (Т-80) уничтожил C (M1A2)' },
    { id: 202, time: 130, msg: 'A (Т-80) уничтожил D (M1A2)' },
  ];
  await client.tick();

  assert.equal(resets - baseline, 0, 'сдвиг окна — не новый бой');
});

test('выход в ангар не сбрасывает таблицу — сброс только на старте нового боя', async (t) => {
  const log = [
    { id: 400, time: 100, msg: 'A (Т-80) уничтожил B (M1A2)' },
    { id: 401, time: 120, msg: 'A (Т-80) уничтожил C (M1A2)' },
  ];
  let inBattle = true;
  const server = await fakeGame(() => log, () => inBattle);
  t.after(() => server.close());
  const { port } = server.address();

  const client = new WtClient({ host: '127.0.0.1', port });
  let resets = 0;
  const statuses = [];
  client.on('reset', () => resets++);
  client.on('status', (s) => statuses.push(s.status));

  await client.tick();
  const baseline = resets;

  // Ушли в ангар: состояние прошлого боя должно остаться на экране.
  inBattle = false;
  await client.tick();
  await client.tick();
  assert.equal(resets - baseline, 0, 'в ангаре таблица не сбрасывается');
  assert.equal(statuses.at(-1), 'idle');

  // Начался следующий бой — вот теперь сброс.
  inBattle = true;
  await client.tick();
  assert.equal(resets - baseline, 1, 'сброс происходит на старте нового боя');
});

test('запуск посреди сессии не втягивает предыдущий бой', async (t) => {
  const log = [
    { id: 300, time: 500, msg: 'Old1 (Т-80) уничтожил Old2 (M1A2)' },
    { id: 301, time: 640, msg: 'Old1 (Т-80) уничтожил Old3 (M1A2)' },
    { id: 302, time: 20, msg: 'New1 (Leopard) уничтожил New2 (Т-72)' },
    { id: 303, time: 40, msg: 'New1 (Leopard) уничтожил New3 (Т-72)' },
  ];
  const server = await fakeGame(() => log);
  t.after(() => server.close());
  const { port } = server.address();

  const client = new WtClient({ host: '127.0.0.1', port });
  const seen = [];
  client.on('damage', (d) => seen.push(d.id));

  await client.tick();
  assert.deepEqual(seen, [302, 303], 'записи прошлого боя пропущены');
});

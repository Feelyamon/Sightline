'use strict';

// Отправка боёв на сервер: что уходит, когда и сколько за раз.
//
// Требование владельца: бой, записанный без входа, не уходит на сервер никогда;
// вход в аккаунт не выгружает накопленную историю; после входа бои уходят по
// одному, в обычном темпе — по мере того, как кончаются. Каждый тест ниже
// проверяет одно из этих обещаний на настоящем классе Sync с подставным
// аккаунтом: сеть не нужна, а очередь лежит в настоящем файле.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Sync, canUpload, battlePayload, PER_REQUEST, MAX_QUEUE } = require('../src/main/sync');

/** Аккаунт без сети: запоминает каждый запрос и отвечает как сервер. */
function fakeAccount({ signedIn = false } = {}) {
  const account = {
    isSignedIn: signedIn,
    posts: [],
    trustAsks: 0,
    fail: null,
    hold: null,
    async request(route, opts) {
      if (account.fail) throw account.fail;
      if (route === '/battles') {
        account.posts.push(opts.body);
        if (account.hold) await account.hold;
        return {
          accepted: opts.body.length,
          results: opts.body.map((b) => ({ battle_key: `key-${b.started_at}`, status: 'accepted' })),
        };
      }
      if (route === '/battles/trust') {
        account.trustAsks++;
        return [];
      }
      throw new Error(`неожиданный запрос ${route}`);
    },
  };
  return account;
}

/** База боёв, от которой Sync нужны три метода. */
function fakeDb() {
  return {
    keys: new Map(),
    setBattleKey(id, key) {
      this.keys.set(id, key);
    },
    battleKeysToRefresh: () => [],
    applyTrust: () => 0,
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-sync-'));

/** Таймер, который тест крутит сам: «прошла минута» — это tick(). */
function manualTimer() {
  const timer = { fn: null };
  return {
    timer,
    opts: {
      setTimer: (fn) => {
        timer.fn = fn;
        return 1;
      },
      clearTimer: () => {
        timer.fn = null;
      },
    },
  };
}

let seq = 0;
/** Бой с уникальным временем начала — по нему очередь узнаёт «тот же бой». */
function payload(extra = {}) {
  seq += 1;
  return {
    started_at: new Date(Date.UTC(2026, 9, 13, 12, 0, seq)).toISOString(),
    ended_at: new Date(Date.UTC(2026, 9, 13, 12, 10, seq)).toISOString(),
    players: [{ nick: `P${seq}` }],
    ...extra,
  };
}

/** Дождаться, пока отработают обещания, запущенные синхронным вызовом. */
const settle = () => new Promise((r) => setImmediate(r));

function setup({ signedIn = false, dir = tmp() } = {}) {
  const account = fakeAccount({ signedIn });
  const db = fakeDb();
  const { timer, opts } = manualTimer();
  const sync = new Sync(dir, account, db, opts);
  return { account, db, sync, timer, dir };
}

/** Войти так, как это делает main: сессия у аккаунта, затем у Sync. */
function signIn(env) {
  env.account.isSignedIn = true;
  env.sync.beginSession();
}

// --- Правило целиком ------------------------------------------------------

test('правило: отправляется только бой, начатый в текущей сессии входа', () => {
  assert.equal(canUpload({ session: 'a' }, { session: 'a', signedIn: true }), true);
  // Начат гостем.
  assert.equal(canUpload({ session: null }, { session: 'a', signedIn: true }), false);
  // Начат в прошлой сессии (вышел и вошёл снова).
  assert.equal(canUpload({ session: 'a' }, { session: 'b', signedIn: true }), false);
  // Сейчас входа нет.
  assert.equal(canUpload({ session: 'a' }, { session: 'a', signedIn: false }), false);
  assert.equal(canUpload(null, { session: 'a', signedIn: true }), false);
  assert.equal(canUpload(undefined, undefined), false);
});

// --- Гостевые бои ---------------------------------------------------------

test('бой гостя не попадает в очередь и не уходит на сервер', async () => {
  const env = setup();
  const rec = env.sync.recording();
  assert.equal(rec.session, null);
  assert.equal(env.sync.isGuest(rec), true);

  assert.equal(env.sync.enqueue(1, payload(), rec), false);
  await env.sync.flush();
  assert.equal(env.sync.queue.size, 0);
  assert.deepEqual(env.account.posts, []);
});

test('бой, начатый гостем, остаётся гостевым и после входа', async () => {
  const env = setup();
  const rec = env.sync.recording(); // начало боя — без входа
  signIn(env); // вошёл посреди боя

  assert.equal(env.sync.isGuest(rec), true);
  assert.equal(env.sync.enqueue(7, payload(), rec), false);
  env.timer.fn?.();
  await settle();
  assert.deepEqual(env.account.posts, []);
});

test('гостевые бои не уходят никогда: ни при входе, ни потом', async () => {
  const env = setup();
  for (let id = 1; id <= 20; id++) env.sync.enqueue(id, payload(), env.sync.recording());
  signIn(env);
  env.sync.start();
  for (let i = 0; i < 30; i++) {
    env.timer.fn?.();
    await settle();
  }
  assert.deepEqual(env.account.posts, [], 'на сервер не ушло ни одного гостевого боя');
});

test('бой, во время которого человек вышел, тоже остаётся локальным', async () => {
  const env = setup({ signedIn: true });
  env.sync.beginSession();
  const rec = env.sync.recording();
  assert.equal(env.sync.isGuest(rec), false);

  env.account.isSignedIn = false;
  env.sync.endSession();
  assert.equal(env.sync.isGuest(rec), true);
  assert.equal(env.sync.enqueue(3, payload(), rec), false);
});

test('вышел и вошёл снова посреди боя — бой всё равно не уходит', async () => {
  const env = setup({ signedIn: true });
  env.sync.beginSession();
  const rec = env.sync.recording();
  env.account.isSignedIn = false;
  env.sync.endSession();
  signIn(env);
  assert.equal(env.sync.isGuest(rec), true, 'сессия уже другая');
  assert.equal(env.sync.enqueue(3, payload(), rec), false);
});

// --- Вход не выгружает историю --------------------------------------------

test('вход в аккаунт не запускает выгрузку накопленного', async () => {
  const dir = tmp();
  // Очередь, оставшаяся с прошлой сессии: человек играл под входом без
  // сети, потом вышел. Файл пишем руками в нынешнем формате.
  fs.writeFileSync(
    path.join(dir, 'outbox.json'),
    JSON.stringify({
      format: 2,
      session: 'old',
      items: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, session: 'old', payload: payload() })),
    })
  );
  const env = setup({ dir });
  signIn(env);
  env.sync.start();
  await settle();
  env.timer.fn?.();
  await settle();

  assert.deepEqual(env.account.posts, [], 'после входа ничего из старого не ушло');
  assert.equal(env.sync.queue.size, 0);
});

test('очередь старого формата (до 1.0.2) не отправляется', async () => {
  const dir = tmp();
  // Именно так очередь лежала в 1.0.1: массив [id, бой] без отметки сессии.
  fs.writeFileSync(
    path.join(dir, 'outbox.json'),
    JSON.stringify(Array.from({ length: 60 }, (_, i) => [i + 1, payload()]))
  );
  const account = fakeAccount({ signedIn: true });
  const { timer, opts } = manualTimer();
  const sync = new Sync(dir, account, fakeDb(), opts);
  sync.start();
  await settle();
  timer.fn?.();
  await settle();

  assert.equal(sync.queue.size, 0);
  assert.deepEqual(account.posts, []);
  // И файл переписан в новом формате: при следующем запуске старое не
  // всплывёт снова.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'outbox.json'), 'utf8'));
  assert.equal(saved.format, 2);
  assert.deepEqual(saved.items, []);
});

test('вход обнуляет очередь, даже если в ней были бои этой же учётки', () => {
  const env = setup({ signedIn: true });
  env.sync.beginSession();
  env.account.fail = Object.assign(new Error('нет сети'), { offline: true });
  env.sync.enqueue(1, payload(), env.sync.recording());
  assert.equal(env.sync.queue.size, 1);

  // Вышел, вошёл снова — та же учётка, но уже другая сессия.
  env.account.isSignedIn = false;
  env.sync.endSession();
  assert.equal(env.sync.queue.size, 0, 'выход обнуляет очередь');
  signIn(env);
  assert.equal(env.sync.queue.size, 0);
});

test('выход другим путём (сервер закрыл сессию) тоже обнуляет очередь', () => {
  const env = setup({ signedIn: true });
  env.sync.beginSession();
  env.account.fail = new Error('нет сети');
  env.sync.enqueue(1, payload(), env.sync.recording());
  env.sync.endSession();
  const saved = JSON.parse(fs.readFileSync(env.sync.file, 'utf8'));
  assert.equal(saved.session, null);
  assert.deepEqual(saved.items, []);
});

// --- После входа — по одному ----------------------------------------------

test('после входа бой уходит сразу по окончании, один запрос — один бой', async () => {
  const env = setup();
  signIn(env);
  const rec = env.sync.recording();
  const p = payload();
  assert.equal(env.sync.enqueue(10, p, rec), true);
  await settle();

  assert.equal(env.account.posts.length, 1);
  assert.equal(env.account.posts[0].length, 1);
  assert.deepEqual(env.account.posts[0][0], p);
  assert.equal(env.db.keys.get(10), `key-${p.started_at}`);
  assert.equal(env.sync.queue.size, 0);
});

test('несколько боёв подряд уходят по одному, каждый своим запросом', async () => {
  const env = setup();
  signIn(env);
  for (let id = 1; id <= 5; id++) {
    env.sync.enqueue(id, payload(), env.sync.recording());
    await settle();
  }
  assert.equal(env.account.posts.length, 5);
  for (const body of env.account.posts) assert.equal(body.length, 1);
});

test('накопившееся без сети разбирается по одному бою за тик', async () => {
  const env = setup();
  signIn(env);
  env.account.fail = Object.assign(new Error('нет сети'), { offline: true });
  for (let id = 1; id <= 4; id++) env.sync.enqueue(id, payload(), env.sync.recording());
  await settle();
  assert.equal(env.sync.queue.size, 4);

  env.account.fail = null;
  env.sync.start(); // таймер плюс первая попытка сразу
  await settle();
  assert.equal(env.account.posts.length, 1, 'первая попытка — один бой');
  for (let tick = 2; tick <= 4; tick++) {
    env.timer.fn();
    await settle();
    assert.equal(env.account.posts.length, tick, `тик ${tick} — ещё один бой`);
  }
  assert.ok(env.account.posts.every((b) => b.length === PER_REQUEST));
  assert.equal(env.sync.queue.size, 0);
});

test('пока идёт запрос, второй не начинается', async () => {
  const env = setup();
  signIn(env);
  let release;
  env.account.hold = new Promise((r) => (release = r));
  env.sync.enqueue(1, payload(), env.sync.recording());
  env.sync.enqueue(2, payload(), env.sync.recording());
  env.sync.flush();
  env.sync.flush();
  await settle();
  assert.equal(env.account.posts.length, 1);
  release();
  await settle();
});

test('один и тот же бой, записанный дважды, уходит один раз', async () => {
  // Бой перезаписывается при выходе в ангар и ещё раз в начале следующего —
  // и у строки в базе каждый раз новый id.
  const env = setup();
  signIn(env);
  env.account.fail = new Error('нет сети');
  const rec = env.sync.recording();
  const p = payload();
  env.sync.enqueue(10, p, rec);
  env.sync.enqueue(11, { ...p, my_kills: 3 }, rec);
  assert.equal(env.sync.queue.size, 1);
  assert.deepEqual([...env.sync.queue.keys()], [11], 'осталась последняя версия');
});

test('ответ пришёл после выхода — отметки в базу не пишутся', async () => {
  const env = setup();
  signIn(env);
  let release;
  env.account.hold = new Promise((r) => (release = r));
  env.sync.enqueue(5, payload(), env.sync.recording());
  await settle();
  env.account.isSignedIn = false;
  env.sync.endSession();
  release();
  await settle();
  assert.equal(env.db.keys.size, 0);
});

test('устаревшая сборка останавливает отправку', async () => {
  const env = setup();
  signIn(env);
  env.sync.start();
  env.account.fail = Object.assign(new Error('обновитесь'), { status: 426 });
  env.sync.enqueue(1, payload(), env.sync.recording());
  await settle();
  assert.equal(env.timer.fn, null, 'таймер снят');
  assert.equal(env.sync.queue.size, 1, 'бой не потерян');
});

test('очередь ограничена: при переполнении уходят самые старые', () => {
  const env = setup();
  signIn(env);
  env.account.fail = new Error('нет сети');
  for (let id = 1; id <= MAX_QUEUE + 5; id++) env.sync.enqueue(id, payload(), env.sync.recording());
  assert.equal(env.sync.queue.size, MAX_QUEUE);
  assert.equal(env.sync.queue.keys().next().value, 6);
});

// --- Перезапуск -----------------------------------------------------------

test('после перезапуска под тем же входом недоотправленное уходит', async () => {
  const env = setup();
  signIn(env);
  env.account.fail = new Error('нет сети');
  env.sync.enqueue(1, payload(), env.sync.recording());
  const session = env.sync.session;

  const account = fakeAccount({ signedIn: true });
  const { timer, opts } = manualTimer();
  const again = new Sync(env.dir, account, fakeDb(), opts);
  assert.equal(again.session, session, 'сессия пережила перезапуск');
  assert.equal(again.queue.size, 1);
  again.start();
  await settle();
  assert.equal(account.posts.length, 1);
  assert.equal(timer.fn !== null, true);
});

test('перезапуск без входа выбрасывает очередь', () => {
  const env = setup();
  signIn(env);
  env.account.fail = new Error('нет сети');
  env.sync.enqueue(1, payload(), env.sync.recording());

  const again = new Sync(env.dir, fakeAccount({ signedIn: false }), fakeDb(), manualTimer().opts);
  assert.equal(again.session, null);
  assert.equal(again.queue.size, 0);
});

test('испорченный файл очереди не роняет программу', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'outbox.json'), '{не json');
  const sync = new Sync(dir, fakeAccount({ signedIn: true }), fakeDb(), manualTimer().opts);
  assert.equal(sync.queue.size, 0);
  assert.ok(sync.session, 'вход сохранён — заведена новая сессия');
});

test('без входа flush ничего не отправляет и не падает', async () => {
  const env = setup();
  const state = await env.sync.flush();
  assert.deepEqual(state, { pending: 0, error: null });
});

// --- Что уходит -----------------------------------------------------------

test('в отправку идут только факты боя, без агрегатов', () => {
  const snapshot = {
    players: [
      { nick: 'Me', isSelf: true, team: 'ally', kills: 2, deaths: 1, assists: 1, sorties: [] },
      { nick: 'Foe', team: 'enemy', kills: 0, deaths: 2, assists: 0, status: 'left', sorties: [] },
    ],
  };
  const p = battlePayload(snapshot, { startedAt: 1000, endedAt: 61_000, result: 'win' });
  assert.equal(p.duration_sec, 60);
  assert.equal(p.my_kills, 2);
  assert.equal(p.players.length, 2);
  assert.equal(p.players[1].left_battle, true);
  for (const k of ['winrate', 'total_battles', 'kda']) assert.ok(!(k in p));
});

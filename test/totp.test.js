'use strict';

// Второй фактор при входе: шаг кода (totp_required) и обязательная настройка
// (totp_setup_required). Контракт — docs/totp-spec.md на сайте feelyamon.ru.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stubs/electron.js');
  return realResolve.call(this, request, ...rest);
};

const { Account, normalizeTotpCode, qrMatrix } = require('../src/main/account');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtvh-totp-'));
  return new Account(dir, { baseUrl: 'https://example.invalid/v1' });
}

/** Подменяет fetch на очередь ответов и запоминает, о чём спросили. */
function stubFetch(...replies) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const [status, body] = replies.length > 1 ? replies.shift() : replies[0];
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

const SESSION = {
  token: 'сессия',
  login: 'Username',
  role: 'admin',
  lang: 'ru',
  expires_at: '2027-01-01T00:00:00Z',
};

test('totp_required — следующий шаг, а не ошибка, и токен шага не уходит в окно', async () => {
  const account = fresh();
  const f = stubFetch(
    [401, { error: 'totp_required', totp_token: 'шаг', message: 'нужен код' }],
    [200, SESSION],
  );
  try {
    const result = await account.signIn({ login: 'Username', password: 'пароль12345' });
    assert.equal(result.step, 'totp');
    assert.equal(result.signedIn, false);
    assert.ok(!JSON.stringify(result).includes('шаг'), 'токен шага не должен попасть в окно');
    assert.equal(fs.existsSync(account.file), false, 'сессии ещё нет — и файла нет');

    const state = await account.signInTotp({ code: ' 123 456 ' });
    assert.match(f.calls[1].url, /\/auth\/login\/totp$/);
    assert.deepEqual(f.calls[1].body, { totp_token: 'шаг', code: '123456' });
    assert.equal(state.signedIn, true);
    assert.equal(state.isAdmin, true);
    assert.equal(account.session.token, 'сессия');
    assert.equal(account.pending, null);
  } finally {
    f.restore();
  }
});

test('неверный код оставляет шаг — можно ввести ещё раз', async () => {
  const account = fresh();
  const f = stubFetch(
    [401, { error: 'totp_required', totp_token: 'шаг' }],
    [401, { error: 'bad_totp', message: 'неверный код' }],
  );
  try {
    await account.signIn({ login: 'u', password: 'p' });
    await assert.rejects(account.signInTotp({ code: '000000' }), (e) => e.code === 'bad_totp');
    assert.equal(account.pending?.kind, 'totp');
  } finally {
    f.restore();
  }
});

test('резервный код уходит как набран, без краевых пробелов', async () => {
  assert.equal(normalizeTotpCode('  abcd-efgh '), 'abcd-efgh');
  assert.equal(normalizeTotpCode('12 34 56'), '123456');
  assert.equal(normalizeTotpCode(''), '');
});

test('без начатого входа шаг кода не отправляется', async () => {
  const account = fresh();
  const f = stubFetch([200, SESSION]);
  try {
    await assert.rejects(account.signInTotp({ code: '123456' }), (e) => e.code === 'no_pending_step');
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test('bad_totp у вошедшего не выкидывает из аккаунта', async () => {
  const account = fresh();
  account.applySession(SESSION);
  const f = stubFetch([401, { error: 'bad_totp', message: 'неверный код' }]);
  try {
    await assert.rejects(account.request('/auth/totp/confirm', { method: 'POST', body: {}, auth: true }));
    assert.equal(account.isSignedIn, true);
  } finally {
    f.restore();
  }
});

test('обязательная настройка: QR, подтверждение, резервные коды и сессия', async () => {
  const account = fresh();
  const uri = 'otpauth://totp/Feelyamon:%D0%90%D0%B4%D0%BC%D0%B8%D0%BD?secret=JBSWY3DPEHPK3PXP&issuer=Feelyamon';
  const codes = ['aaaa-bbbb', 'cccc-dddd', 'eeee-ffff', 'gggg-hhhh', 'iiii-jjjj', 'kkkk-llll', 'mmmm-nnnn', 'oooo-pppp'];
  const f = stubFetch(
    [403, { error: 'totp_setup_required', setup_token: 'настройка' }],
    [200, { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: uri }],
    [200, { ...SESSION, backup_codes: codes }],
  );
  try {
    const result = await account.signIn({ login: 'Username', password: 'пароль12345' });
    assert.equal(result.step, 'totp_setup');
    assert.equal(result.signedIn, false);

    const setup = await account.totpSetupForced();
    assert.deepEqual(f.calls[1].body, { setup_token: 'настройка' });
    assert.equal(setup.secret, 'JBSWY3DPEHPK3PXP');
    assert.ok(setup.qr.length >= 21);
    assert.ok(setup.qr.every((row) => row.length === setup.qr.length && /^[01]+$/.test(row)));

    const done = await account.totpConfirmForced({ code: '654 321' });
    assert.match(f.calls[2].url, /\/auth\/totp\/confirm-forced$/);
    assert.deepEqual(f.calls[2].body, { setup_token: 'настройка', code: '654321' });
    assert.deepEqual(done.backupCodes, codes);
    assert.equal(done.signedIn, true);
    assert.equal(account.session.token, 'сессия');
  } finally {
    f.restore();
  }
});

test('отмена шага забывает токен', async () => {
  const account = fresh();
  const f = stubFetch([401, { error: 'totp_required', totp_token: 'шаг' }]);
  try {
    await account.signIn({ login: 'u', password: 'p' });
    account.cancelPending();
    await assert.rejects(account.signInTotp({ code: '123456' }), (e) => e.code === 'no_pending_step');
  } finally {
    f.restore();
  }
});

test('восстановление пароля ведёт на тот же шаг кода', async () => {
  const account = fresh();
  const f = stubFetch([401, { error: 'totp_required', totp_token: 'шаг' }]);
  try {
    const result = await account.forcedPassword({
      login: 'Username',
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
      newPassword: 'новый12345',
    });
    assert.equal(result.step, 'totp');
    assert.equal(account.isSignedIn, false);
    assert.equal(account.pending.login, 'Username');
  } finally {
    f.restore();
  }
});

test('QR считается локально и переживает кириллицу', () => {
  const a = qrMatrix('otpauth://totp/Feelyamon:Админ?secret=JBSWY3DPEHPK3PXP');
  const b = qrMatrix('otpauth://totp/Feelyamon:Админ?secret=JBSWY3DPEHPK3PXP');
  assert.deepEqual(a, b);
  // Угловые метки поиска на месте — значит это действительно QR.
  assert.equal(a[0].slice(0, 7), '1111111');
  assert.equal(a[6].slice(0, 7), '1111111');
});

test('обычный вход без второго фактора работает как раньше', async () => {
  const account = fresh();
  const f = stubFetch([200, { ...SESSION, role: 'user' }]);
  try {
    const state = await account.signIn({ login: 'Username', password: 'пароль12345' });
    assert.equal(state.step, undefined);
    assert.equal(state.signedIn, true);
  } finally {
    f.restore();
  }
});

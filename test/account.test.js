'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// account.js тянет electron ради safeStorage, а под голым node его нет.
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stubs/electron.js');
  return realResolve.call(this, request, ...rest);
};

const { Account } = require('../src/main/account');

/** Аккаунт с уже открытой сессией, в своей папке: файл токена настоящий. */
function signedIn(session = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtvh-acc-'));
  const account = new Account(dir, { baseUrl: 'https://example.invalid/v1' });
  account.session = {
    token: 'старый',
    login: 'Username',
    role: 'admin',
    lang: 'ru',
    expiresAt: '2026-11-14T00:00:00Z',
    ...session,
  };
  account.save();
  return account;
}

/** Подменяет fetch на один заготовленный ответ и запоминает, о чём спросили. */
function stubFetch(status, body) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

test('смена пароля сохраняет новый токен и не теряет роль', async () => {
  const account = signedIn();
  const f = stubFetch(200, {
    recovery_code: 'AAAA-BBBB-CCCC-DDDD',
    token: 'новый',
    expires_at: '2027-01-01T00:00:00Z',
  });

  try {
    const state = await account.changePassword({ oldPassword: 'старый', newPassword: 'новый12345' });

    // Ответ сервера состоит из токена и кода — логина и роли в нём нет.
    // Переписать сессию этим ответом целиком значило бы стереть админа до
    // перезахода, а роль решает, видно ли вкладку «Админка».
    assert.equal(state.login, 'Username');
    assert.equal(state.role, 'admin');
    assert.equal(state.isAdmin, true);
    assert.equal(state.recoveryCode, 'AAAA-BBBB-CCCC-DDDD');

    // Сервер закрыл все сессии, включая нашу, и выдал взамен новую. Не
    // сохранить её — значит выбросить человека из аккаунта следующим запросом
    // сразу после того, как он сменил пароль.
    assert.equal(account.session.token, 'новый');
    assert.equal(account.session.expiresAt, '2027-01-01T00:00:00Z');

    const sent = JSON.parse(f.calls[0].opts.body);
    assert.deepEqual(sent, { old_password: 'старый', new_password: 'новый12345' });
    assert.match(f.calls[0].url, /\/auth\/password$/);
  } finally {
    f.restore();
  }
});

test('неверный текущий пароль оставляет сессию нетронутой', async () => {
  const account = signedIn();
  const f = stubFetch(401, { error: 'bad_credentials', message: 'неверный логин или пароль' });

  try {
    await assert.rejects(
      account.changePassword({ oldPassword: 'не тот', newPassword: 'новый12345' }),
      /неверный логин или пароль/,
    );
    // 401 здесь про пароль из формы, а не про токен. Выйти из аккаунта из-за
    // опечатки в поле — потерять человека на ровном месте.
    assert.equal(account.isSignedIn, true);
    assert.equal(account.session.token, 'старый');
  } finally {
    f.restore();
  }
});

test('протухший токен по-прежнему выкидывает из аккаунта', async () => {
  const account = signedIn();
  const f = stubFetch(401, { error: 'unauthorized', message: 'требуется вход' });

  try {
    await assert.rejects(account.request('/auth/me', { auth: true }), /требуется вход/);
    // Сессии на сервере больше нет — держать её в окне значит показывать вход,
    // которого не существует.
    assert.equal(account.isSignedIn, false);
  } finally {
    f.restore();
  }
});

test('выход со всех устройств закрывает и текущий вход', async () => {
  const account = signedIn();
  const f = stubFetch(200, { ok: true, closed: 3 });

  try {
    const state = await account.logoutAll();
    assert.equal(state.signedIn, false);
    assert.equal(state.closed, 3);
    assert.equal(account.session, null);
  } finally {
    f.restore();
  }
});

test('выход со всех устройств не выполняется молча, если сервер не ответил', async () => {
  const account = signedIn();
  const real = global.fetch;
  global.fetch = async () => { throw Object.assign(new Error('no'), { name: 'TypeError' }); };

  try {
    await assert.rejects(account.logoutAll(), /нет связи с сервером/);
    // Чужие сессии остались живыми. Выйти при этом у себя — соврать, что
    // просьбу выполнили: человек нажимал кнопку ради других устройств.
    assert.equal(account.isSignedIn, true);
  } finally {
    global.fetch = real;
  }
});

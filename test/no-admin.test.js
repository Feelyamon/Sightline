'use strict';

// Администрирование — только в панели администрации (с 1.0.3). Программа не
// зовёт /v1/admin/* ни при каких условиях: ни кнопок, ни IPC-каналов, ни
// мостика в окно, а сам account.request отказывает в таких маршрутах до сети.

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

const { Account, isAdminRoute } = require('../src/main/account');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Все файлы исходников программы (то, что уходит в сборку). */
function sources(dir = path.join(ROOT, 'src')) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(js|html|css|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

function adminAccount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtvh-noadm-'));
  const account = new Account(dir, { baseUrl: 'https://example.invalid/v1' });
  account.session = { token: 'т', login: 'Username', role: 'admin', lang: 'ru', expiresAt: '2099-01-01T00:00:00Z' };
  return account;
}

function stubFetch() {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => '{}' };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

test('в исходниках нет ни одного маршрута /admin', () => {
  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/['"`]\/admin(\/|\?|['"`])/.test(text), `${path.relative(ROOT, file)}: маршрут /admin`);
  }
});

test('нет IPC-каналов admin:* ни в main, ни в мостике', () => {
  for (const file of ['src/main/index.js', 'src/main/preload.js']) {
    assert.ok(!/['"`]admin:/.test(read(file)), file);
  }
});

test('мостик в окно не отдаёт window.wt.admin', () => {
  let exposed = null;
  const stub = require.resolve('./stubs/electron.js');
  const saved = require.cache[stub];
  require.cache[stub] = {
    id: stub, filename: stub, loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
      ipcRenderer: { invoke: async () => {}, on: () => {}, off: () => {} },
    },
  };
  try {
    delete require.cache[require.resolve('../src/main/preload.js')];
    require('../src/main/preload.js');
  } finally {
    if (saved) require.cache[stub] = saved;
    else delete require.cache[stub];
  }
  assert.ok(exposed, 'мостик выставлен');
  assert.equal('admin' in exposed, false);
  assert.ok('account' in exposed && 'friends' in exposed, 'остальное на месте');
});

test('в окне нет админки: ни вкладки, ни раздела, ни строк словаря', () => {
  const html = read('src/renderer/index.html');
  for (const id of ['tabAdmin', 'panel-admin', 'i-admin', 'data-tab="admin"']) assert.ok(!html.includes(id), id);
  const app = read('src/renderer/app.js');
  assert.ok(!/wt\.admin\b/.test(app), 'window.wt.admin');
  assert.ok(!/tabAdmin|refreshAdmin/.test(app));
  for (const loc of ['ru', 'en', 'zh']) {
    const keys = Object.keys(JSON.parse(read(`src/i18n/${loc}.json`)));
    assert.deepEqual(keys.filter((k) => k.startsWith('admin.') || k === 'tab.admin'), [], loc);
  }
});

test('isAdminRoute: /admin и всё под ним — да, похожее — нет', () => {
  const base = 'https://example.invalid/v1';
  for (const r of ['/admin', '/admin/', '/admin/users?q=a', '/admin/bugs/resolve', '/ADMIN/log', '/x/../admin/log', '/./admin']) {
    assert.equal(isAdminRoute(base, r), true, r);
  }
  for (const r of ['/auth/me', '/administrators', '/adminx', '/me/admin', '/bugs', '/version', '/friends?q=admin']) {
    assert.equal(isAdminRoute(base, r), false, r);
  }
});

test('account.request отказывает в /admin/* до сети, даже администратору', async () => {
  const account = adminAccount();
  const f = stubFetch();
  try {
    for (const route of ['/admin/users?q=ab', '/admin/bugs', '/admin/vehicles/alias', '/admin/log', '/admin/block', '/admin/recovery-code']) {
      await assert.rejects(
        account.request(route, { auth: true, method: route.includes('?') ? 'GET' : 'POST', body: {} }),
        (e) => e.code === 'admin_only_in_panel',
        route
      );
    }
    assert.equal(f.calls.length, 0, 'ни один запрос не ушёл');
    await account.request('/auth/me', { auth: true });
    assert.equal(f.calls.length, 1, 'обычные запросы ходят как прежде');
  } finally {
    f.restore();
  }
});

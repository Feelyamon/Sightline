'use strict';

// Предупреждение о гостевом режиме и ссылки на сайт учётной записи.

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

const { GuestNotice, COUNTDOWN_SEC } = require('../src/main/guest-notice');
const links = require('../src/main/links');
const { Account } = require('../src/main/account');
const locale = require('../src/main/locale');

const SRC = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(SRC, 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(SRC, 'renderer', 'app.js'), 'utf8');

// --- Когда показывать -----------------------------------------------------

test('запуск без входа — предупреждение показывается', () => {
  const n = new GuestNotice(false);
  assert.equal(n.take(false), true);
});

test('вошедшему предупреждение не показывается никогда', () => {
  const n = new GuestNotice(true);
  assert.equal(n.take(true), false);
  assert.equal(n.take(true), false);
});

test('за один запуск — один раз, даже если окно перезагрузилось', () => {
  const n = new GuestNotice(false);
  assert.equal(n.take(false), true);
  // Окно перезагрузилось и спрашивает снова.
  assert.equal(n.take(false), false);
  assert.equal(n.take(false), false);
});

test('после выхода из аккаунта — снова, но тоже один раз', () => {
  const n = new GuestNotice(true);
  assert.equal(n.take(true), false);
  n.signedOut();
  assert.equal(n.take(false), true);
  assert.equal(n.take(false), false);
});

test('вошёл до того, как окно спросило, — не показываем', () => {
  const n = new GuestNotice(false);
  n.signedIn();
  assert.equal(n.take(true), false);
});

test('выход, вход и снова выход — каждый выход даёт один показ', () => {
  const n = new GuestNotice(false);
  assert.equal(n.take(false), true);
  n.signedIn();
  n.signedOut();
  assert.equal(n.take(false), true);
  n.signedIn();
  assert.equal(n.take(true), false);
  n.signedOut();
  assert.equal(n.take(false), true);
});

test('если сессия есть, ответ «нет», даже когда показ был положен', () => {
  // Окно спросило уже после того, как main узнал о входе другим путём.
  const n = new GuestNotice(false);
  assert.equal(n.take(true), false);
  assert.equal(n.take(false), false, 'и показ не откладывается на потом');
});

test('отсчёт — пять секунд', () => {
  assert.equal(COUNTDOWN_SEC, 5);
});

// --- Окно предупреждения --------------------------------------------------

test('в разметке есть окно с двумя кнопками, и «понимаю» неактивна сразу', () => {
  const modal = html.match(/<div class="modal-backdrop blocking" id="guestModal"[\s\S]*?\n  <\/div>/);
  assert.ok(modal, 'окно guestModal есть и блокирующее');
  assert.match(modal[0], /role="dialog"/);
  assert.match(modal[0], /aria-modal="true"/);
  assert.match(modal[0], /aria-labelledby="guestTitle"/);
  assert.match(modal[0], /id="guestSignIn" data-i18n="guest.signIn"/);
  assert.match(modal[0], /id="guestOk"[^>]*\bdisabled\b/);
  assert.match(modal[0], /\bhidden\b/, 'по умолчанию скрыто');
});

test('Escape в окне предупреждения перехватывается и отсчёт не обходит', () => {
  // Обработчик стоит в фазе перехвата (третий аргумент true), чтобы общий
  // Escape других окон не сработал раньше.
  const block = app.slice(app.indexOf('// Клавиатура внутри окна'));
  assert.match(block, /e\.key === 'Escape'[\s\S]*?preventDefault\(\)[\s\S]*?stopPropagation\(\)/);
  assert.match(block, /\n  true\n\);/);
  // И нигде Escape не закрывает guestModal.
  assert.doesNotMatch(app, /Escape[^\n]*guestModal'\)\.hidden = true/);
});

test('кнопка «понимаю» не закрывает окно, пока идёт отсчёт', () => {
  assert.match(app, /\$\('guestOk'\)\.addEventListener\('click', \(\) => \{\n  if \(\$\('guestOk'\)\.disabled\) return;/);
});

test('предупреждение проверяется при запуске и после каждого выхода', () => {
  const calls = app.match(/checkGuestNotice\(\);/g) || [];
  // Запуск, кнопка «Выйти», «Выйти везде», выход по решению сервера.
  assert.ok(calls.length >= 4, `вызовов ${calls.length}`);
});

test('тексты предупреждения есть на всех трёх языках и различаются', () => {
  const keys = ['guest.title', 'guest.text', 'guest.local', 'guest.signIn', 'guest.ok', 'guest.okWait'];
  const seen = new Set();
  for (const lang of locale.LANGS) {
    const dict = locale.dictionary(lang);
    for (const k of keys) assert.ok(dict[k], `${lang}: ${k}`);
    assert.match(dict['guest.okWait'], /\{n\}/);
    seen.add(dict['guest.title']);
  }
  assert.equal(seen.size, locale.LANGS.length, 'заголовок переведён, а не скопирован');
  assert.equal(locale.dictionary('ru')['guest.signIn'], 'Вход / регистрация');
  assert.equal(locale.dictionary('ru')['guest.ok'], 'Да, я понимаю');
});

// --- Ссылки на сайт -------------------------------------------------------

test('«Сменить пароль» ведёт на страницу учётной записи', () => {
  assert.equal(links.externalUrl('account'), 'https://feelyamon.ru/account');
});

test('«Забыли пароль?» ведёт на восстановление', () => {
  assert.equal(links.externalUrl('recover'), 'https://feelyamon.ru/recover');
});

test('правовые страницы по-прежнему на сайте Sightline', () => {
  const config = require('../src/main/config');
  assert.equal(links.externalUrl('terms'), `${config.site}/terms`);
  assert.equal(links.externalUrl('privacy'), `${config.site}/privacy`);
  assert.equal(links.externalUrl('rights'), `${config.site}/rights`);
});

test('неизвестная страница — отказ, а не пустой адрес', () => {
  for (const page of ['', 'admin', 'https://evil.example', '__proto__', 'constructor', 'toString', undefined, null]) {
    assert.throws(() => links.externalUrl(page), /неизвестная страница/, String(page));
  }
});

test('проверка пропускает ровно два адреса основного сайта', () => {
  assert.equal(links.isAllowedAccountUrl('https://feelyamon.ru/account'), true);
  assert.equal(links.isAllowedAccountUrl('https://feelyamon.ru/recover'), true);
});

test('проверка отвергает всё остальное', () => {
  const refused = [
    'http://feelyamon.ru/account', // не https
    'https://feelyamon.ru/', // путь не из списка
    'https://feelyamon.ru/admin',
    'https://feelyamon.ru/account/', // хвостовой слэш — уже другой путь
    'https://feelyamon.ru/accounts',
    'https://feelyamon.ru/account?next=https://evil.example', // запрос
    'https://feelyamon.ru/account#x', // якорь
    'https://feelyamon.ru:8443/account', // порт
    'https://user:pass@feelyamon.ru/account', // логин в адресе
    'https://evil.feelyamon.ru/account', // поддомен
    'https://feelyamon.ru.evil.example/account', // чужой домен с нашим в начале
    'https://sightline.feelyamon.ru/account', // свой, но не тот поддомен
    'https://evil.example/account',
    'javascript:alert(1)',
    'file:///C:/Windows/system32/calc.exe',
    'feelyamon.ru/account', // без схемы
    '',
    'не адрес',
  ];
  for (const url of refused) assert.equal(links.isAllowedAccountUrl(url), false, url);
});

test('ссылки в окне передают в main имя страницы, а не адрес', () => {
  assert.match(app, /\['siForgot', 'recover'\]/);
  assert.match(app, /\['accChangePassword', 'account'\]/);
  assert.doesNotMatch(app, /openExternal\(['"]https?:/, 'адресов в окне нет');
  assert.match(html, /id="siForgot" data-i18n="acc.forgot"/);
  assert.match(html, /id="accChangePassword" data-i18n="acc.changePasswordSite"/);
});

test('main открывает внешние страницы только через список', () => {
  const main = fs.readFileSync(path.join(SRC, 'main', 'index.js'), 'utf8');
  const handler = main.slice(main.indexOf("handle('app:openExternal'"));
  assert.match(handler, /links\.externalUrl\(page\)/);
  // Ни одного openExternal с адресом, пришедшим из окна напрямую.
  assert.doesNotMatch(main, /openExternal\(page\)/);
});

// --- Выход из аккаунта слышен всем ----------------------------------------

function signedInAccount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-acc-'));
  const account = new Account(dir, { baseUrl: 'https://example.invalid/v1' });
  account.session = { token: 't', login: 'U', role: 'user', lang: 'ru', expiresAt: null };
  account.save();
  return account;
}

test('выход из аккаунта сообщает о себе', () => {
  const account = signedInAccount();
  let heard = 0;
  account.onSignedOut = () => heard++;
  account.signOutLocally();
  assert.equal(heard, 1);
  // Повторный «выход» без входа — не событие.
  account.signOutLocally();
  assert.equal(heard, 1);
});

test('сервер закрыл сессию (401) — это тоже выход', async () => {
  const account = signedInAccount();
  let heard = 0;
  account.onSignedOut = () => heard++;
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' });
  try {
    await assert.rejects(account.request('/auth/me', { auth: true }));
  } finally {
    global.fetch = real;
  }
  assert.equal(heard, 1);
  assert.equal(account.isSignedIn, false);
});

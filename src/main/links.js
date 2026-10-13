'use strict';

// Какие адреса программа открывает во внешнем браузере.
//
// Окно присылает не адрес, а ИМЯ страницы, и адрес собирается здесь. Это не
// формальность: всё, что приходит из окна, мог прислать любой скрипт в нём, и
// «открыть присланный адрес» означало бы открыть человеку что угодно чужими
// руками. Поэтому список закрытый, а каждый собранный адрес ещё раз
// проверяется — на случай, если список однажды поправят с опечаткой или
// адрес сайта подменят переменной окружения.

const config = require('./config');

// Общая учётная запись живёт на основном сайте, а не на сайте Sightline:
// пароль один на все проекты, и меняется он там же, где заводится. Программа
// туда только отправляет — своей формы смены пароля «в обход сайта» у неё
// больше нет причин держать на виду.
const ACCOUNT_ORIGIN = 'https://feelyamon.ru';
const ACCOUNT_HOST = 'feelyamon.ru';

/** Страницы основного сайта, которые можно открыть. Ровно эти пути. */
const ACCOUNT_PAGES = {
  // Сменить пароль — страница учётной записи.
  account: '/account',
  // Забыли пароль — восстановление.
  recover: '/recover',
};

/** Страницы сайта Sightline. */
const SITE_PAGES = { terms: '/terms', privacy: '/privacy', rights: '/rights' };

/**
 * Пропускает ли проверка этот адрес на основной сайт.
 *
 * Только https, только этот хост без поддоменов, без порта, логина и пароля
 * в адресе, и путь строго из списка. Запрос и якорь не допускаются вовсе:
 * через них на чужую страницу уже не попасть, но и пользы от них никакой, а
 * «пропускать лишнее, раз вреда не видно» — то, как такие списки и
 * размываются.
 * @param {string} raw
 */
function isAllowedAccountUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === ACCOUNT_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    Object.values(ACCOUNT_PAGES).includes(url.pathname)
  );
}

/**
 * Адрес страницы по её имени. Неизвестное имя — исключение, а не пустая
 * строка: тихо ничего не открыть хуже, чем сказать, что открыть нечего.
 * @param {string} page
 * @returns {string}
 */
function externalUrl(page) {
  if (Object.hasOwn(SITE_PAGES, page)) return config.site + SITE_PAGES[page];
  if (Object.hasOwn(ACCOUNT_PAGES, page)) {
    const url = ACCOUNT_ORIGIN + ACCOUNT_PAGES[page];
    if (!isAllowedAccountUrl(url)) throw new Error('адрес страницы учётной записи не прошёл проверку');
    return url;
  }
  throw new Error('неизвестная страница');
}

module.exports = { externalUrl, isAllowedAccountUrl, ACCOUNT_PAGES, SITE_PAGES };

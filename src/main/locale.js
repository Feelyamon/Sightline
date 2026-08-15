'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Словари лежат JSON-файлами, а читает их main-процесс: страница рендерера
// загружена по file://, и достать их оттуда через fetch не даёт CSP.

const DIR = path.join(__dirname, '..', 'i18n');

// Английский по умолчанию, пока пользователь не выбрал другой язык — так
// договорились. Первым в списке идёт язык по умолчанию.
const LANGS = ['en', 'ru', 'zh'];
const DEFAULT_LANG = 'en';

const cache = new Map();

/** @returns {object} словарь языка; при любой ошибке — английский. */
function dictionary(lang) {
  const code = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  if (cache.has(code)) return cache.get(code);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8'));
    cache.set(code, data);
    return data;
  } catch {
    // Файл словаря испорчен или потерялся при сборке. Английский — крайний
    // случай; если и его нет, отдаём пустой словарь: интерфейс покажет ключи,
    // но приложение не упадёт.
    if (code !== DEFAULT_LANG) return dictionary(DEFAULT_LANG);
    return {};
  }
}

/** Названия языков для выпадающего списка — каждое на своём языке. */
function available() {
  return LANGS.map((code) => ({ code, name: dictionary(code)['lang.name'] || code }));
}

const normalize = (lang) => (LANGS.includes(lang) ? lang : DEFAULT_LANG);

module.exports = { dictionary, available, normalize, LANGS, DEFAULT_LANG };

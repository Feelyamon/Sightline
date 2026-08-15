'use strict';

// Все видимые строки живут в src/i18n/{en,ru,zh}.json и приходят сюда из
// main-процесса: читать их из рендерера через fetch нельзя, страница
// загружена по file:// и CSP это запрещает.
//
// Как и charts.js, файл завёрнут в функцию — обычные <script> делят одну
// глобальную область. Наружу торчит только window.i18n.
(function () {

let dict = {};
let lang = 'en';

/**
 * Какую из форм множественного числа брать. Правила разные: в русском их три,
 * в английском две, в китайском форма одна.
 * @returns {0|1|2}
 */
function pluralIndex(n) {
  if (lang !== 'ru') return n === 1 ? 0 : 1;
  const abs = Math.abs(n) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return 2;
  if (tail > 1 && tail < 5) return 1;
  if (tail === 1) return 0;
  return 2;
}

/**
 * Строка по ключу с подстановкой {имён}.
 * Ключ, которого нет в словаре, возвращается как есть — так пропущенный
 * перевод виден в интерфейсе, а не превращается в пустое место.
 */
function t(key, params) {
  let s = dict[key];
  if (s === undefined) return key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      s = s.split(`{${name}}`).join(String(value));
    }
  }
  return s;
}

/**
 * Форма слова по числу: plural(3, 'plural.wins') → «победы».
 * Формы лежат в словаре одной строкой через запятую.
 */
function plural(n, key) {
  const forms = String(dict[key] || key).split(',');
  return forms[pluralIndex(n)] ?? forms[forms.length - 1];
}

/** Список через запятую — месяцы, дни недели. */
const list = (key) => String(dict[key] || '').split(',');

/**
 * Подставляет переводы в статическую разметку.
 *   data-i18n              → текст элемента
 *   data-i18n-placeholder  → placeholder
 *   data-i18n-title        → всплывающая подсказка
 */
function apply(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  document.documentElement.lang = lang;
}

function setLocale(locale) {
  if (!locale) return;
  dict = locale.dict || {};
  lang = locale.lang || 'en';
}

/** Даты и числа форматируем по выбранному языку, а не по языку системы. */
const locale = () => ({ ru: 'ru-RU', en: 'en-GB', zh: 'zh-CN' })[lang] || 'en-GB';

window.i18n = { t, plural, list, apply, setLocale, locale, lang: () => lang };

})();

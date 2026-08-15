'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const locale = require('../src/main/locale');

const SRC = path.join(__dirname, '..', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

test('во всех языках один и тот же набор ключей', () => {
  const base = locale.dictionary(locale.DEFAULT_LANG);
  const baseKeys = Object.keys(base).sort();

  for (const lang of locale.LANGS) {
    const keys = Object.keys(locale.dictionary(lang)).sort();
    const missing = baseKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !baseKeys.includes(k));
    assert.deepEqual(missing, [], `в ${lang}.json не хватает ключей`);
    assert.deepEqual(extra, [], `в ${lang}.json лишние ключи`);
  }
});

test('подстановки {имя} совпадают между языками', () => {
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const base = locale.dictionary(locale.DEFAULT_LANG);

  for (const lang of locale.LANGS) {
    if (lang === locale.DEFAULT_LANG) continue;
    const dict = locale.dictionary(lang);
    for (const [key, value] of Object.entries(base)) {
      // Пропущенная или лишняя подстановка — это «{n}» прямо в интерфейсе
      // либо потерянное число. В переводе такое не видно на глаз.
      assert.deepEqual(holes(dict[key]), holes(value), `${lang}.json, ключ ${key}`);
    }
  }
});

test('формы множественного числа заданы тройками', () => {
  for (const lang of locale.LANGS) {
    const dict = locale.dictionary(lang);
    for (const key of Object.keys(dict).filter((k) => k.startsWith('plural.'))) {
      assert.equal(dict[key].split(',').length, 3, `${lang}.json, ${key}`);
    }
  }
});

test('каждый ключ из кода есть в словаре', () => {
  const sources = [
    read(path.join(SRC, 'renderer', 'app.js')),
    read(path.join(SRC, 'renderer', 'charts.js')),
    read(path.join(SRC, 'renderer', 'index.html')),
  ].join('\n');

  const used = new Set();
  // t('ключ'), data-i18n="ключ", data-i18n-placeholder="ключ", plural(n, 'ключ')
  for (const m of sources.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
  for (const m of sources.matchAll(/data-i18n(?:-placeholder|-title)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of sources.matchAll(/window\.i18n\.(?:plural|list)\([^,)]*,?\s*'([\w.]+)'/g)) {
    used.add(m[1]);
  }

  const dict = locale.dictionary(locale.DEFAULT_LANG);
  const missing = [...used].filter((k) => !(k in dict)).sort();
  assert.deepEqual(missing, [], 'ключи есть в коде, но не в словаре');
});

test('неизвестный язык откатывается на английский', () => {
  assert.equal(locale.normalize('de'), 'en');
  assert.equal(locale.normalize(''), 'en');
  assert.equal(locale.normalize('ru'), 'ru');
  assert.equal(locale.dictionary('de')['lang.name'], 'English');
});

test('у каждого языка есть название на самом себе', () => {
  const list = locale.available();
  assert.equal(list.length, locale.LANGS.length);
  for (const l of list) assert.ok(l.name && l.name !== l.code, `${l.code} без названия`);
});

'use strict';

// Собирает интерфейс в один HTML-файл с данными-заглушкой вместо базы:
// стили и скрипты встраиваются, CSP снимается (иначе браузер отвергнет
// встроенные <script>). Нужен, чтобы смотреть и править вёрстку в обычном
// браузере, не запуская Electron и не трогая настоящую базу боёв.
//
//   node scripts/harness/build.js   →   scripts/harness/index.html
//
// В сборку приложения не входит: сюда ходит только разработка.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const renderer = path.join(root, 'src', 'renderer');
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

const SCRIPTS =
  '<script src="i18n.js"></script>\n  <script src="charts.js"></script>\n  <script src="app.js"></script>';

// Словари в браузере не прочитать (JSON лежит файлами, страница открыта по
// file://), поэтому вшиваем их в стенд на этапе сборки — как это делает
// main-процесс в настоящем приложении.
const localeModule = require(path.join(root, 'src', 'main', 'locale.js'));
const dicts = Object.fromEntries(
  localeModule.LANGS.map((code) => [code, localeModule.dictionary(code)])
);

const stub = read(__dirname, 'stub.js')
  .replace('/*__DICTS__*/ {}', JSON.stringify(dicts))
  .replace('/*__LANGS__*/ []', JSON.stringify(localeModule.available()));

let html = read(renderer, 'index.html');
for (const [what, replacement] of [
  [/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, ''],
  ['<link rel="stylesheet" href="app.css" />', `<style>${read(renderer, 'app.css')}</style>`],
  [
    SCRIPTS,
    `<script>${stub}</script>` +
      `<script>${read(renderer, 'i18n.js')}</script>` +
      `<script>${read(renderer, 'charts.js')}</script>` +
      `<script>${read(renderer, 'app.js')}</script>`,
  ],
]) {
  const before = html;
  html = html.replace(what, replacement);
  if (html === before) {
    // Разметку поменяли, а стенд об этом не знает — молча собранный файл
    // без скриптов отладил бы кто-нибудь на полчаса.
    console.error(`Стенд не собран: в index.html не найдено «${String(what).slice(0, 60)}»`);
    process.exit(1);
  }
}

const out = path.join(__dirname, 'index.html');
fs.writeFileSync(out, html);
console.log(out);

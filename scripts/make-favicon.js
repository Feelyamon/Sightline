'use strict';

// Собирает значки сайта из того же знака, что стоит в трее.
//
//   node scripts/make-favicon.js
//
// Почему не само лого. Лого нарисовано тонкими линиями на тёмном фоне, и во
// вкладке браузера — шестнадцать пикселей — от него не остаётся ничего: замер
// показал ровно ноль различимых пикселей, весь квадрат сливается в однородное
// пятно. Поэтому в мелких размерах живёт тот же знак, что в трее: столбцы и
// стрелка сплошной заливкой. Настоящее лого остаётся там, где места хватает,
// — в apple-touch-icon и в открытом графе.
//
// Файлы кладутся в соседний репозиторий сайта. Так же поступает
// scripts/make-icons.ps1: исходник один, и расходиться производные не должны.

const fs = require('node:fs');
const path = require('node:path');
const { appIcon } = require('../src/main/icon');

const root = path.join(__dirname, '..');
const site = path.join(root, '..', 'Sightline-Backend', 'site');

if (!fs.existsSync(site)) {
  console.error(`Не найден каталог сайта: ${site}`);
  process.exit(1);
}

/**
 * Складывает .ico из нескольких PNG.
 *
 * Браузеры и сегодня сами просят /favicon.ico, если в разметке ничего не
 * указано, а поисковые роботы — тем более. PNG внутри .ico понимают все
 * версии, которые вообще стоит учитывать.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // зарезервировано
  header.writeUInt16LE(1, 2); // тип: значок
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    // 256 записывается нулём: в один байт оно не помещается, и формат
    // договорился считать ноль за максимальный размер.
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // цветов в палитре — не палитра
    e[3] = 0; // зарезервировано
    e.writeUInt16LE(1, 4); // плоскостей
    e.writeUInt16LE(32, 6); // бит на пиксель
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const SIZES = [16, 32, 48];
const images = SIZES.map((size) => ({ size, data: appIcon(size) }));

for (const { size, data } of images) {
  const file = path.join(site, `icon-${size}.png`);
  fs.writeFileSync(file, data);
  console.log(`${file}  ${size}x${size}`);
}

const ico = path.join(site, 'favicon.ico');
fs.writeFileSync(ico, buildIco(images));
console.log(`${ico}  ${SIZES.join(', ')}`);

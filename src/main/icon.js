'use strict';

const zlib = require('node:zlib');

// Иконка трея рисуется кодом, а не лежит файлом. Причины две: в репозиторий,
// который скоро станет открытым, не хочется класть бинарники, которые нельзя
// прочитать глазами в диффе; и иконка любого размера получается из одного
// описания — Windows просит 16px, а при масштабировании экрана 32px.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Один блок PNG: длина, тип, данные, контрольная сумма. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Собирает PNG из массива пикселей RGBA.
 * @param {number} size - сторона квадрата
 * @param {Buffer} rgba - size * size * 4 байта
 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  // Каждая строка пикселей идёт с байтом фильтра впереди; фильтр 0 — «как есть».
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Фирменное золото лого. Одно значение на всю программу: иконка трея и лого на
// сайте должны быть одного цвета, иначе они читаются как разные продукты.
const GOLD = [0xd8, 0xb4, 0x6b];

/** Расстояние от точки до отрезка. Нужно, чтобы нарисовать стрелку линиями. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Знак приложения: три столбца и стрелка вверх — то же, что на лого.
 *
 * Рисуется кодом, а не лежит файлом, по двум причинам: в открытый репозиторий
 * не хочется класть бинарник, который нельзя прочитать глазами в диффе, и
 * иконка любого размера получается из одного описания — Windows просит 16px, а
 * при масштабировании экрана 32px.
 *
 * Кольцо с лого здесь сознательно опущено: в шестнадцати пикселях тонкая
 * окружность превращается в грязь и съедает место у того, что несёт смысл.
 *
 * @param {number} size
 * @param {[number, number, number]} rgb
 */
function appIcon(size = 32, rgb = GOLD) {
  const rgba = Buffer.alloc(size * size * 4);
  const u = (v) => v * size; // доли стороны → пиксели

  // Столбцы: слева направо и снизу вверх. Значения в долях, чтобы знак
  // одинаково собирался в любом размере.
  const bars = [
    { x0: 0.08, x1: 0.29, top: 0.60 },
    { x0: 0.39, x1: 0.60, top: 0.42 },
    { x0: 0.70, x1: 0.91, top: 0.16 },
  ];
  const bottom = 0.94;

  // Стрелка: диагональ и два пера наконечника.
  const arrow = [
    [0.10, 0.86, 0.80, 0.24],
    [0.80, 0.24, 0.60, 0.28],
    [0.80, 0.24, 0.76, 0.45],
  ];
  const stroke = Math.max(1, size * 0.085);
  // Просвет между стрелкой и столбцами: без него в мелком размере стрелка
  // сливается со столбцами в одно пятно.
  const gap = Math.max(0.75, size * 0.055);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      let d = Infinity;
      for (const [ax, ay, bx, by] of arrow) {
        d = Math.min(d, distToSegment(px, py, u(ax), u(ay), u(bx), u(by)));
      }

      // Сглаживание по краю: без него в 16 пикселях диагональ выглядит рваной.
      let alpha = Math.min(1, Math.max(0, stroke / 2 - d + 0.5));
      if (alpha < 1 && d > stroke / 2 + gap) {
        const inBar = bars.some(
          (b) => px >= u(b.x0) && px <= u(b.x1) && py >= u(b.top) && py <= u(bottom)
        );
        if (inBar) alpha = 1;
      }
      if (alpha <= 0) continue;

      const i = (y * size + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
      rgba[i + 3] = Math.round(255 * alpha);
    }
  }
  return encodePng(size, rgba);
}

module.exports = { appIcon, encodePng, GOLD };

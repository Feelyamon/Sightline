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

/**
 * Прицел: кольцо и четыре штриха по сторонам. Название приложения —
 * Sightline, и прицел читается в трее даже в 16 пикселей.
 * @param {number} size
 * @param {[number, number, number]} rgb
 */
function sightIcon(size = 32, rgb = [110, 168, 254]) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.34;
  const thickness = Math.max(1, size * 0.09);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);

      const onRing = Math.abs(d - radius) <= thickness / 2;
      // Штрихи от кольца к краю: по вертикали и горизонтали.
      const onTick =
        (Math.abs(dx) <= thickness / 2 && d > radius && d <= radius + size * 0.14) ||
        (Math.abs(dy) <= thickness / 2 && d > radius && d <= radius + size * 0.14);
      const onDot = d <= thickness * 0.9;

      if (!onRing && !onTick && !onDot) continue;
      // Сглаживание по краю: без него в 16 пикселях кольцо выглядит рваным.
      const edge = onRing ? 1 - Math.max(0, Math.abs(d - radius) - thickness / 2 + 0.5) : 1;
      const alpha = Math.round(255 * Math.min(1, Math.max(0, edge)));

      const i = (y * size + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
      rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, rgba);
}

module.exports = { sightIcon, encodePng };

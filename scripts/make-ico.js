'use strict';

// Собирает build/icon.ico из assets/icon.png.
//
//   npm run icons   →   build/icon.ico
//
// Зачем свой .ico, если electron-builder умеет делать его сам. Он умеет, но
// кладёт в файл ОДНУ картинку 256×256 в сжатом PNG — это видно по
// dist/.icon-ico/icon.ico и по ресурсам собранного Sightline.exe версии
// 1.0.1. Мелких размеров в таком значке нет, и места, которые просят у
// Windows значок 16, 24 или 32 пикселя старыми средствами (диспетчер задач,
// «Автозагрузка», часть списков проводника и панели управления), не умеют
// уменьшить PNG-кадр и рисуют вместо него стандартное «окошко». Ровно его
// владелец и увидел. Здесь все размеры нарисованы заранее и лежат
// несжатыми растрами — их понимает любой потребитель, от проводника до NSIS.
//
// Только node, без сети и без зависимостей: разбор PNG, уменьшение и запись
// ICO — меньше двухсот строк, и результат побайтно одинаков на любой машине
// (PNG-кадров здесь нет именно поэтому: сжатие зависит от версии zlib, а
// тест сверяет файл в репозитории с тем, что даёт этот скрипт).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { appIcon } = require('../src/main/icon');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'icon.png');
const TARGET = path.join(ROOT, 'build', 'icon.ico');

/** Размеры, которые Windows запрашивает в разных местах (с учётом масштаба 125–200%). */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/**
 * Разбирает PNG: 8 бит на канал, RGB или RGBA, без чересстрочности.
 * Другие виды исходнику не нужны, и молча понимать их наполовину хуже,
 * чем честно отказаться.
 * @returns {{width: number, height: number, rgba: Buffer}}
 */
function decodePng(buf) {
  const SIG = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== SIG) throw new Error('не PNG');
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error(`неподдерживаемый PNG: глубина ${depth}, тип ${colorType}, чересстрочность ${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`неизвестный фильтр строки ${filter}`);
      line[x] = (line[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels];
      out[o + 1] = line[x * channels + 1];
      out[o + 2] = line[x * channels + 2];
      out[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/**
 * Уменьшает квадратную картинку усреднением по площади.
 *
 * Цвет усредняется с весом прозрачности: иначе полупрозрачный край лого
 * смешивался бы с «цветом» полностью прозрачных пикселей (обычно чёрным) и
 * значок обрастал тёмной каймой — особенно заметно на 16 пикселях.
 */
function resize({ width, rgba }, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = x * scale;
      const x1 = (x + 1) * scale;
      const y0 = y * scale;
      const y1 = (y + 1) * scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const w = wx * wy;
          const o = (sy * width + sx) * 4;
          const alpha = rgba[o + 3] * w;
          r += rgba[o] * alpha;
          g += rgba[o + 1] * alpha;
          b += rgba[o + 2] * alpha;
          a += alpha;
          area += w;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / area);
    }
  }
  return out;
}

/**
 * Один кадр ICO в формате BMP: заголовок BITMAPINFOHEADER, пиксели BGRA снизу
 * вверх и маска AND. Высота в заголовке удвоена — так устроен формат значков:
 * она считает цвет и маску вместе.
 */
function bmpFrame(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); // плоскостей
  header.writeUInt16LE(32, 14); // бит на пиксель
  const pixels = Buffer.alloc(size * size * 4);
  // Строка маски выровнена на 4 байта.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // BMP хранится снизу вверх
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (row * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      // Маска нужна потребителям, не понимающим альфа-канал: прозрачное —
      // единица.
      if (rgba[s + 3] < 128) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

/** Собирает .ico из кадров {size, data}. */
function buildIco(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 — значок
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; // 0 означает 256
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

// До какого размера рисуем знак кодом, а не уменьшаем лого. Лого нарисовано
// тонкими линиями и в 16–24 пикселях превращается в мутное пятно (проверено
// глазами, как и для трея — см. tray.js). Знак трея нарисован под мелкий
// размер сплошной заливкой и в панели задач читается так же, как в трее.
const GLYPH_MAX = 24;

/** Пиксели одного кадра: мелкие — знак трея, крупные — уменьшенное лого. */
function frame(image, size) {
  if (size <= GLYPH_MAX) return decodePng(appIcon(size)).rgba;
  return resize(image, size);
}

/** Весь путь от PNG до .ico — в памяти, без записи на диск. */
function makeIco(png = fs.readFileSync(SOURCE)) {
  const image = decodePng(png);
  if (image.width !== image.height) throw new Error('исходник значка должен быть квадратным');
  if (image.width < 256) throw new Error(`исходник ${image.width}px — нужно не меньше 256`);
  return buildIco(SIZES.map((size) => ({ size, data: bmpFrame(size, frame(image, size)) })));
}

/** Разбор .ico обратно — для тестов и для самопроверки после записи. */
function readIco(buf) {
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf[e] || 256;
    const length = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const data = buf.subarray(offset, offset + length);
    frames.push({ size, length, offset, png: data.subarray(1, 4).toString('ascii') === 'PNG' });
  }
  return { type: buf.readUInt16LE(2), frames };
}

if (require.main === module) {
  const ico = makeIco();
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, ico);
  const sizes = readIco(ico).frames.map((f) => f.size).join(', ');
  console.log(`${path.relative(ROOT, TARGET)}: ${ico.length} байт, размеры ${sizes}`);
}

module.exports = { decodePng, resize, frame, GLYPH_MAX, bmpFrame, buildIco, makeIco, readIco, SIZES, SOURCE, TARGET };

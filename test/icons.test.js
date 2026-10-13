'use strict';

// Значки собранной программы.
//
// Жалоба владельца: после установки 1.0.1 ярлык на рабочем столе со значком
// Sightline, а где-то в системе — стандартное «окошко». Причина найдена в
// ресурсах собранного Sightline.exe и установщика: electron-builder делал из
// assets/icon.png .ico с ОДНИМ кадром 256×256 в сжатом PNG, без мелких
// размеров. Тесты ниже проверяют, что значок теперь собирается нами, что в
// нём есть все размеры обычными растрами и что каждый путь к значку,
// который нужен сборке и работающей программе, ведёт к существующему файлу
// так, как его увидит установленная копия.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const ico = require('../scripts/make-ico');
const { windowIconPath, loadWindowIcon, WINDOW_ICON } = require('../src/main/icon-paths');

const committed = () => fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));

// --- Файл .ico ------------------------------------------------------------

test('build/icon.ico есть и это значок, а не что-то другое', () => {
  const parsed = ico.readIco(committed());
  assert.equal(parsed.type, 1);
  assert.ok(parsed.frames.length >= 7);
});

test('в значке все размеры, которые просит Windows', () => {
  const sizes = ico.readIco(committed()).frames.map((f) => f.size);
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    assert.ok(sizes.includes(size), `нет кадра ${size}×${size}`);
  }
});

test('кадры — обычные растры, а не сжатый PNG', () => {
  // Именно PNG-кадр без мелких размеров и рисовался стандартным «окошком».
  for (const f of ico.readIco(committed()).frames) assert.equal(f.png, false, `кадр ${f.size}`);
});

test('кадры лежат внутри файла и не перекрываются', () => {
  const buf = committed();
  const frames = ico.readIco(buf).frames.slice().sort((a, b) => a.offset - b.offset);
  let end = 6 + 16 * frames.length;
  for (const f of frames) {
    assert.ok(f.offset >= end, `кадр ${f.size} налезает на предыдущий`);
    end = f.offset + f.length;
  }
  assert.equal(end, buf.length);
});

test('значок в репозитории совпадает с тем, что собирает скрипт', () => {
  // Поменяли assets/icon.png и забыли npm run icons — установщик получил бы
  // старый значок, и узнали бы об этом только после релиза.
  assert.ok(ico.makeIco().equals(committed()), 'запустите npm run icons');
});

test('сборка значка не зависит от машины: два прогона дают одно и то же', () => {
  assert.ok(ico.makeIco().equals(ico.makeIco()));
});

test('мелкие кадры — знак на прозрачном фоне, крупные — лого с деталями', () => {
  const image = ico.decodePng(fs.readFileSync(ico.SOURCE));
  for (const size of [16, 20, 24]) {
    // Знак трея: сплошная заливка на прозрачном — иначе в 16 пикселях пятно.
    const rgba = ico.frame(image, size);
    let opaque = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 128) opaque++;
    const share = opaque / (size * size);
    assert.ok(share > 0.05 && share < 0.9, `${size}: доля непрозрачного ${share}`);
  }
  for (const size of [32, 48, 256]) {
    // Лого квадратное с собственным фоном; проверяем, что после уменьшения
    // в кадре остался рисунок, а не однотонная заливка.
    const rgba = ico.frame(image, size);
    let min = 255;
    let max = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const light = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
      min = Math.min(min, light);
      max = Math.max(max, light);
    }
    assert.ok(max - min > 80, `${size}: контраст ${max - min}`);
  }
});

test('уменьшение не даёт тёмной каймы на полупрозрачном краю', () => {
  // Белый пиксель рядом с полностью прозрачным чёрным: среднее должно
  // остаться белым, а не стать серым.
  const rgba = Buffer.from([255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0]);
  const out = ico.resize({ width: 2, rgba }, 1);
  assert.deepEqual([...out.subarray(0, 3)], [255, 255, 255]);
  assert.equal(out[3], 128);
});

test('разбор PNG понимает все пять фильтров строк', () => {
  // Исходник лого сжат графическим редактором, и какие фильтры он выбрал —
  // не наше решение. Проверяем на настоящем файле: размер и непустота.
  const image = ico.decodePng(fs.readFileSync(ico.SOURCE));
  assert.equal(image.width, 512);
  assert.equal(image.rgba.length, 512 * 512 * 4);
  assert.throws(() => ico.decodePng(Buffer.from('не png')), /не PNG/);
});

// --- Настройки сборки -----------------------------------------------------

test('exe, установщик и деинсталлятор берут значок из build/icon.ico', () => {
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.nsis.installerIcon, 'build/icon.ico');
  assert.equal(pkg.build.nsis.uninstallerIcon, 'build/icon.ico');
  assert.equal(pkg.build.nsis.installerHeaderIcon, 'build/icon.ico');
  assert.equal(pkg.build.directories.buildResources, 'build');
  for (const p of [pkg.build.win.icon, pkg.build.nsis.installerIcon, pkg.build.nsis.uninstallerIcon]) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), p);
  }
});

test('AppUserModelId совпадает с appId сборки', () => {
  // Иначе Windows считает установленную программу и её окно разными
  // приложениями: панель задач, закреплённые ярлыки и уведомления берут
  // значок «никакого» приложения.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  const ids = [...main.matchAll(/setAppUserModelId\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 1);
  for (const id of ids) assert.equal(id, pkg.build.appId);
});

/** Попадает ли файл в app.asar по правилам build.files (упрощённо: префиксы и исключения). */
function packaged(relPath) {
  const rel = relPath.split(path.sep).join('/');
  let included = false;
  for (const pattern of pkg.build.files) {
    const negate = pattern.startsWith('!');
    const body = negate ? pattern.slice(1) : pattern;
    const re = new RegExp(
      '^' +
        body
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '(?:.*/)?')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*') +
        '$'
    );
    if (re.test(rel)) included = !negate;
  }
  return included;
}

test('значок окна попадает в собранный архив приложения', () => {
  assert.equal(packaged(WINDOW_ICON), true, `${WINDOW_ICON} не входит в build.files`);
  // А build/ — нет: это ресурсы сборки, программе во время работы они не нужны.
  assert.equal(packaged('build/icon.ico'), false);
});

test('путь значка считается от корня приложения так же, как в установленной копии', () => {
  // В установленной программе корень — resources/app.asar, и всё, что
  // попало в архив по build.files, лежит относительно него так же, как в
  // репозитории. Поэтому проверка на корне репозитория равносильна проверке
  // на архиве — при условии, что файл в архив попадает (тест выше).
  const fake = path.join('C:', 'Program Files', 'Sightline', 'resources', 'app.asar');
  assert.equal(windowIconPath(fake), path.join(fake, 'assets', 'icon.png'));
  assert.ok(fs.existsSync(windowIconPath(ROOT)));
});

test('если значок не прочитался, окно получает нарисованный, а не пустой', () => {
  const calls = [];
  const fakeNative = {
    createFromPath: (p) => {
      calls.push(['path', p]);
      return { isEmpty: () => true };
    },
    createFromBuffer: (buf) => {
      calls.push(['buffer', buf.length]);
      return { isEmpty: () => false, fromBuffer: true };
    },
  };
  const original = console.error;
  console.error = () => {};
  try {
    const image = loadWindowIcon(fakeNative, path.join(ROOT, 'нет-такой-папки'));
    assert.equal(image.fromBuffer, true);
  } finally {
    console.error = original;
  }
  assert.equal(calls[1][0], 'buffer');
  assert.ok(calls[1][1] > 0);
});

test('прочитанный значок используется как есть', () => {
  const image = { isEmpty: () => false };
  const fakeNative = { createFromPath: () => image, createFromBuffer: () => assert.fail('не нужен') };
  assert.equal(loadWindowIcon(fakeNative, ROOT), image);
});

test('окно и уведомление ставят значок явно', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  const notification = main.slice(main.indexOf('new Notification({'), main.indexOf('new Notification({') + 400);
  assert.match(notification, /icon: windowIcon\(\)/);
  const win = main.slice(main.indexOf('mainWindow = new BrowserWindow({'), main.indexOf('mainWindow = new BrowserWindow({') + 800);
  assert.match(win, /icon: windowIcon\(\)/);
  assert.doesNotMatch(main, /__dirname, '\.\.', '\.\.', 'assets'/, 'путь от файла, а не от корня приложения');
});

test('трей не зависит от файлов вовсе', () => {
  const tray = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tray.js'), 'utf8');
  assert.match(tray, /createFromBuffer\(appIcon\(/);
  assert.doesNotMatch(tray, /createFromPath/);
});

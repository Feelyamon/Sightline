'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const rules = require('../src/main/window-rules');
const { appIcon } = require('../src/main/icon');

// --- Показ и скрытие окна -------------------------------------------------

test('окно показывается, когда игра поднялась', () => {
  const on = { showOnGameStart: true };
  assert.equal(rules.onGameStatus('offline', 'idle', on), 'show');
  assert.equal(rules.onGameStatus('offline', 'battle', on), 'show');
  assert.equal(rules.onGameStatus('offline', 'idle', { showOnGameStart: false }), null);
});

test('окно прячется, когда игра закрылась, — только если так настроено', () => {
  assert.equal(rules.onGameStatus('battle', 'offline', { hideOnGameExit: true }), 'hide');
  assert.equal(rules.onGameStatus('battle', 'offline', { hideOnGameExit: false }), null);
});

test('переходы внутри запущенной игры окно не трогают', () => {
  const all = { showOnGameStart: true, hideOnGameExit: true };
  // Ангар ↔ бой случается десятки раз за вечер. Если реагировать на каждое
  // такое событие, окно будет выпрыгивать поверх игры без конца.
  assert.equal(rules.onGameStatus('idle', 'battle', all), null);
  assert.equal(rules.onGameStatus('battle', 'idle', all), null);
  assert.equal(rules.onGameStatus('offline', 'offline', all), null);
});

test('первый статус после запуска считается переходом', () => {
  // При старте предыдущего статуса нет: пустая строка — «игра не запущена».
  assert.equal(rules.onGameStatus('', 'battle', { showOnGameStart: true }), 'show');
  assert.equal(rules.onGameStatus('', 'offline', { hideOnGameExit: true }), null);
});

test('крестик прячет окно или закрывает программу по настройке', () => {
  assert.equal(rules.onWindowClose({ closeToTray: true }), 'hide');
  assert.equal(rules.onWindowClose({ closeToTray: false }), 'quit');
  assert.equal(rules.onWindowClose({}), 'quit');
});

test('предупреждение про трей показывается один раз и только при сворачивании', () => {
  assert.equal(rules.shouldWarnAboutTray({ closeToTray: true, trayNoticeShown: false }), true);
  assert.equal(rules.shouldWarnAboutTray({ closeToTray: true, trayNoticeShown: true }), false);
  assert.equal(rules.shouldWarnAboutTray({ closeToTray: false, trayNoticeShown: false }), false);
});

// --- Иконка ---------------------------------------------------------------

test('иконка приложения — PNG не меньше 256 пикселей', () => {
  // Один и тот же файл идёт в трей, на панель задач и в установщик.
  // electron-builder собирает из него .ico и требует не меньше 256; меньший
  // размер он молча не примет, и это выяснится на сборке релиза.
  const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));

  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'сигнатура PNG'
  );
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, height, 'иконка должна быть квадратной');
  assert.ok(width >= 256, `сторона ${width} — установщику нужно не меньше 256`);
});

test('знак для трея читается в шестнадцати пикселях', () => {
  // Лого нарисовано тонкими линиями и в этом размере превращается в светлое
  // пятно — проверено глазами на увеличенном снимке. Поэтому знак для трея
  // рисуется кодом сплошной заливкой. Тест проверяет не красоту, а то, ради
  // чего он и рисуется: что в кадре есть заметное пятно и есть прозрачный
  // фон — то есть что-то различимое, а не заливка целиком и не пустота.
  const size = 16;
  const png = appIcon(size);
  const start = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const length = png.readUInt32BE(start - 4);
  const raw = zlib.inflateSync(png.subarray(start + 4, start + 4 + length));

  let visible = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (raw[y * (size * 4 + 1) + 1 + x * 4 + 3] > 128) visible += 1;
    }
  }
  assert.ok(visible > size, `непрозрачных пикселей маловато: ${visible}`);
  assert.ok(visible < size * size * 0.8, 'фон должен остаться прозрачным');
});

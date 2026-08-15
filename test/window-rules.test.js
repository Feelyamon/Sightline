'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

test('иконка — валидный PNG нужного размера', () => {
  const png = appIcon(32);

  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'сигнатура PNG'
  );
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32, 'ширина');
  assert.equal(png.readUInt32BE(20), 32, 'высота');
  assert.equal(png[24], 8, 'бит на канал');
  assert.equal(png[25], 6, 'RGBA');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

test('в иконке действительно что-то нарисовано', () => {
  const size = 32;
  const png = appIcon(size);

  // Достаём IDAT и разжимаем: пустая картинка означала бы, что тест на
  // сигнатуру проходит, а в трее пусто.
  const start = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const length = png.readUInt32BE(start - 4);
  const raw = zlib.inflateSync(png.subarray(start + 4, start + 4 + length));

  let visible = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (raw[y * (size * 4 + 1) + 1 + x * 4 + 3] > 0) visible += 1;
    }
  }
  assert.ok(visible > size, `непрозрачных пикселей маловато: ${visible}`);
  assert.ok(visible < size * size, 'фон должен остаться прозрачным');
});

test('иконка строится в любом размере', () => {
  for (const size of [16, 32, 64]) {
    assert.equal(appIcon(size).readUInt32BE(16), size);
  }
});

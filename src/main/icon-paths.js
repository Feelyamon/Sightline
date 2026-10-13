'use strict';

const path = require('node:path');
const { appIcon } = require('./icon');

// Где программа берёт свой значок во время работы.
//
// Значок исполняемого файла, ярлыков и установщика — build/icon.ico, его
// вшивает electron-builder (см. scripts/make-ico.js). Здесь — то, что
// программа ставит сама: значок окна и уведомлений. Путь считается от корня
// приложения (app.getAppPath()): в сборке это resources/app.asar, в
// разработке — папка репозитория. В обоих случаях assets/ лежит прямо в
// корне, потому что package.json → build.files включает assets/**/*.
//
// Если файл всё-таки не прочитался (испорченная сборка, чужая раскладка),
// окно получает знак, нарисованный кодом, — тот же, что в трее. Пустой значок
// Windows заменяет стандартным «окошком», и это хуже любого своего.

/** Относительный путь значка от корня приложения. */
const WINDOW_ICON = path.join('assets', 'icon.png');

/**
 * Полный путь значка окна.
 * @param {string} root - корень приложения (app.getAppPath())
 */
const windowIconPath = (root) => path.join(root, WINDOW_ICON);

/**
 * Значок окна как nativeImage. Никогда не пустой.
 * @param {object} nativeImage - модуль electron.nativeImage
 * @param {string} root - корень приложения
 */
function loadWindowIcon(nativeImage, root) {
  const image = nativeImage.createFromPath(windowIconPath(root));
  if (!image.isEmpty()) return image;
  console.error(`значок не прочитался: ${windowIconPath(root)} — ставлю нарисованный`);
  return nativeImage.createFromBuffer(appIcon(256));
}

module.exports = { WINDOW_ICON, windowIconPath, loadWindowIcon };

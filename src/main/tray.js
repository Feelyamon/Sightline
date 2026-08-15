'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const { sightIcon } = require('./icon');

// Значок в трее и его меню. Единственный способ выйти из приложения
// по-настоящему, когда включено «сворачивать в трей»: крестик окна в этом
// режиме только прячет.

/**
 * @param {object} deps
 * @param {() => void} deps.onShow - показать окно
 * @param {() => void} deps.onSettings - открыть настройки
 * @param {() => void} deps.onQuit - выйти совсем
 * @param {(key: string) => string} deps.t - перевод
 */
function createTray({ onShow, onSettings, onQuit, t }) {
  const icon = nativeImage.createFromBuffer(sightIcon(32));
  // Windows берёт из значка 16 пикселей; отдаём 32 и просим уменьшить, иначе
  // на экранах с масштабированием иконка выглядит мыльной.
  icon.setTemplateImage(false);

  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  const state = { status: '', detail: '' };

  function rebuild() {
    const menu = Menu.buildFromTemplate([
      { label: t('tray.open'), click: onShow },
      // Строка состояния в меню, а не только в подсказке: по правой кнопке
      // видно, идёт бой или нет, не открывая окно.
      { label: state.status || t('tray.noData'), enabled: false },
      { type: 'separator' },
      { label: t('tab.settings'), click: onSettings },
      { type: 'separator' },
      { label: t('tray.quit'), click: onQuit },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`Sightline${state.status ? ` — ${state.status}` : ''}`);
  }

  tray.on('click', onShow);
  rebuild();

  return {
    /** Обновляет строку состояния в меню трея. */
    setStatus(text) {
      if (text === state.status) return;
      state.status = text;
      rebuild();
    },
    /** Язык сменился — пересобрать подписи. */
    refresh: rebuild,
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = { createTray };

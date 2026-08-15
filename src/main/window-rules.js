'use strict';

// Когда показывать и когда прятать окно.
//
// Отдельного слежения за процессом aces.exe здесь нет, и это осознанно.
// Приложение и так опрашивает локальный API игры раз в секунду: пока игра не
// запущена, порт молчит и статус — offline; как только игра поднялась, статус
// становится idle или battle. То есть «игра запущена» мы уже знаем бесплатно.
//
// Перебирать список процессов каждые несколько секунд (tasklist, WMI) значило
// бы решать ту же задачу второй раз и дороже: порождение процесса раз в пять
// секунд заметно на слабых машинах, а ради чего — непонятно.
//
// Из этого следует и то, как на самом деле работает «запускать вместе с
// игрой»: приложение стартует с системой тихо, в трее, и разворачивается,
// когда увидит игру. Иначе некому было бы её увидеть.

const RUNNING = new Set(['idle', 'battle']);

const isRunning = (status) => RUNNING.has(status);

/**
 * Что сделать с окном при смене статуса игры.
 * @param {string} previous - предыдущий статус
 * @param {string} next - новый статус
 * @param {{showOnGameStart?: boolean, hideOnGameExit?: boolean}} settings
 * @returns {'show'|'hide'|null} null — не трогать окно
 */
function onGameStatus(previous, next, settings = {}) {
  const was = isRunning(previous);
  const now = isRunning(next);
  // Реагируем только на переход, а не на каждое обновление статуса: иначе
  // окно всплывало бы поверх игры на любом чихе сети.
  if (was === now) return null;
  if (now) return settings.showOnGameStart ? 'show' : null;
  return settings.hideOnGameExit ? 'hide' : null;
}

/**
 * Что делать по нажатию на крестик.
 * @returns {'hide'|'quit'}
 */
const onWindowClose = (settings = {}) => (settings.closeToTray ? 'hide' : 'quit');

/**
 * Показывать ли разовое уведомление «программа осталась в трее».
 * Один раз за всё время — дальше человек уже знает.
 */
const shouldWarnAboutTray = (settings = {}) =>
  !!settings.closeToTray && !settings.trayNoticeShown;

module.exports = { onGameStatus, onWindowClose, shouldWarnAboutTray, isRunning };

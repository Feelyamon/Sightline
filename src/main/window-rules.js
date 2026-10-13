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

/**
 * Откладывает «спрятать окно» и отменяет его, если игра вернулась.
 *
 * Статус «игра закрыта» уже выставляется с запасом (wt-client.js ждёт, пока
 * игра промолчит дольше загрузки карты), но окно прячется не по одному
 * сигналу, а по подтверждённому: если за время ожидания игра снова
 * ответила, значит, это была пауза, а не выход. Окно, исчезающее посреди
 * загрузки боя, — ровно та жалоба, из-за которой это появилось; лишние
 * несколько секунд до скрытия после настоящего выхода никому не мешают.
 */
class HideDelay {
  /**
   * @param {object} opts
   * @param {number} [opts.delayMs]
   * @param {() => void} opts.hide - что сделать, когда ожидание вышло
   * @param {Function} [opts.setTimer] - подменяется в тестах
   * @param {Function} [opts.clearTimer]
   */
  constructor({ delayMs = HIDE_DELAY_MS, hide, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.delayMs = delayMs;
    this.hide = hide;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
  }

  get pending() {
    return this.timer !== null;
  }

  /** Решение onGameStatus пришло — что с ним делать. */
  apply(action, status) {
    if (action === 'hide') {
      if (this.timer === null) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.hide();
        }, this.delayMs);
      }
      return;
    }
    // Игра снова отвечает (ангар или бой) — отложенное скрытие отменяется.
    if (isRunning(status)) this.cancel();
  }

  cancel() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

// Сколько ждать после «игра закрыта», прежде чем прятать окно.
const HIDE_DELAY_MS = 10_000;

module.exports = {
  onGameStatus,
  onWindowClose,
  shouldWarnAboutTray,
  isRunning,
  HideDelay,
  HIDE_DELAY_MS,
};

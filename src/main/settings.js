'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  selfNick: '',
  alwaysOnTop: false,
  // Масштаб интерфейса целиком, включая графики. 1 — как есть, 1.5 — в
  // полтора раза крупнее. Отдельная настройка нужна не для красоты: мелкий
  // шрифт делает приложение бесполезным для части людей.
  uiScale: 1,
  // Пустая строка — язык ещё не выбирали. Тогда берётся английский:
  // договорённость такая, что до первого выбора интерфейс английский.
  uiLang: '',

  // Поведение окна и трея.
  closeToTray: true,
  launchWithSystem: false,
  showOnGameStart: true,
  hideOnGameExit: false,
  // Разовое предупреждение «программа осталась в трее» показывается один раз.
  trayNoticeShown: false,
  // Отряд в ПРОГРАММЕ: логины друзей, про которых человек сказал, что они с
  // ним. Игра состав отряда наружу не отдаёт, проверить этот список нечем —
  // и именно поэтому он живёт локально и собирается руками.
  squad: [],
  mainBounds: { width: 520, height: 480 },
  scoreboardBounds: { width: 720, height: 560 },
};

/** Настройки и геометрия окон в userData. Всё остальное живёт только в памяти. */
class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // Первый запуск или битый файл — просто остаёмся на умолчаниях.
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // Не критично: потеряем геометрию окна, но не работу приложения.
    }
  }
}

module.exports = { Settings, DEFAULTS };

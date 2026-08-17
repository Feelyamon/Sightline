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
  // Анонимный идентификатор установки: лимит сообщений о проблемах в сутки и
  // отсечение дублей. Заводится сам при первой отправке. В список
  // синхронизируемых не входит намеренно — он про установку, а не про человека.
  installId: '',
  // Отряд в ПРОГРАММЕ: логины друзей, про которых человек сказал, что они с
  // ним. Игра состав отряда наружу не отдаёт, проверить этот список нечем —
  // и именно поэтому он живёт локально и собирается руками.
  squad: [],
  mainBounds: { width: 520, height: 480 },
  scoreboardBounds: { width: 720, height: 560 },
};

/**
 * Что уезжает в учётную запись.
 *
 * Список закрытый и перечислен руками, а не «всё, кроме»: настройка, которую
 * забыли исключить, однажды приедет на чужую машину и что-нибудь там включит.
 * Добавлять сюда — осознанное действие.
 *
 * Чего здесь нет и почему:
 *   mainBounds, scoreboardBounds — мониторы разные, и чужая геометрия загонит
 *     окно за край экрана;
 *   trayNoticeShown — предупреждение показывается один раз НА МАШИНЕ, иначе на
 *     новом компьютере человек нажмёт крестик и решит, что программа закрылась;
 *   squad — набирается на один вечер под тех, с кем сейчас играешь, и к другому
 *     компьютеру отношения не имеет.
 */
const SYNCED = [
  'selfNick',
  'uiLang',
  'uiScale',
  'alwaysOnTop',
  'closeToTray',
  'launchWithSystem',
  'showOnGameStart',
  'hideOnGameExit',
];

/** Настройки и геометрия окон в userData. Всё остальное живёт только в памяти. */
class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = { ...DEFAULTS };
    /**
     * Когда каждая настройка менялась в последний раз, unix-мс.
     *
     * Нужно для слияния с сервером: при расхождении побеждает более поздняя
     * правка. Без этого пришлось бы выбирать между «сервер всегда прав» и
     * «машина всегда права», и оба варианта молча теряют то, что человек
     * поменял только что.
     */
    this.changedAt = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Времена лежат в самом файле, но настройкой не являются — иначе они
      // уехали бы на сервер как обычное значение.
      const { __changedAt: времена, ...значения } = raw;
      Object.assign(this.data, значения);
      if (времена && typeof времена === 'object') this.changedAt = времена;
    } catch {
      // Первый запуск или битый файл — просто остаёмся на умолчаниях.
    }
    /** Позвать, когда настройку поменяли: слой синхронизации отправит её. */
    this.onChanged = () => {};
  }

  /** Что синхронизируется. */
  static get SYNCED() {
    return SYNCED;
  }

  /** Настройки для отправки на сервер: значение и время правки. */
  syncPayload() {
    return SYNCED.map((key) => ({
      key,
      value: this.data[key],
      // Настройка, которую никогда не трогали, всё равно уезжает — но с нулём,
      // и на сервере её перебьёт что угодно осмысленное. Так гостевые
      // настройки поднимаются в аккаунт при первом входе, не затирая того, что
      // человек менял на другой машине.
      at: this.changedAt[key] || 0,
    }));
  }

  /**
   * Принимает настройки с сервера. Возвращает те, что реально применились, —
   * их надо не только записать, но и применить к окну.
   */
  applyRemote(items) {
    const применились = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!SYNCED.includes(item.key)) continue;
      const наше = this.changedAt[item.key] || 0;
      // Строго больше: при равном времени менять нечего, а лишняя запись
      // порождает лишнее событие и лишний круг отправки.
      if (!(Number(item.at) > наше)) continue;
      this.data[item.key] = item.value;
      this.changedAt[item.key] = Number(item.at);
      применились.push(item.key);
    }
    if (применились.length) this.save();
    return применились;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    if (SYNCED.includes(key)) {
      this.changedAt[key] = Date.now();
      this.save();
      // Применяется мгновенно и локально; уедет, когда будет куда.
      this.onChanged(key);
      return;
    }
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const наружу = { ...this.data, __changedAt: this.changedAt };
      fs.writeFileSync(this.file, JSON.stringify(наружу, null, 2), 'utf8');
    } catch {
      // Не критично: потеряем геометрию окна, но не работу приложения.
    }
  }
}

module.exports = { Settings, DEFAULTS, SYNCED };

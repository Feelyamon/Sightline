'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, Notification, dialog } = require('electron');

const { WtClient } = require('./wt-client');
const { BattleState } = require('./battle-state');
const { Settings } = require('./settings');
const { Db, windowStart } = require('./db');
const { classifyResult } = require('./battle-result');
const { classify, displayName } = require('./vehicle-class');
const locale = require('./locale');
const { createTray } = require('./tray');
const rules = require('./window-rules');
const { Account } = require('./account');

/** Дополняет строки статистики классом техники — renderer сам его не знает. */
const withVehicleClass = (rows) =>
  rows.map((r) => ({ ...r, class: classify(r.vehicle), label: displayName(r.vehicle) }));

const MOCK = process.argv.includes('--mock');

let settings;
let account;
let db;
let mainWindow = null;
let tray = null;
// Крестик по умолчанию прячет окно в трей, поэтому нужен отдельный признак
// настоящего выхода: иначе приложение нельзя было бы закрыть вообще.
let quitting = false;
let client = null;
let battle = null;
// Пока игра не найдена, статус — «Игра не запущена», и добавить к нему нечего.
// Приписка вроде «Запуск…» обещала бы, что программа сейчас запустит игру, —
// она этого не делает и делать не будет.
let status = { status: 'offline', detail: '' };
let pushScheduled = false;

// Границы текущего боя и защита от двойной записи: бой заканчивается либо
// выходом в ангар, либо стартом следующего — оба пути ведут сюда.
let battleStartedAt = null;
// id записи текущего боя в базе. Пока бой не сменился, повторные сохранения
// обновляют эту запись, а не создают новую — иначе один бой попадал в базу
// несколько раз и раздувал статистику.
let battleRowId = null;
// Последний исход из mission.json. Пока бой идёт там 'running', результат
// появляется в конце — держим его до момента записи боя.
let battleResult = 'unknown';
// Причина, по которой данные текущего боя считаются неполными. Пока она есть,
// бой пишется отменённым и в статистику не идёт. Сбрасывается вместе с боем.
let battleCancelReason = null;

/**
 * Помечает текущий бой неполным. Причин две, и обе дают одно состояние:
 * потеря связи с нашим сервером во время боя (её выставит слой синхронизации,
 * когда он появится) и пропуск строк в кил-фиде игры.
 * Первая причина побеждает: перезаписывать её более поздней незачем.
 */
function cancelBattle(reason) {
  if (battleCancelReason || !reason) return;
  battleCancelReason = reason;
  const dict = locale.dictionary(settings.get('uiLang'));
  send('app:error', dict[`cancel.${reason}`] || reason);
  schedulePush();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Снапшот шлём не чаще раза в 250 мс — кил-фид приходит пачками. */
function schedulePush() {
  if (pushScheduled) return;
  pushScheduled = true;
  setTimeout(() => {
    pushScheduled = false;
    send('battle:update', { ...battle.snapshot(), ...status });
  }, 250);
}

/** Записывает текущий бой в базу, если в нём есть что записывать. */
function persistBattle() {
  if (!battle) return;
  const snapshot = battle.snapshot();
  if (!snapshot.players.length) return;

  const opts = {
    startedAt: battleStartedAt || Date.now(),
    endedAt: Date.now(),
    result: battleResult,
    cancelReason: battleCancelReason,
  };
  try {
    battleRowId =
      battleRowId === null
        ? db.saveBattle(snapshot, opts)
        : db.updateBattle(battleRowId, snapshot, opts);
    send('db:changed');
  } catch (e) {
    // Единственная строка, которую собирает main: словарь берём тот же, что
    // и рендерер, иначе ошибка приходила бы на чужом языке.
    const dict = locale.dictionary(settings.get('uiLang'));
    const template = dict['error.saveBattle'] || 'Failed to record the battle: {message}';
    send('app:error', template.replace('{message}', e.message));
  }
}

// Границы масштаба: ниже 1 текст становится нечитаемым, выше 2 интерфейс
// перестаёт помещаться в окно.
const uiScale = () => Math.min(2, Math.max(1, Number(settings.get('uiScale')) || 1));

/** Язык, словарь и список доступных языков — одним куском для рендерера. */
function currentLocale() {
  const lang = locale.normalize(settings.get('uiLang'));
  return { lang, dict: locale.dictionary(lang), languages: locale.available() };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.hidden] - создать окно, но не показывать
 */
function createWindow({ hidden = false } = {}) {
  const bounds = settings.get('mainBounds') || {};
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    title: 'Sightline',
    // Без этого в заголовке окна и на панели задач висит логотип Electron.
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#12151a',
    // Окно создаётся скрытым и показывается по ready-to-show. Иначе при тихом
    // старте с системой оно успевало моргнуть на экране, а при обычном —
    // показывало пустой прямоугольник, пока грузится страница.
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });

  mainWindow.once('ready-to-show', () => {
    if (!hidden) mainWindow.show();
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setAlwaysOnTop(!!settings.get('alwaysOnTop'));

  // Масштаб переживает перезагрузку страницы только если ставить его каждый
  // раз заново: Electron сбрасывает его на 1 при новой загрузке документа.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(uiScale());
  });

  const saveBounds = () => {
    if (mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    settings.set('mainBounds', mainWindow.getBounds());
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  mainWindow.on('close', (e) => {
    if (quitting || rules.onWindowClose(settings.data) === 'quit') return;
    e.preventDefault();
    saveBounds();
    mainWindow.hide();
    warnAboutTrayOnce();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Один раз объясняем, что программа не закрылась, а свернулась. Без этого
 * человек нажимает крестик, видит, что окна нет, и считает, что вышел.
 */
function warnAboutTrayOnce() {
  if (!rules.shouldWarnAboutTray(settings.data)) return;
  settings.set('trayNoticeShown', true);
  if (!Notification.isSupported()) return;
  const dict = locale.dictionary(settings.get('uiLang'));
  new Notification({
    title: 'Sightline',
    body: dict['tray.stillRunning'] || 'The app is still running in the tray.',
  }).show();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  const dict = () => locale.dictionary(settings.get('uiLang'));
  tray = createTray({
    t: (key) => dict()[key] || key,
    onShow: showWindow,
    onSettings: () => {
      showWindow();
      send('app:openTab', 'settings');
    },
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });
}

/** Автозапуск с системой: тихо, сразу в трей. */
function applyLaunchWithSystem() {
  // В режиме разработки трогать автозапуск нельзя — в реестр попал бы путь до
  // electron.exe из node_modules.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!settings.get('launchWithSystem'),
    args: ['--tray'],
  });
}

function startClient() {
  battle = new BattleState(settings.get('selfNick'));
  client = new WtClient({ mock: MOCK });

  client.on('status', (s) => {
    // Ушли в ангар — бой закончился, самое время его записать.
    if (s.status !== 'battle') persistBattle();

    // Игра поднялась или закрылась — окно реагирует по настройкам. Отдельного
    // слежения за процессом игры не нужно: статус клиента и есть ответ на
    // вопрос «запущена ли игра». Подробности — в window-rules.js.
    const action = rules.onGameStatus(status.status, s.status, settings.data);
    if (action === 'show') showWindow();
    if (action === 'hide' && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

    status = s;
    if (tray) {
      const dict = locale.dictionary(settings.get('uiLang'));
      tray.setStatus(dict[`status.${s.status}`] || s.status);
    }
    schedulePush();
  });

  client.on('mission', (mission) => {
    // 'running' — бой идёт; результат появляется в конце и держится до записи.
    const parsed = classifyResult(mission.status);
    if (parsed === 'win' || parsed === 'loss') battleResult = parsed;
  });

  client.on('reset', () => {
    persistBattle(); // предыдущий бой, если его ещё не записали
    battle.reset();
    battleStartedAt = Date.now();
    battleRowId = null; // следующий бой — новая запись
    battleResult = 'unknown';
    battleCancelReason = null;
    schedulePush();
  });

  // Часть строк кил-фида до нас не дошла — считать по этим данным КДА нельзя.
  client.on('dataGap', () => cancelBattle('feedGap'));

  client.on('damage', (entry) => {
    battle.ingest(entry);
    schedulePush();
  });

  client.on('chat', (entry) => {
    if (battle.ingestChat(entry)) schedulePush();
  });

  client.on('error', (err) => {
    status = { status: 'offline', detail: err.message };
    schedulePush();
  });

  client.start();
}

// Второй запуск не поднимает вторую копию: две копии писали бы в одну базу.
// Вместо этого показываем окно уже работающей.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
  db = new Db(app.getPath('userData'));
  account = new Account(app.getPath('userData'));
  db.startSession(); // «бои с запуска» считаются от старта приложения
  startClient();
  setupTray();
  applyLaunchWithSystem();

  // Запуск с системой — тихий: окно готовится, но не показывается, чтобы не
  // выпрыгивать поверх рабочего стола при каждом входе в Windows.
  createWindow({ hidden: process.argv.includes('--tray') });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  persistBattle();
  if (client) client.stop();
  if (db) db.close();
  if (tray) tray.destroy();
});

// Закрытое окно больше не означает выход: программа живёт в трее, пока её не
// закроют оттуда явно. Выход по «window-all-closed» оставляем только для
// случая, когда сворачивание в трей выключено.
app.on('window-all-closed', () => {
  if (!settings || !settings.get('closeToTray')) app.quit();
});

// --- IPC ---------------------------------------------------------------

/**
 * Обёртка над ipcMain.handle: ловит ошибку обработчика, показывает её в окне
 * и пробрасывает дальше.
 *
 * Без этого любая ошибка в запросе к базе выглядела как зависание: обещание в
 * рендерере отклонялось, никто его не ловил, и вкладка просто переставала
 * обновляться — молча, без единого следа для пользователя.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      send('app:error', `${channel}: ${e.message}`);
      throw e;
    }
  });
}

// Ошибка, до которой не дотянулся ни один catch, не должна валить приложение
// целиком: пользователь в бою, и потерять запись боя из-за сбоя в постороннем
// месте — худший исход, чем потерпеть неисправность.
process.on('unhandledRejection', (reason) => {
  send('app:error', `Внутренняя ошибка: ${reason?.message || reason}`);
});
process.on('uncaughtException', (e) => {
  send('app:error', `Внутренняя ошибка: ${e.message}`);
});

handle('app:getState', () => ({
  ...battle.snapshot(),
  ...status,
  mock: MOCK,
  alwaysOnTop: !!settings.get('alwaysOnTop'),
  uiScale: uiScale(),
  ...currentLocale(),
}));

handle('app:about', () => ({
  version: app.getVersion(),
  license: require('../../package.json').license,
  electron: process.versions.electron,
  node: process.versions.node,
  dbFile: db.stats().file,
}));

handle('app:setLang', (_e, lang) => {
  settings.set('uiLang', locale.normalize(lang));
  if (tray) tray.refresh();
  return currentLocale();
});

// Галочки поведения окна: их немного и они однотипные, поэтому один обработчик
// на все вместо четырёх почти одинаковых.
const WINDOW_FLAGS = ['closeToTray', 'launchWithSystem', 'showOnGameStart', 'hideOnGameExit'];

handle('app:setWindowFlag', (_e, name, value) => {
  if (!WINDOW_FLAGS.includes(name)) throw new Error(`Неизвестная настройка: ${name}`);
  settings.set(name, !!value);
  if (name === 'launchWithSystem') applyLaunchWithSystem();
  return !!value;
});

handle('app:windowFlags', () =>
  Object.fromEntries(WINDOW_FLAGS.map((name) => [name, !!settings.get(name)]))
);

handle('app:setUiScale', (_e, value) => {
  settings.set('uiScale', Number(value) || 1);
  const scale = uiScale();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(scale);
  return scale;
});

handle('app:setNick', (_e, nick) => {
  const clean = String(nick || '').trim();
  settings.set('selfNick', clean);
  battle.setSelfNick(clean);
  schedulePush();
  return clean;
});

handle('app:setAlwaysOnTop', (_e, value) => {
  const on = !!value;
  settings.set('alwaysOnTop', on);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(on);
  return on;
});

handle('app:resetBattle', () => {
  battle.reset();
  battleStartedAt = Date.now();
  battleRowId = null;
  battleCancelReason = null;
  schedulePush();
});

handle('account:state', () => account.state());
handle('account:checkVersion', () => account.checkVersion());
handle('account:register', (event, form) =>
  // Прогресс отдаём в то же окно, откуда пришёл запрос: считать приходится
  // секунды, и без полосы человек решит, что программа зависла.
  account.register(form || {}, (tried) => {
    if (!event.sender.isDestroyed()) event.sender.send('account:proofProgress', tried);
  })
);
handle('account:signIn', (_e, form) => account.signIn(form || {}));
handle('account:saveRecoveryCode', async (_e, code) => {
  // Диалог сохранения, а не тихая запись в заранее выбранную папку: человек
  // должен знать, где лежит единственный ключ от его аккаунта.
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'sightline-recovery-code.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return null;
  const dict = locale.dictionary(settings.get('uiLang'));
  const title = dict['code.title'] || 'recovery code';
  const lead = dict['code.lead'] || '';
  require('node:fs').writeFileSync(filePath, `Sightline — ${title}\n\n${code}\n\n${lead}\n`, 'utf8');
  return filePath;
});

handle('app:openExternal', (_e, page) => {
  // Только свои страницы и только из белого списка: передавать в браузер
  // произвольный адрес из окна — способ открыть что угодно чужими руками.
  const pages = { terms: '/terms', privacy: '/privacy', rights: '/rights' };
  const route = pages[page];
  if (!route) throw new Error('неизвестная страница');
  return shell.openExternal('https://sightline.feelyamon.ru' + route);
});

handle('account:openDownload', () => {
  // Адрес приходит с сервера, поэтому проверяем его тут, а не доверяем на
  // слово: подменённый ответ не должен уметь открыть человеку что угодно.
  const raw = account.version?.downloadUrl || 'https://sightline.feelyamon.ru/';
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'sightline.feelyamon.ru') {
    throw new Error('адрес обновления не с нашего сайта');
  }
  return shell.openExternal(url.href);
});

handle('account:signOut', () => account.signOut());

handle('db:counters', () => db.counters());
handle('db:stats', () => db.stats());
handle('db:recentBattles', (_e, limit) => db.recentBattles(limit));

handle('db:searchBattles', (_e, opts = {}) => {
  // Календарные окна («за неделю») считаем здесь — renderer шлёт либо готовый
  // диапазон дат, либо имя периода, но не занимается арифметикой сам.
  const from = opts.from || (opts.period ? windowStart(opts.period) : 0);
  return db.searchBattles({ ...opts, from, selfNick: settings.get('selfNick') });
});

handle('db:topPlayers', (_e, opts = {}) => {
  // «Часто попадался за месяц» — окно считаем здесь, чтобы renderer не знал
  // про календарную арифметику.
  const since = opts.period ? windowStart(opts.period) : 0;
  return db.topPlayers({ ...opts, since, excludeNick: settings.get('selfNick') });
});

handle('db:playerCard', (_e, nick) => db.playerCard(nick));
handle('db:dossier', (_e, nicks) => db.dossier(nicks, settings.get('selfNick')));
handle('db:myVehicles', (_e, opts = {}) =>
  withVehicleClass(
    db.myVehicles(settings.get('selfNick'), { since: opts.period ? windowStart(opts.period) : 0 })
  )
);
handle('db:enemyVehicles', (_e, opts = {}) =>
  withVehicleClass(db.enemyVehicles({ since: opts.period ? windowStart(opts.period) : 0 }))
);
handle('db:winrate', (_e, opts = {}) =>
  db.winrate({ since: opts.period ? windowStart(opts.period) : 0 })
);
handle('db:activityByHour', (_e, opts = {}) =>
  db.activityByHour({ from: opts.period ? windowStart(opts.period) : 0 })
);
handle('db:dailyStats', (_e, opts = {}) =>
  db.dailyStats({ from: opts.period ? windowStart(opts.period) : 0 })
);
handle('db:streaks', (_e, opts = {}) => db.streaks(opts));

handle('db:setNote', (_e, nick, note) => db.setNote(nick, note));
handle('db:battleDetails', (_e, id) => db.battleDetails(id));
handle('db:resetCounter', (_e, name) => {
  db.resetCounter(name);
  return db.counters();
});

handle('db:deleteBattle', (_e, id) => {
  db.deleteBattle(id);
  send('db:changed');
});

handle('db:clearHistory', (_e, opts = {}) => db.clearHistory(opts));
handle('db:clearPlayers', () => db.clearPlayers());
handle('db:reveal', () => shell.showItemInFolder(db.stats().file));

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
const { Friends } = require('./friends');
const { Avatars } = require('./avatars');
const { Sync, battlePayload } = require('./sync');
const config = require('./config');

// Схему адресов аватарок объявляем до готовности приложения — позже окно её
// уже не увидит.
Avatars.registerScheme();

/** Дополняет строки статистики классом техники — renderer сам его не знает. */
const withVehicleClass = (rows) =>
  rows.map((r) => ({ ...r, class: classify(r.vehicle), label: displayName(r.vehicle) }));

const MOCK = process.argv.includes('--mock');

let settings;
let account;
let friends;
let avatars;
let sync;
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
/**
 * @param {object} [opts]
 * @param {boolean} [opts.final] - бой точно закончился, можно отправлять
 */
function persistBattle({ final = false } = {}) {
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

    // На сервер бой уходит только когда он кончился: пока идёт, состав и счёт
    // ещё меняются, и отправлять промежуточные версии значит слать одно и то
    // же по десять раз. Ключ очереди — локальный id, поэтому повторный вызов
    // заменяет запись, а не добавляет вторую.
    if (final) sync.enqueue(battleRowId, battlePayload(snapshot, opts));
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
    // Ушли в ангар — бой закончился, самое время его записать и отправить.
    if (s.status !== 'battle') persistBattle({ final: true });

    // Живой обмен идёт только в бою: в ангаре делиться нечем, а держать
    // запись о себе означало бы показывать соседям бой, которого уже нет.
    if (s.status === 'battle') startLive();
    else stopLive();

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
    // Начался следующий бой — значит предыдущий кончился окончательно, даже
    // если в ангар между ними мы не заходили. Без final: true бой, за которым
    // сразу пошёл новый, никогда бы не уехал на сервер.
    persistBattle({ final: true });
    battle.reset();
    // Состав нового боя другой: спрашивать про него надо заново.
    peersAsked = new Set();
    peersFound = new Set();
    // И запись о живом бое тоже: у нового боя другой состав, и старая мешала
    // бы соседям находить друг друга.
    liveActive = false;
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
    schedulePeers();
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

/**
 * Друзья: список, присутствие и отряд.
 *
 * Список нужен разбору боя, а не только окну: отряд из программы — это якорь
 * для графа команд. Поэтому он живёт в main и обновляется независимо от того,
 * открыто ли окно друзей.
 */
// Кто из участников текущего боя пользуется программой.
//
// Спрашиваем не на каждое событие, а когда состав ПОПОЛНИЛСЯ: в начале боя
// ники прибывают пачками, и запрос на каждого означал бы полсотни обращений
// за минуту ради одного и того же ответа.
let peersAsked = new Set();
let peersFound = new Set();
let peersTimer = null;

// --- Живой обмен во время боя (этап 12) ------------------------------------
//
// Кил-фид у всех в бою одинаковый, различается только якорь: каждый клиент
// знает лишь то, в какой команде он сам. Второй пользователь в том же бою даёт
// вторую точку отсчёта, и висящая группа определяется сразу, а не через
// полторы минуты.
//
// Пять секунд — по решению владельца. Чаще незачем: команды важны в первые
// полторы минуты, а не мгновенно. В ангаре обмена нет вовсе.
const LIVE_MS = 5_000;
let liveTimer = null;
let liveActive = false;

function startLive() {
  if (liveTimer || !account.isSignedIn) return;
  liveTimer = setInterval(pushLive, LIVE_MS);
  pushLive();
}

function stopLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  if (!liveActive) return;
  liveActive = false;
  // Убираем запись сразу, а не ждём, пока она протухнет: иначе сосед ещё
  // несколько минут видел бы «в бою есть второй» после того, как второй вышел.
  account.request('/battles/live/leave', { method: 'POST', body: {}, auth: true }).catch(() => {});
}

async function pushLive() {
  if (!account.isSignedIn || status.status !== 'battle') return;
  const snap = battle.snapshot();
  if (!snap.players.length) return;

  try {
    const answer = await account.request('/battles/live', {
      method: 'POST',
      body: {
        nicks: snap.players.map((p) => p.nick),
        // Мой якорь: кого я уже определил. Это и есть то, что помогает соседу.
        allies: snap.players.filter((p) => p.team === 'ally').map((p) => p.nick),
        enemies: snap.players.filter((p) => p.team === 'enemy').map((p) => p.nick),
        // Строки уходят, но обратно пока не применяются — см. ниже.
        lines: [],
      },
      auth: true,
    });
    liveActive = true;

    // Чужой якорь вливаем в граф. Стороны сосед не переворачивал и не мог:
    // свою знает только он сам. Разбирается граф — см. applyPeerAnchor.
    if (answer?.allies?.length || answer?.enemies?.length) {
      battle.applyPeerAnchor(answer);
      schedulePush();
    }

    // ЧЕГО ЗДЕСЬ ПОКА НЕТ И ПОЧЕМУ. Чужие строки кил-фида сервер уже отдаёт, но
    // вливать их в разбор нельзя без защиты от двойного счёта: одно и то же
    // событие видят оба клиента, а различить «он убил его дважды» и «одна и та
    // же строка от двоих» по тексту невозможно — время игра держит отдельно от
    // текста. Посчитать фраг дважды хуже, чем не дозаполнить пропуск.
  } catch {
    // Сервера нет — обмена нет. Разбор боя от этого не страдает: он работает
    // на своих данных и без сети вообще.
  }
}

function schedulePeers() {
  if (!account.isSignedIn || peersTimer) return;
  peersTimer = setTimeout(async () => {
    peersTimer = null;
    const nicks = battle.snapshot().players.map((p) => p.nick);
    const fresh = nicks.filter((n) => !peersAsked.has(n));
    if (!fresh.length) return;
    for (const n of nicks) peersAsked.add(n);

    try {
      // Спрашиваем про весь состав, а не только про новых: ответ про старых
      // мог измениться — человек мог заявить свой ник только что.
      const { users } = await account.request('/battles/peers', {
        method: 'POST',
        body: { nicks },
        auth: true,
      });
      peersFound = new Set(users || []);
      battle.setKnownPlayers({
        squad: friends.squadNicks(),
        friends: friends.friendNicks(),
        users: [...peersFound],
      });
      schedulePush();
    } catch {
      // Нет сети или сервер отказал — подчёркивания просто не будет.
      // Разбор боя от этого не зависит вообще.
    }
  }, 3000);
}

/**
 * Применяет настройку к окну и системе.
 *
 * Отдельной функцией, потому что теперь у настройки два источника: человек
 * нажал в окне и настройка приехала с сервера. Раньше применение жило внутри
 * обработчиков IPC, и приехавшее с сервера значение записалось бы в файл, не
 * включив ничего.
 */
function applySetting(key) {
  if (key === 'uiScale' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(uiScale());
  }
  if (key === 'alwaysOnTop' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(!!settings.get('alwaysOnTop'));
  }
  if (key === 'launchWithSystem') applyLaunchWithSystem();
  if (key === 'selfNick' && battle) {
    battle.setSelfNick(settings.get('selfNick'));
    schedulePush();
  }
  if (key === 'uiLang') {
    send('app:localeChanged', currentLocale());
    if (tray) tray.refresh();
  }
}

/** Отправка настроек: не чаще раза в две секунды и только когда есть вход. */
let settingsTimer = null;
let settingsDirty = false;

function scheduleSettingsSync() {
  settingsDirty = true;
  if (settingsTimer) return;
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    syncSettings();
  }, 2000);
}

async function syncSettings() {
  if (!account.isSignedIn) return;
  settingsDirty = false;
  try {
    const answer = await account.syncSettings(settings.syncPayload());
    const применились = settings.applyRemote(answer?.items);
    for (const key of применились) applySetting(key);
    if (применились.length) {
      send('settings:changed', { keys: применились, locale: currentLocale() });
    }
  } catch {
    // Сервера нет — работаем на своих. Настройки применяются мгновенно и без
    // сети; несделанная отправка не должна ничего ломать и ни о чём
    // сообщать. Отправим при следующей правке или при следующем входе.
    settingsDirty = true;
  }
}

function startFriends() {
  friends.onChange = (state) => {
    battle.setKnownPlayers({ squad: friends.squadNicks(), friends: friends.friendNicks() });
    send('friends:update', state);
    schedulePush();
  };

  // Пришло приглашение — окно должно показаться человеку, даже если программа
  // свёрнута в трей. Иначе приглашение протухнет за минуту, и позвавший решит,
  // что его игнорируют.
  friends.onInvites = (invites) => {
    send('friends:invites', invites);
    if (invites.length && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  };

  friends.start(() => {
    const snap = battle.snapshot();
    const me = snap.players.find((p) => p.isSelf);
    return {
      // «Не в сети» не отправляем никогда — см. friends.js. Пока программа
      // работает, человек как минимум в ангаре.
      status: status.status === 'battle' ? 'battle' : 'hangar',
      kills: me?.kills || 0,
      deaths: me?.deaths || 0,
      assists: me?.assists || 0,
    };
  });
}

// Второй запуск не поднимает вторую копию: две копии писали бы в одну базу.
// Вместо этого показываем окно уже работающей.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

app.whenReady().then(() => {
  // Windows связывает окно с приложением по этому идентификатору. Без него
  // панель задач считает программу «каким-то Electron» и рисует его логотип
  // вместо нашего — независимо от того, какая иконка задана окну. Значение
  // обязано совпадать с appId из package.json, иначе установленная программа
  // и запущенная из исходников окажутся для системы разными приложениями.
  if (process.platform === 'win32') app.setAppUserModelId('ru.feelyamon.sightline');

  settings = new Settings(app.getPath('userData'));
  db = new Db(app.getPath('userData'));
  account = new Account(app.getPath('userData'));
  friends = new Friends(account, settings);
  // Состояние связи с сервером идёт в шапку отдельным индикатором. Раньше
  // такие сообщения попадали в строку игры и затирали «В бою» — во время боя
  // человек терял из виду ровно то, ради чего программа открыта.
  account.onServerState = (info) => send('server:status', info);
  avatars = new Avatars(app.getPath('userData'));
  avatars.install();
  sync = new Sync(app.getPath('userData'), account, db);
  // Отметка доверия поменялась — список боёв надо перерисовать, иначе галочка
  // появится только после переключения вкладки.
  sync.onTrustChanged = () => send('db:changed');
  sync.start();
  // Настройка поменялась в окне — уедет в учётную запись. Применение при этом
  // мгновенное и не ждёт сети: программа обязана слушаться сразу.
  settings.onChanged = () => scheduleSettingsSync();
  // При старте забираем то, что могло измениться на другой машине.
  syncSettings();
  db.startSession(); // «бои с запуска» считаются от старта приложения
  startClient();
  startFriends();
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
/**
 * Метка, по которой окно узнаёт свою же ошибку в чужой обёртке.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Через ipcMain.handle наружу переживает только текст:
 * Electron заворачивает исключение в собственную ошибку с сообщением вида
 * «Error invoking remote method 'x': Error: …», а свои поля выбрасывает. Из-за
 * этого проверки e.offline в окне не срабатывали ни разу за всё время, и
 * человек вместо «нет связи с сервером» читал строчку про remote method.
 *
 * Поэтому поля едут внутри текста, а preload собирает ошибку обратно.
 * Некрасиво, но альтернатива — возвращать объект вместо исключения из каждого
 * обработчика, то есть переписать способ сообщать об ошибках целиком.
 */
const ERR_MARK = 'SIGHTLINE_ERR:';

function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      send('app:error', `${channel}: ${e.message}`);
      throw new Error(
        ERR_MARK +
          JSON.stringify({
            message: e.message,
            offline: !!e.offline,
            code: e.code,
            status: e.status,
            retryAfter: e.retryAfter,
          })
      );
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
  repo: repoUrl(),
  electron: process.versions.electron,
  node: process.versions.node,
  dbFile: db.stats().file,
}));

// Адрес репозитория берём из package.json, а не пишем второй раз строкой:
// разъехаться два места однажды разъедутся, и в окне окажется адрес, которого
// больше нет. Форма «git+https://…​.git» — та, что понимает npm; человеку
// показываем обычную ссылку.
function repoUrl() {
  const raw = require('../../package.json').repository?.url || '';
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  return url.startsWith('https://') ? url : '';
}

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

handle('app:setNick', async (_e, nick) => {
  const clean = String(nick || '').trim();
  settings.set('selfNick', clean);
  battle.setSelfNick(clean);
  schedulePush();

  // Ник уходит на сервер, иначе друзья не узнают человека в бою: в списке он
  // под логином, а в кил-фиде — под игровым ником. Молча: если ник занят или
  // сервер недоступен, локально всё продолжает работать, а ругаться на это
  // прямо во время правки поля незачем.
  if (account.isSignedIn && clean) {
    try {
      await account.request('/auth/nick', { method: 'POST', body: { nick: clean }, auth: true });
    } catch (e) {
      console.error('не удалось заявить игровой ник:', e.message);
    }
  }
  return clean;
});

handle('account:chooseAvatar', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PNG, JPEG', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (canceled || !filePaths?.length) return null;

  const bytes = require('node:fs').readFileSync(filePaths[0]);
  // Мегабайт — столько принимает сервер. Отсекаем здесь, чтобы человек узнал
  // об этом сразу, а не после того, как файл уехал по сети.
  if (bytes.length > 1024 * 1024) throw new Error('картинка больше мегабайта');

  const type = /\.png$/i.test(filePaths[0]) ? 'image/png' : 'image/jpeg';
  const result = await account.request('/avatar', {
    method: 'POST',
    raw: bytes,
    contentType: type,
    auth: true,
  });
  await friends.refresh();
  return result;
});

handle('account:removeAvatar', async () => {
  const result = await account.request('/avatar', { method: 'DELETE', auth: true });
  await friends.refresh();
  return result;
});

// --- Сообщение о проблеме ------------------------------------------------

handle('support:reportPlayer', (_e, form = {}) =>
  // Жалоба на игрока едет тем же методом: разбирает её тот же человек тем же
  // списком, и заводить рядом второй путь значило бы писать админку дважды.
  account.request('/bugs', {
    method: 'POST',
    body: {
      kind: 'player',
      target_nick: String(form.nick || ''),
      message: String(form.message || ''),
      app_version: app.getVersion(),
      os_version: `${process.platform} ${require('node:os').release()}`,
    },
    auth: true,
  })
);

handle('support:send', (_e, form = {}) =>
  // Версии проставляем здесь, а не спрашиваем у человека: он их не знает и не
  // обязан, а без них половина сообщений неразбираема.
  account.request('/bugs', {
    method: 'POST',
    body: {
      message: String(form.message || ''),
      kind: form.kind || 'bug',
      tag: String(form.tag || 'other'),
      title: form.title ? String(form.title) : undefined,
      steps: form.steps ? String(form.steps) : undefined,
      // Приложенные сведения уходят только если человек их оставил. Отказался —
      // приходит пустое поле, а не тихо всё то же самое.
      context: form.context || null,
      install_id: installId(),
      app_version: app.getVersion(),
      os_version: `${process.platform} ${require('node:os').release()}`,
    },
    // Вход необязателен: у кого не работает именно вход, тот иначе не сможет
    // пожаловаться ровно на это.
    auth: account.isSignedIn,
  })
);

handle('support:mine', () => account.request('/bugs/mine', { auth: true }));

handle('support:context', () => ({
  appVersion: app.getVersion(),
  osVersion: `${process.platform} ${require('node:os').release()}`,
  signedIn: account.isSignedIn,
  login: account.state().login,
  lang: locale.normalize(settings.get('uiLang')),
  // Состояние игры на момент жалобы: половина сообщений про «не видит игру»
  // разбирается одной этой строкой.
  gameStatus: status.status,
  // Строки кил-фида, которые разобрать не удалось. Это самый полезный
  // приложенный материал: по ним чинится парсер, и присылать их иначе неоткуда.
  unparsed: battle ? battle.snapshot().unparsed.slice(-10) : [],
  // Анонимный идентификатор установки: по нему считается лимит сообщений в
  // сутки и отсекаются дубли. С человеком не связан и в разборе не виден.
  installId: installId(),
}));

/**
 * Идентификатор установки. Случайный, заводится один раз и живёт в настройках.
 *
 * Он не про человека и не про машину: по нему нельзя узнать ни того, ни
 * другого. Он нужен ровно для двух вещей — не дать одной установке засыпать
 * сервер сообщениями и склеить десять нажатий «отправить» в одно.
 */
function installId() {
  let id = settings.get('installId');
  if (!id) {
    id = require('node:crypto').randomUUID();
    settings.set('installId', id);
  }
  return id;
}

// --- Администрирование ----------------------------------------------------
//
// Права проверяет сервер типом аргумента обработчика. Здесь только передача:
// прятать кнопку в интерфейсе защитой не является и таковой не считается.

handle('admin:findUsers', (_e, query) =>
  account.request(`/admin/users?q=${encodeURIComponent(String(query || ''))}`, { auth: true })
);
// Опасные действия подтверждаются паролем самого администратора. Пароль здесь
// только пересылается — не хранится, не логируется и в состояние не попадает.
handle('admin:newRecoveryCode', (_e, accountId, confirm) =>
  account.request('/admin/recovery-code', {
    method: 'POST',
    body: { account_id: accountId, confirm_password: confirm || null },
    auth: true,
  })
);
handle('admin:setPassword', (_e, accountId, newPassword, confirm) =>
  account.request('/admin/password', {
    method: 'POST',
    body: {
      account_id: accountId,
      new_password: String(newPassword || ''),
      confirm_password: confirm || null,
    },
    auth: true,
  })
);
handle('admin:block', (_e, accountId, blocked, reason, confirm) =>
  account.request('/admin/block', {
    method: 'POST',
    body: {
      account_id: accountId,
      blocked: !!blocked,
      reason: reason || null,
      confirm_password: confirm || null,
    },
    auth: true,
  })
);
handle('admin:setRole', (_e, accountId, role, confirm) =>
  account.request('/admin/role', {
    method: 'POST',
    body: {
      account_id: accountId,
      role: String(role || 'user'),
      confirm_password: confirm || null,
    },
    auth: true,
  })
);
handle('admin:log', () => account.request('/admin/log', { auth: true }));
handle('admin:vehicles', () => account.request('/admin/vehicles', { auth: true }));
handle('admin:setVehicleAlias', (_e, alias, canonical) =>
  account.request('/admin/vehicles/alias', {
    method: 'POST',
    body: { alias: String(alias || ''), canonical: String(canonical || '') },
    auth: true,
  })
);
handle('admin:clearAvatar', (_e, accountId) =>
  account.request('/admin/avatar/clear', {
    method: 'POST',
    body: { account_id: accountId },
    auth: true,
  })
);
handle('admin:reports', (_e, scope) =>
  account.request(`/admin/bugs?scope=${scope === 'all' ? 'all' : 'open'}`, { auth: true })
);
handle('admin:resolveReport', (_e, id, resolved, note) =>
  account.request('/admin/bugs/resolve', {
    method: 'POST',
    body: { id, resolved: resolved !== false, note: note || null },
    auth: true,
  })
);

handle('friends:state', () => friends.state());
handle('friends:refresh', () => friends.refresh());
handle('friends:search', (_e, query) => friends.search(String(query || '')));
handle('friends:request', (_e, login) => friends.act('request', String(login || '')));
handle('friends:accept', (_e, login) => friends.act('accept', String(login || '')));
handle('friends:remove', (_e, login) => friends.act('remove', String(login || '')));

handle('friends:addToSquad', (_e, login) => {
  friends.addToSquad(String(login || ''));
  friends.onChange(friends.state());
  return friends.state();
});
handle('friends:removeFromSquad', (_e, login) => {
  friends.removeFromSquad(String(login || ''));
  friends.onChange(friends.state());
  return friends.state();
});

// Приглашения в отряд. Позвать может только тот, кто уже друг, — это проверяет
// сервер, а не окно: спрятанная кнопка защитой не является.
handle('friends:invite', (_e, login) => friends.invite(String(login || '')));
handle('friends:acceptInvite', (_e, id) => friends.accept(Number(id)));
handle('friends:declineInvite', (_e, id) => friends.decline(Number(id)));

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
handle('account:checkVersion', async () => {
  const version = await account.checkVersion();
  // Заодно подтягиваем роль: она лежит в сохранённой сессии и сама не
  // меняется, а права могли выдать уже после входа.
  if (!version || version.ok !== false) await account.refreshMe();
  return version;
});
handle('account:register', async (event, form) => {
  // Прогресс отдаём в то же окно, откуда пришёл запрос: считать приходится
  // секунды, и без полосы человек решит, что программа зависла.
  const state = await account.register(form || {}, (tried) => {
    if (!event.sender.isDestroyed()) event.sender.send('account:proofProgress', tried);
  });
  await afterSignIn();
  return state;
});
handle('account:signIn', async (_e, form) => {
  const state = await account.signIn(form || {});
  await afterSignIn();
  return state;
});

/**
 * Что делается сразу после входа: заявить игровой ник и подтянуть друзей.
 *
 * Ник заявляем именно здесь, а не только при его правке: человек мог вписать
 * его до того, как завёл аккаунт, — и тогда на сервере ника нет, а друзья не
 * узнают его в бою.
 */
async function afterSignIn() {
  const nick = settings.get('selfNick');
  if (nick) {
    try {
      await account.request('/auth/nick', { method: 'POST', body: { nick }, auth: true });
    } catch (e) {
      console.error('не удалось заявить игровой ник:', e.message);
    }
  }
  await friends.refresh();
  // Настройки: гостевые поднимаются в аккаунт как есть, а то, что человек
  // менял на другой машине и что свежее, приезжает сюда. Настройки — не
  // статистика, подделывать в них нечего, и запрет на загрузку накопленной до
  // регистрации истории сюда не относится.
  await syncSettings();
  // Бои, накопившиеся в очереди до входа, ждали именно этого момента.
  sync.start();
}
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
  if (route) return shell.openExternal(config.site + route);

  // Репозиторий живёт на чужом хосте, поэтому идёт отдельной веткой, а не
  // подклеивается к адресу сайта. Проверяем то же, что и у адреса обновления:
  // https и заранее известный хост.
  if (page === 'repo') {
    const raw = repoUrl();
    if (!raw) throw new Error('адрес репозитория не задан');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      throw new Error('адрес репозитория не с github.com');
    }
    return shell.openExternal(url.href);
  }

  throw new Error('неизвестная страница');
});

handle('account:openDownload', () => {
  // Адрес приходит с сервера, поэтому проверяем его тут, а не доверяем на
  // слово: подменённый ответ не должен уметь открыть человеку что угодно.
  const raw = account.version?.downloadUrl || config.site;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== config.host) {
    throw new Error('адрес обновления не с нашего сайта');
  }
  return shell.openExternal(url.href);
});

// Задать пароль после админского сброса. Без входа: войти человек как раз и
// не может — подходящего пароля не существует, а сессии закрыты. Единственный
// ключ здесь — код восстановления, который у него есть с регистрации.
handle('account:forcedPassword', (_e, form = {}) =>
  account.forcedPassword({
    login: String(form.login || ''),
    recoveryCode: String(form.recoveryCode || ''),
    newPassword: String(form.newPassword || ''),
  })
);

handle('account:notifications', () => account.request('/notifications', { auth: true }));

// Публичные профили. Оба метода требуют входа: поиск по чужим никам не стоит
// открывать всему интернету, и сервер это тоже проверяет.
handle('profile:search', (_e, q) =>
  account.request(`/profile/search?q=${encodeURIComponent(String(q || ''))}`, { auth: true })
);
handle('profile:get', (_e, who) =>
  account.request(`/profile?who=${encodeURIComponent(String(who || ''))}`, { auth: true })
);
handle('account:readNotifications', (_e, id) =>
  account.request('/notifications/read', { method: 'POST', body: { id: id ?? null }, auth: true })
);

handle('account:signOut', async () => {
  const state = await account.signOut();
  // Список друзей чужой памяти не оставляет: вышел — и в окне пусто.
  await friends.refresh();
  return state;
});

handle('account:changePassword', (_e, form = {}) => account.changePassword(form));

handle('account:logoutAll', async () => {
  const state = await account.logoutAll();
  await friends.refresh();
  return state;
});

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

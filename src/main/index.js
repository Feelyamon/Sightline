'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const { WtClient } = require('./wt-client');
const { BattleState } = require('./battle-state');
const { Settings } = require('./settings');
const { Db, windowStart } = require('./db');

const MOCK = process.argv.includes('--mock');

let settings;
let db;
let mainWindow = null;
let client = null;
let battle = null;
let status = { status: 'offline', detail: 'Запуск…' };
let pushScheduled = false;

// Границы текущего боя и защита от двойной записи: бой заканчивается либо
// выходом в ангар, либо стартом следующего — оба пути ведут сюда.
let battleStartedAt = null;
let battleSaved = false;

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
  if (battleSaved || !battle) return;
  const snapshot = battle.snapshot();
  if (!snapshot.players.length) return;
  try {
    db.saveBattle(snapshot, { startedAt: battleStartedAt || Date.now(), endedAt: Date.now() });
    battleSaved = true;
    send('db:changed');
  } catch (e) {
    send('app:error', `Не удалось записать бой: ${e.message}`);
  }
}

function createWindow() {
  const bounds = settings.get('mainBounds') || {};
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    title: 'Sightline',
    backgroundColor: '#12151a',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setAlwaysOnTop(!!settings.get('alwaysOnTop'));

  const saveBounds = () => {
    if (mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    settings.set('mainBounds', mainWindow.getBounds());
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startClient() {
  battle = new BattleState(settings.get('selfNick'));
  client = new WtClient({ mock: MOCK });

  client.on('status', (s) => {
    // Ушли в ангар — бой закончился, самое время его записать.
    if (s.status !== 'battle') persistBattle();
    status = s;
    schedulePush();
  });

  client.on('reset', () => {
    persistBattle(); // предыдущий бой, если его ещё не записали
    battle.reset();
    battleStartedAt = Date.now();
    battleSaved = false;
    schedulePush();
  });

  client.on('damage', (entry) => {
    battle.ingest(entry);
    schedulePush();
  });

  client.on('error', (err) => {
    status = { status: 'offline', detail: err.message };
    schedulePush();
  });

  client.start();
}

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
  db = new Db(app.getPath('userData'));
  db.startSession(); // «бои с запуска» считаются от старта приложения
  startClient();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  persistBattle();
  if (client) client.stop();
  if (db) db.close();
});

app.on('window-all-closed', () => app.quit());

// --- IPC ---------------------------------------------------------------

ipcMain.handle('app:getState', () => ({
  ...battle.snapshot(),
  ...status,
  mock: MOCK,
  alwaysOnTop: !!settings.get('alwaysOnTop'),
}));

ipcMain.handle('app:setNick', (_e, nick) => {
  const clean = String(nick || '').trim();
  settings.set('selfNick', clean);
  battle.setSelfNick(clean);
  schedulePush();
  return clean;
});

ipcMain.handle('app:setAlwaysOnTop', (_e, value) => {
  const on = !!value;
  settings.set('alwaysOnTop', on);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(on);
  return on;
});

ipcMain.handle('app:resetBattle', () => {
  battle.reset();
  battleStartedAt = Date.now();
  battleSaved = false;
  schedulePush();
});

ipcMain.handle('db:counters', () => db.counters());
ipcMain.handle('db:stats', () => db.stats());
ipcMain.handle('db:recentBattles', (_e, limit) => db.recentBattles(limit));

ipcMain.handle('db:topPlayers', (_e, opts = {}) => {
  // «Часто попадался за месяц» — окно считаем здесь, чтобы renderer не знал
  // про календарную арифметику.
  const since = opts.period ? windowStart(opts.period) : 0;
  return db.topPlayers({ ...opts, since });
});

ipcMain.handle('db:playerCard', (_e, nick) => db.playerCard(nick));
ipcMain.handle('db:battleDetails', (_e, id) => db.battleDetails(id));
ipcMain.handle('db:resetCounter', (_e, name) => {
  db.resetCounter(name);
  return db.counters();
});

ipcMain.handle('db:deleteBattle', (_e, id) => {
  db.deleteBattle(id);
  send('db:changed');
});

ipcMain.handle('db:clearHistory', (_e, opts = {}) => db.clearHistory(opts));
ipcMain.handle('db:clearPlayers', () => db.clearPlayers());
ipcMain.handle('db:reveal', () => shell.showItemInFolder(db.stats().file));

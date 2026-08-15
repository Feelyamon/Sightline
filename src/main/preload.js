'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('wt', {
  getState: () => invoke('app:getState'),
  setNick: (nick) => invoke('app:setNick', nick),
  setAlwaysOnTop: (value) => invoke('app:setAlwaysOnTop', value),
  resetBattle: () => invoke('app:resetBattle'),

  db: {
    counters: () => invoke('db:counters'),
    stats: () => invoke('db:stats'),
    recentBattles: (limit) => invoke('db:recentBattles', limit),
    topPlayers: (opts) => invoke('db:topPlayers', opts),
    playerCard: (nick) => invoke('db:playerCard', nick),
    battleDetails: (id) => invoke('db:battleDetails', id),
    dossier: (nicks) => invoke('db:dossier', nicks),
    myVehicles: (opts) => invoke('db:myVehicles', opts),
    enemyVehicles: (opts) => invoke('db:enemyVehicles', opts),
    winrate: (opts) => invoke('db:winrate', opts),
    setNote: (nick, note) => invoke('db:setNote', nick, note),
    resetCounter: (name) => invoke('db:resetCounter', name),
    deleteBattle: (id) => invoke('db:deleteBattle', id),
    clearHistory: (opts) => invoke('db:clearHistory', opts),
    clearPlayers: () => invoke('db:clearPlayers'),
    reveal: () => invoke('db:reveal'),
  },

  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('battle:update', handler);
    return () => ipcRenderer.off('battle:update', handler);
  },
  onDbChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('db:changed', handler);
    return () => ipcRenderer.off('db:changed', handler);
  },
  onError: (cb) => {
    const handler = (_e, message) => cb(message);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.off('app:error', handler);
  },
});

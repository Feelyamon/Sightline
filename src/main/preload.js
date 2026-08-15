'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('wt', {
  getState: () => invoke('app:getState'),
  setNick: (nick) => invoke('app:setNick', nick),
  setAlwaysOnTop: (value) => invoke('app:setAlwaysOnTop', value),
  setUiScale: (value) => invoke('app:setUiScale', value),
  setLang: (lang) => invoke('app:setLang', lang),
  about: () => invoke('app:about'),
  openExternal: (page) => invoke('app:openExternal', page),
  windowFlags: () => invoke('app:windowFlags'),
  setWindowFlag: (name, value) => invoke('app:setWindowFlag', name, value),
  resetBattle: () => invoke('app:resetBattle'),

  account: {
    state: () => invoke('account:state'),
    checkVersion: () => invoke('account:checkVersion'),
    openDownload: () => invoke('account:openDownload'),
    register: (form) => invoke('account:register', form),
    signIn: (form) => invoke('account:signIn', form),
    signOut: () => invoke('account:signOut'),
    saveRecoveryCode: (code) => invoke('account:saveRecoveryCode', code),
  },

  friends: {
    state: () => invoke('friends:state'),
    refresh: () => invoke('friends:refresh'),
    search: (query) => invoke('friends:search', query),
    request: (login) => invoke('friends:request', login),
    accept: (login) => invoke('friends:accept', login),
    remove: (login) => invoke('friends:remove', login),
    addToSquad: (login) => invoke('friends:addToSquad', login),
    removeFromSquad: (login) => invoke('friends:removeFromSquad', login),
  },

  db: {
    counters: () => invoke('db:counters'),
    stats: () => invoke('db:stats'),
    recentBattles: (limit) => invoke('db:recentBattles', limit),
    searchBattles: (opts) => invoke('db:searchBattles', opts),
    topPlayers: (opts) => invoke('db:topPlayers', opts),
    playerCard: (nick) => invoke('db:playerCard', nick),
    battleDetails: (id) => invoke('db:battleDetails', id),
    dossier: (nicks) => invoke('db:dossier', nicks),
    myVehicles: (opts) => invoke('db:myVehicles', opts),
    enemyVehicles: (opts) => invoke('db:enemyVehicles', opts),
    winrate: (opts) => invoke('db:winrate', opts),
    activityByHour: (opts) => invoke('db:activityByHour', opts),
    dailyStats: (opts) => invoke('db:dailyStats', opts),
    streaks: (opts) => invoke('db:streaks', opts),
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
  onOpenTab: (cb) => {
    const handler = (_e, tab) => cb(tab);
    ipcRenderer.on('app:openTab', handler);
    return () => ipcRenderer.off('app:openTab', handler);
  },
  onFriendsUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('friends:update', handler);
    return () => ipcRenderer.off('friends:update', handler);
  },
  onProofProgress: (cb) => {
    const handler = (_e, tried) => cb(tried);
    ipcRenderer.on('account:proofProgress', handler);
    return () => ipcRenderer.off('account:proofProgress', handler);
  },
  onError: (cb) => {
    const handler = (_e, message) => cb(message);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.off('app:error', handler);
  },
});

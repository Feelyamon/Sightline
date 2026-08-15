'use strict';

// Словари подставляет сборщик стенда: в браузере JSON-файлы не прочитать.
const DICTS = /*__DICTS__*/ {};
const LANGS = /*__LANGS__*/ [];
let LANG = 'ru';
// Временный стенд: подменяет мост из preload данными в памяти, чтобы смотреть
// вкладки без запуска Electron. Удаляется после проверки.

const NICKS = ['Sniper_88', 'ЖуЖуКа', '玩家一号', 'Camper2000', 'player_twelve', 'Слепой_Крот'];
const MY = ['Т-80БВМ', 'ИС-2', 'Як-9Т', 'Leopard 2A4'];
const DAY = 86400000;

let s = 7;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad2 = (n) => String(n).padStart(2, '0');

const ALL = [];
for (let i = 0; i < 220; i++) {
  const r = rnd();
  const daysAgo = Math.floor(rnd() * 120);
  // Играет в основном вечером, изредка днём — чтобы график часов не был ровным.
  const hour = rnd() < 0.7 ? 18 + Math.floor(rnd() * 6) : Math.floor(rnd() * 24);
  const when = new Date();
  when.setDate(when.getDate() - daysAgo);
  when.setHours(hour, Math.floor(rnd() * 60), 0, 0);
  ALL.push({
    id: i + 1,
    started_at: when.getTime(),
    duration: 300 + Math.floor(rnd() * 600),
    my_kills: Math.floor(rnd() * 7),
    my_deaths: Math.floor(rnd() * 3),
    my_assists: Math.floor(rnd() * 4),
    my_vehicles: [pick(MY)],
    players_seen: 4 + Math.floor(rnd() * 8),
    result: r < 0.5 ? 'win' : r < 0.9 ? 'loss' : 'unknown',
    nicks: [pick(NICKS), pick(NICKS)],
  });
}
ALL.sort((a, b) => b.started_at - a.started_at);

const since = (period) => {
  if (!period) return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === 'month') d.setDate(1);
  return d.getTime();
};

const blank = () => ({ battles: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0 });
const add = (acc, b) => {
  acc.battles++;
  if (b.result === 'win') acc.wins++;
  if (b.result === 'loss') acc.losses++;
  acc.kills += b.my_kills;
  acc.deaths += b.my_deaths;
  acc.assists += b.my_assists;
};

function search(o = {}) {
  const q = (o.query || '').toLocaleLowerCase();
  const from = o.from || since(o.period);
  const rows = ALL.filter((b) => {
    if (q && !b.nicks.concat(b.my_vehicles).some((x) => x.toLocaleLowerCase().includes(q))) return false;
    if (o.result && b.result !== o.result) return false;
    if (from && b.started_at < from) return false;
    if (o.to && b.started_at > o.to) return false;
    if (o.myVehicle && !b.my_vehicles.includes(o.myVehicle)) return false;
    return true;
  });
  const acc = blank();
  rows.forEach((b) => add(acc, b));
  const offset = o.offset || 0;
  return {
    rows: rows.slice(offset, offset + (o.limit || 50)),
    total: rows.length,
    summary: {
      ...acc,
      unknown: acc.battles - acc.wins - acc.losses,
      percent: acc.wins + acc.losses ? Math.round((acc.wins / (acc.wins + acc.losses)) * 100) : null,
      kda: acc.deaths ? (acc.kills + acc.assists) / acc.deaths : acc.kills + acc.assists,
    },
  };
}

window.wt = {
  getState: async () => ({
    status: 'idle',
    players: [],
    clock: 0,
    knownPlayers: 0,
    selfNick: 'Username',
    uiScale: 1,
    lang: LANG,
    dict: DICTS[LANG],
    languages: LANGS,
  }),
  setNick: async () => {},
  setLang: async (lang) => {
    LANG = lang;
    return { lang, dict: DICTS[lang], languages: LANGS };
  },
  setAlwaysOnTop: async () => {},
  windowFlags: async () => ({ closeToTray: true, launchWithSystem: false, showOnGameStart: true, hideOnGameExit: false }),
  setWindowFlag: async (n, v) => v,
  onOpenTab: () => () => {},
  about: async () => ({
    version: '0.1.0',
    license: 'MIT',
    electron: '43.4.0',
    node: '22.0.0',
    dbFile: 'C:\Users\Username\AppData\Roaming\Sightline\battles.db',
  }),
  // В приложении масштаб ставит Electron через setZoomFactor; в браузере
  // ближайший аналог — css zoom, чтобы стенд вёл себя так же.
  setUiScale: async (value) => {
    document.body.style.zoom = String(value);
    return Number(value);
  },
  resetBattle: async () => {},
  db: {
    counters: async () => ({
      session: { battles: 3, from: Date.now() },
      today: { battles: 8, from: Date.now() },
      week: { battles: 31, from: Date.now() },
      month: { battles: 140, from: Date.now() },
    }),
    stats: async () => ({ battles: ALL.length, players: 11, sizeBytes: 237568, file: 'stub' }),
    searchBattles: async (o) => search(o),
    recentBattles: async () => ALL.slice(0, 50),
    myVehicles: async () => MY.map((v) => ({ vehicle: v, label: v, class: 'tank', sorties: 10, kills: 5, losses: 2, wins: 4, losses_battles: 3 })),
    enemyVehicles: async () => [],
    winrate: async () => ({ total: 140, wins: 70, losses: 56, unknown: 14, percent: 56 }),
    topPlayers: async () => [],
    playerCard: async () => null,
    battleDetails: async () => ({ players: [], my_vehicles: [] }),
    dossier: async () => ({}),
    setNote: async () => true,
    resetCounter: async () => ({}),
    deleteBattle: async () => {},
    clearHistory: async () => '',
    clearPlayers: async () => '',
    reveal: async () => {},

    activityByHour: async (o = {}) => {
      const from = since(o.period);
      const acc = Array.from({ length: 24 }, (_, hour) => ({ hour, ...blank() }));
      for (const b of ALL) {
        if (from && b.started_at < from) continue;
        add(acc[new Date(b.started_at).getHours()], b);
      }
      return acc;
    },
    dailyStats: async (o = {}) => {
      const from = since(o.period);
      const map = new Map();
      for (const b of ALL) {
        if (from && b.started_at < from) continue;
        const d = new Date(b.started_at);
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        if (!map.has(key)) map.set(key, { day: key, ...blank() });
        add(map.get(key), b);
      }
      return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
    },
    streaks: async ({ recent = 50 } = {}) => {
      const asc = [...ALL].sort((a, b) => a.started_at - b.started_at);
      let current = { type: 'none', length: 0 };
      let bestWin = 0;
      let worstLoss = 0;
      for (const b of asc) {
        if (b.result !== 'win' && b.result !== 'loss') continue;
        current = current.type === b.result ? { ...current, length: current.length + 1 } : { type: b.result, length: 1 };
        if (current.type === 'win') bestWin = Math.max(bestWin, current.length);
        else worstLoss = Math.max(worstLoss, current.length);
      }
      return { current, bestWin, worstLoss, recent: asc.slice(-recent).map((b) => ({ id: b.id, result: b.result })) };
    },
  },
  onUpdate: () => () => {},
  onDbChanged: () => () => {},
  onError: () => () => {},
};

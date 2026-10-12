'use strict';

// Словари подставляет сборщик стенда: в браузере JSON-файлы не прочитать.
const DICTS = /*__DICTS__*/ {};
const LANGS = /*__LANGS__*/ [];
let LANG = 'ru';
// Временный стенд: подменяет мост из preload данными в памяти, чтобы смотреть
// вкладки без запуска Electron. Удаляется после проверки.

const NICKS = ['PlayerA', 'ИгрокБ', '玩家一号', 'PlayerC', 'player_twelve', 'ИгрокГ'];
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
    // Состояние доверия. В живой программе оно приходит с сервера и пока
    // всегда 'alone' — синхронизации боёв ещё нет. В стенде подмешиваем
    // подтверждённые и спорные, иначе их отметки негде увидеть.
    trust: r < 0.25 ? 'confirmed' : r < 0.32 ? 'disputed' : 'alone',
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
  if (period === 'year') d.setMonth(0, 1);
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

// Стенд показывает полосу «есть обновление»: иначе её негде посмотреть, пока
// выпущенная версия одна.
const ВЕРСИЯ = {
  ok: true,
  appVersion: '0.3.0',
  minClient: '0.3.0',
  latestClient: '0.4.0',
  downloadUrl: 'https://sightline.feelyamon.ru/',
  updateAvailable: true,
  latestNotes: 'Приглашения в отряд, настройки переносятся между компьютерами.',
};

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
  // Приглашения в отряд: стенд умеет их показать по window.demoInvite(), чтобы
  // окно можно было посмотреть, не поднимая двух аккаунтов и сервер.
  onSquadInvites: (cb) => { window.__invites = cb; return () => {}; },
  onSettingsChanged: () => () => {},
  // Стенд умеет показать оба состояния: window.__server({ok:false, message:'…'}).
  onServerStatus: (cb) => { window.__server = cb; setTimeout(() => cb({ ok: true }), 300); return () => {}; },
  // В приложении это уходит в shell.openExternal. В стенде открывать браузер
  // незачем — достаточно не падать: без заглушки клик по ссылке на репозиторий
  // ронял бы обработчик и молча ломал вкладку.
  openExternal: async (page) => console.log('openExternal:', page),
  setLang: async (lang) => {
    LANG = lang;
    return { lang, dict: DICTS[lang], languages: LANGS };
  },
  setAlwaysOnTop: async () => {},
  windowFlags: async () => ({ closeToTray: true, launchWithSystem: false, showOnGameStart: true, hideOnGameExit: false }),
  setWindowFlag: async (n, v) => v,
  onOpenTab: () => () => {},
  about: async () => ({
    version: '0.3.0',
    license: 'GPL-3.0-or-later',
    repo: 'https://github.com/Feelyamon/Sightline',
    electron: '43.4.0',
    node: '22.0.0',
    // Обратные слэши экранированы. Раньше не были, и строка молча теряла
    // буквы: «\U» это просто «U», а «\b» — вообще забой. В окне показывался
    // путь, которого не бывает.
    dbFile: 'C:\\Users\\Username\\AppData\\Roaming\\Sightline\\battles.db',
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
      year: { battles: 812, from: Date.now() },
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
    disputedBattles: async () => ALL.filter((b) => b.trust === 'disputed').slice(0, 5),
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
  // Аккаунт и друзья: стенд всегда «вошёл», иначе половину интерфейса не
  // посмотреть. Сервера здесь нет и быть не может — данные выдуманные.
  account: {
    state: async () => ({
      signedIn: true,
      login: 'Username',
      role: 'admin',
      isAdmin: true,
      expiresAt: null,
      // Та же версия, что отдаёт checkVersion. В программе это одно и то же
      // поле; расходясь здесь, стенд гасил полосу обновления сразу после того,
      // как проверка её показала.
      version: ВЕРСИЯ,
    }),
    // Стенд показывает полосу «есть обновление»: иначе её негде посмотреть,
    // пока выпущенная версия одна.
    checkVersion: async () => ВЕРСИЯ,
    notifications: async () => ({ items: [
      { id: 2, kind: 'avatar_removed', payload: { banned: false }, created_at: Date.now() - 3600000, read: false, blocking: false },
      { id: 1, kind: 'friend_request', payload: { login: 'Bravo' }, created_at: Date.now() - 86400000, read: true, blocking: false },
    ] }),
    readNotifications: async () => ({ ok: true }),
    setPrivacy: async (v) => ({ ok: true, private: v }),
    me: async () => ({ login: 'Feelyamon', role: 'admin', is_admin: true, lang: 'ru', private_profile: false }),
    forcedPassword: async () => ({ recoveryCode: 'AAAA-BBBB-CCCC-DDDD' }),
    openDownload: async () => {},
    // В браузере файл выбрать некуда и загружать некуда: стенд показывает
    // только вёрстку с буквой вместо картинки.
    chooseAvatar: async () => {
      throw new Error('в стенде вёрстки аватарка не загружается');
    },
    removeAvatar: async () => ({ avatar: null }),
    register: async () => ({ recoveryCode: 'ABCD-EFGH-JKMN-PQRS' }),
    // Второй фактор в стенде: логин «totp» ведёт на шаг кода, «setup» — на
    // обязательную настройку. Остальные входят сразу.
    signIn: async ({ login } = {}) =>
      login === 'totp'
        ? { signedIn: false, step: 'totp' }
        : login === 'setup'
          ? { signedIn: false, step: 'totp_setup' }
          : { signedIn: true, login: 'Username' },
    totpSignIn: async () => ({ signedIn: true, login: 'Username' }),
    // Настоящий QR считает главный процесс; здесь — узор того же размера,
    // чтобы было видно вёрстку.
    totpSetupForced: async () => ({
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Feelyamon:Username?secret=JBSWY3DPEHPK3PXP',
      qr: Array.from({ length: 29 }, (_, r) =>
        Array.from({ length: 29 }, (_, c) => ((r * 7 + c * 3 + r * c) % 5 < 2 ? '1' : '0')).join('')
      ),
    }),
    totpConfirmForced: async () => ({
      signedIn: true,
      login: 'Username',
      backupCodes: ['k3m9-p2x7', 'a8d4-q6w1', 'z5n2-h7c3', 'r1t8-b4v6', 'e9y3-u5i2', 'o7l1-j6g4', 's2f8-m3k9', 'x4c6-n1p5'],
    }),
    totpCancel: async () => ({ signedIn: false }),
    saveBackupCodes: async () => null,
    signOut: async () => ({ signedIn: false }),
    // Смена пароля в стенде всегда «удаётся»: смотреть тут нечего, кроме окна
    // с новым кодом восстановления, — а оно и есть самая заметная часть.
    changePassword: async () => ({
      signedIn: true,
      login: 'Username',
      recoveryCode: 'WXYZ-2345-6789-ABCD',
    }),
    logoutAll: async () => ({ signedIn: false, closed: 3 }),
    saveRecoveryCode: async () => null,
  },

  friends: (() => {
    const state = {
      signedIn: true,
      limit: 100,
      me: { login: 'Username', game_nick: '[CLAN] Username', avatar: null },
      squad: ['Sokol'],
      incoming: [{ login: 'Novichok', avatar: null }],
      outgoing: [],
      friends: [
        { login: 'Sokol', game_nick: '[CLAN] Sokol', avatar: null, presence: 'battle', score: { kills: 3, deaths: 1, assists: 2 } },
        { login: 'Tihiy', game_nick: 'Tihiy', avatar: null, presence: 'hangar' },
        { login: 'Dalniy', game_nick: null, avatar: null, presence: 'offline' },
      ],
    };
    const copy = () => JSON.parse(JSON.stringify(state));
    return {
      state: async () => copy(),
      refresh: async () => copy(),
      search: async (q) => [{ login: 'Poisk_' + q, avatar: null, relation: 'none' }],
      request: async () => copy(),
      accept: async () => copy(),
      remove: async () => copy(),
      addToSquad: async (login) => {
        if (!state.squad.includes(login) && state.squad.length < 3) state.squad.push(login);
        return copy();
      },
      invite: async () => ({ ok: true, cooldown: 10, expires_in: 60 }),
      acceptInvite: async () => copy(),
      declineInvite: async () => copy(),
      removeFromSquad: async (login) => {
        state.squad = state.squad.filter((l) => l !== login);
        return copy();
      },
    };
  })(),

  profile: {
    search: async (q) => [
      { login: 'Feelyamon', game_nick: '[CLAN] Ловкач', avatar: null },
      { login: 'Username', game_nick: null, avatar: null },
    ].filter((f) => (f.game_nick || f.login).toLowerCase().includes(q.toLowerCase())),
    get: async (who) => ({
      login: 'Feelyamon',
      game_nick: '[CLAN] Ловкач',
      avatar: null,
      member_since: Date.now() - 90 * DAY,
      last_battle_at: Date.now() - 3 * 3600 * 1000,
      month: { battles: 48, wins: 27, losses: 20, percent: 57, kills: 131, deaths: 26,
               assists: 14, kda: 5.58, best_win_streak: 9 },
      totals: { battles: 812, wins: 441, confirmed: 0, disputed: 0 },
      calendar: (() => {
        const out = [];
        for (let i = 0; i < 90; i++) {
          const d = new Date(Date.now() - i * DAY);
          const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
          if (rnd() < 0.55) out.push({ day: k, battles: 1 + Math.floor(rnd() * 9), wins: Math.floor(rnd() * 5) });
        }
        return out.reverse();
      })(),
      vehicles: [
        { name: 'Т-80БВМ', sorties: 214, kills: 388, kills_per_sortie: 1.81, losses: 96 },
        { name: 'Leopard 2A4', sorties: 88, kills: 121, kills_per_sortie: 1.38, losses: 51 },
        { name: 'ЗСУ-23-4', sorties: 40, kills: 62, kills_per_sortie: 1.55, losses: 22 },
      ],
    }),
  },

  support: {
    send: async () => ({ id: 42 }),
    mine: async () => ({ items: [] }),
    context: async () => ({
      appVersion: '0.3.0',
      osVersion: 'win32 10.0.26200',
      signedIn: true,
      login: 'Username',
      lang: 'ru',
      gameStatus: 'idle',
      // Пара нераспознанных строк: без них не видно, как выглядит самое
      // полезное из приложенного.
      unparsed: ['[CLNZ] Кто-то сделал что-то непонятное', 'непонятная строка кил-фида'],
      system: {
        os: 'Windows_NT 10.0.26200 (x64)',
        cpu: 'AMD Ryzen 7 5800X 8-Core Processor',
        cores: 16,
        ramTotalGb: 31.9,
        ramFreeGb: 25.3,
        gpu: ['AMD Radeon RX 6650 XT · драйвер 32.0.21045.1000'],
        displays: ['2560×1440 @ 1x'],
        uiScale: 1,
        uptimeMin: 12,
        electron: '43.4.0', chrome: '132.0.0.0', node: '22.0.0',
      },
      installId: 'harness',
    }),
  },

  admin: {
    findUsers: async () => [
      { id: 1, login: 'Username', role: 'admin', blocked: false, created_at: new Date().toISOString() },
      { id: 7, login: 'Narushitel', role: 'user', blocked: true, created_at: new Date().toISOString() },
    ],
    newRecoveryCode: async () => ({ recovery_code: 'ABCD-EFGH-JKMN-PQRS' }),
    setPassword: async () => ({ recovery_code: 'WXYZ-2345-6789-ABCD' }),
    block: async () => ({ ok: true }),
    setRole: async () => ({ ok: true }),
    clearAvatar: async () => ({ ok: true }),
    vehicles: async () => [
      { folded: 't80bvm', spellings: ['Т-80БВМ', 'T-80BVM'], sorties: 214, canonical: null },
      { folded: 'pantera', spellings: ['Пантера'], sorties: 38, canonical: null },
      { folded: 'panther', spellings: ['Panther'], sorties: 31, canonical: null },
    ],
    setVehicleAlias: async () => ({ ok: true }),
    log: async () => [
      { id: 2, admin_login: 'Username', action: 'block', target_login: 'Narushitel', details: { reason: 'оскорбления в чате' }, at: new Date().toISOString() },
      { id: 1, admin_login: 'Username', action: 'set_password', target_login: 'Zabyvchivyi', details: {}, at: new Date(Date.now() - 36e5).toISOString() },
    ],
    reports: async () => [
      {
        id: 3,
        login: 'Username',
        kind: 'bug',
        // С переносами намеренно: люди присылают шаги списком, и стенд должен
        // показывать, как такое сообщение выглядит в разборе.
        message: 'Таблица боя пустеет после респавна.\n1. Выехал\n2. Сгорел\n3. Выбрал технику заново',
        app_version: '0.3.0',
        os_version: 'win32 10.0.26200',
        created_at: new Date().toISOString(),
        resolved: false,
        admin_note: null,
      },
      { id: 2, login: null, kind: 'idea', message: 'Хочу видеть свой средний КДА за последние двадцать боёв прямо в шапке.', app_version: '0.2.0', os_version: 'win32 10.0.22631', created_at: new Date(Date.now() - 864e5).toISOString(), resolved: true, admin_note: 'Сделано в 0.3.0' },
    ],
    resolveReport: async () => ({ ok: true }),
  },

  onUpdate: () => () => {},
  onDbChanged: () => () => {},
  onError: () => () => {},
  onFriendsUpdate: () => () => {},
  onProofProgress: () => () => {},
};

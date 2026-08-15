'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const STATUS_TEXT = { battle: 'В бою', idle: 'В ангаре', offline: 'Игра не запущена' };
// «Уничтожен» само по себе читается как «выбыл из боя навсегда», поэтому
// добавлено «выбирает»: игрок жив, он в ангаре выбирает следующую машину.
const PLAYER_STATUS = {
  alive: ['в бою', 'alive'],
  dead: ['уничтожен · выбирает', 'dead'],
  left: ['вышел', 'left'],
  unknown: ['не выехал', 'idle'],
};
// Иконки классов приходят из main вместе со снапшотом (см. vehicle-class.js).
const CLASS_ICON = { tank: '▮', spaa: '◬', plane: '✈', heli: '⊹', drone: '⌖' };
const COUNTER_LABEL = {
  session: 'С запуска',
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
};

let lastState = null;
let nickDirty = false;

// Досье подтягиваем пачкой на новых игроков боя и держим до его конца:
// запрашивать базу на каждое обновление таблицы незачем.
let dossierCache = {};
let dossierPending = false;

async function ensureDossier(nicks) {
  const missing = nicks.filter((n) => !(n in dossierCache));
  if (!missing.length || dossierPending) return;
  dossierPending = true;
  try {
    Object.assign(dossierCache, await window.wt.db.dossier(missing));
    // Игроки, которых в базе нет, тоже помечаем — чтобы не спрашивать снова.
    for (const n of missing) if (!(n in dossierCache)) dossierCache[n] = null;
    if (lastState) renderBattle(lastState);
  } finally {
    dossierPending = false;
  }
}

// --- Вкладки ------------------------------------------------------------

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`);
  }
  if (tab.dataset.tab === 'counters') refreshCounters();
  if (tab.dataset.tab === 'battles') refreshBattles();
  if (tab.dataset.tab === 'mine') refreshMine();
  if (tab.dataset.tab === 'players') refreshPlayers();
  if (tab.dataset.tab === 'settings') refreshDbStats();
});

// --- Утилиты ------------------------------------------------------------

function clockText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function dateText(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Название техники с иконкой класса. */
function vehicleNode(name, cls, { dead = false } = {}) {
  const wrap = el('span', `veh${dead ? ' dead' : ''}`);
  const icon = el('span', `icon ${cls || 'tank'}`, CLASS_ICON[cls] || CLASS_ICON.tank);
  icon.title = cls || 'tank';
  wrap.append(icon, el('span', 'veh-name', name));
  return wrap;
}

// --- Вкладка «Бой» ------------------------------------------------------

/**
 * Одна колонка на всю технику: чип за каждый вылет по порядку.
 * Последний чип и есть «сейчас» — он подсвечен рамкой, если игрок жив.
 * Двумя колонками это не влезало в половину экрана.
 */
function vehiclesCell(p) {
  const td = el('td');
  const sorties = p.sorties.filter((s) => s.vehicle);
  if (!sorties.length) {
    td.className = 'muted';
    td.textContent = p.status === 'left' ? 'вышел, не выехав' : 'не выехал';
    return td;
  }

  const wrap = el('div', 'chips');
  const lastIndex = sorties.length - 1;
  sorties.forEach((s, i) => {
    const isCurrent = i === lastIndex && !s.destroyed && p.status === 'alive';
    // Вылет закончился, но гибели в кил-фиде не было: игрок пересел на другую
    // машину. Умер он от ИИ, разбился или строку не разобрал парсер — точно
    // неизвестно, поэтому не зачёркиваем, а гасим.
    const isEnded = i < lastIndex && !s.destroyed;
    const chip = el(
      'span',
      `chip${s.destroyed ? ' destroyed' : ''}${isEnded ? ' ended' : ''}${isCurrent ? ' current' : ''}`
    );
    chip.append(vehicleNode(s.label || s.vehicle, s.class, { dead: s.destroyed }));
    if (s.kills > 0) chip.append(el('b', null, `×${s.kills}`));
    const state = s.destroyed
      ? 'уничтожен на этой машине'
      : isCurrent
        ? 'сейчас на этой машине'
        : isEnded
          ? 'пересел на другую машину — гибели в кил-фиде не было'
          : 'машина цела';
    // В подсказке — полное имя из игры со служебными символами и смысл ×N.
    chip.title = `${s.vehicle}\n${state}\nфрагов на этой машине: ${s.kills}`;
    wrap.append(chip);
  });
  td.append(wrap);
  return td;
}

function playersTable(players) {
  if (!players.length) return el('div', 'empty', 'Пока никого');

  const table = el('table');
  table.innerHTML =
    '<thead><tr><th class="nick">Ник</th><th class="num">K</th><th class="num">D</th>' +
    '<th class="num">A</th><th>Статус</th><th>Техника (последняя — текущая)</th></tr></thead>';
  const tbody = el('tbody');

  for (const p of players) {
    const tr = el('tr');
    if (p.status === 'left') tr.classList.add('row-left');
    if (p.status === 'dead') tr.classList.add('row-dead');

    const nick = el('td', `nick${p.isSelf ? ' self' : ''}`);
    const nameEl = el('span', 'nick-name', p.nick);
    nameEl.addEventListener('click', () => openCard(p.nick));
    nick.append(nameEl);
    nick.title = p.nick;

    // Досье из базы: сколько раз уже встречались и на чём он обычно ездит.
    const d = dossierCache[p.nick];
    if (d && d.battles > 0 && !p.isSelf) {
      const mark = el('span', 'dossier', `${d.battles}`);
      const fav = d.favourite[0];
      mark.title =
        `встреч: ${d.battles}` +
        (fav ? `\nчаще всего: ${fav.vehicle} (${fav.sorties} вылетов)` : '') +
        `\nон убивал меня ${d.killedMe}, я его ${d.killedByMe}` +
        (d.note ? `\n\nзаметка: ${d.note}` : '');
      if (d.note) mark.classList.add('has-note');
      nick.append(mark);
    }

    const [label, cls] = PLAYER_STATUS[p.status] || PLAYER_STATUS.unknown;
    const st = el('td');
    st.append(el('span', `badge ${cls}`, label));

    const assists = el('td', 'num', String(p.assists || 0));
    assists.title = 'ассисты: повредил цель, но добил её другой (считается приложением)';

    tr.append(
      nick,
      el('td', 'num', String(p.kills)),
      el('td', 'num', String(p.deaths)),
      assists,
      st,
      vehiclesCell(p)
    );
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function renderBattle(state) {
  const isNewBattle = lastState && state.startedAt !== lastState.startedAt;
  lastState = state;
  if (isNewBattle) dossierCache = {};
  ensureDossier(state.players.map((p) => p.nick));

  $('dot').className = `dot ${state.status || 'offline'}`;
  $('statusText').textContent =
    (STATUS_TEXT[state.status] || 'Неизвестно') + (state.detail ? ` · ${state.detail}` : '');
  $('counter').textContent = `${clockText(state.clock)} · известно ${state.knownPlayers}`;

  const byTeam = (team) => state.players.filter((p) => p.team === team);
  const allies = byTeam('ally');
  const enemies = byTeam('enemy');
  const unknown = byTeam('unknown');

  $('allyTitle').textContent = `Свои — ${allies.length}, живых ${allies.filter((p) => p.status === 'alive').length}`;
  $('enemyTitle').textContent = `Противники — ${enemies.length}, живых ${enemies.filter((p) => p.status === 'alive').length}`;

  $('allyBody').replaceChildren(playersTable(allies));
  $('enemyBody').replaceChildren(playersTable(enemies));

  $('unknownBox').hidden = unknown.length === 0;
  if (unknown.length) {
    $('unknownTitle').textContent = `Команда не определена — ${unknown.length}`;
    $('unknownBody').replaceChildren(playersTable(unknown));
  }

  if (!nickDirty && document.activeElement !== $('nick')) $('nick').value = state.selfNick || '';

  const hasUnparsed = state.unparsed && state.unparsed.length;
  $('unparsedBox').hidden = !hasUnparsed;
  if (hasUnparsed) $('unparsed').textContent = state.unparsed.join('\n');
}

// --- Вкладка «Счётчики» -------------------------------------------------

async function refreshCounters() {
  const counters = await window.wt.db.counters();
  const tiles = $('tiles');
  tiles.replaceChildren();

  for (const [name, label] of Object.entries(COUNTER_LABEL)) {
    const c = counters[name] || { battles: 0, from: 0 };
    const tile = el('div', 'tile');
    tile.append(
      el('div', 'label', label),
      el('div', 'value', String(c.battles)),
      el('div', 'since', `с ${dateText(c.from)}`)
    );
    const btn = el('button', 'small', 'Сбросить');
    btn.addEventListener('click', async () => {
      await window.wt.db.resetCounter(name);
      refreshCounters();
    });
    tile.append(btn);
    tiles.append(tile);
  }

}

// --- Вкладка «Бои» ------------------------------------------------------

/** Состав боя: две колонки, свои и противники, как во вкладке «Бой». */
function battleRoster(details) {
  const wrap = el('div', 'roster');
  const split = el('div', 'split');

  for (const [team, title] of [['ally', 'Свои'], ['enemy', 'Противники'], ['unknown', 'Без команды']]) {
    const rows = details.players.filter((p) => p.team === team);
    if (!rows.length) continue;

    const side = el('div', 'side');
    side.append(el('div', `side-title ${team}`, `${title} — ${rows.length}`));

    const table = el('table');
    table.innerHTML =
      '<thead><tr><th class="nick">Ник</th><th>КДА</th><th>Техника</th></tr></thead>';
    const tbody = el('tbody');
    for (const p of rows) {
      const tr = el('tr');
      if (p.left_battle) tr.classList.add('row-left');
      const nick = el('td', 'nick', p.nick);
      nick.title = p.nick;
      const kda = el('td');
      kda.append(kdaBadge(p.kills, p.deaths, p.assists));
      tr.append(nick, kda, el('td', 'muted', p.vehicles.join(' · ') || '—'));
      tbody.append(tr);
    }
    table.append(tbody);
    side.append(table);
    split.append(side);
  }

  wrap.append(split);
  return wrap;
}

async function refreshBattles() {
  const limit = Number($('battlesLimit').value) || 10;
  const battles = await window.wt.db.recentBattles(limit);
  const body = $('battlesBody');

  if (!battles.length) {
    body.replaceChildren(el('div', 'empty', 'Боёв пока нет. Первый запишется, когда закончится.'));
    return;
  }

  const table = el('table');
  table.innerHTML =
    '<thead><tr><th>Когда</th><th class="num">Длит.</th><th class="num">K</th>' +
    '<th class="num">D</th><th>Моя техника</th><th class="num">Игроков</th><th></th></tr></thead>';
  const tbody = el('tbody');

  for (const b of battles) {
    const tr = el('tr', 'clickable');

    const actions = el('td');
    const del = el('button', 'small danger', 'Удалить');
    del.addEventListener('click', async (e) => {
      e.stopPropagation(); // не раскрывать строку по клику на удаление
      await window.wt.db.deleteBattle(b.id);
      refreshBattles();
      refreshCounters();
    });
    actions.append(del);

    tr.append(
      el('td', null, dateText(b.started_at)),
      el('td', 'num', clockText(b.duration)),
      el('td', 'num', String(b.my_kills)),
      el('td', 'num', String(b.my_deaths)),
      el('td', null, b.my_vehicles.join(', ') || '—'),
      el('td', 'num', String(b.players_seen)),
      actions
    );

    // Строка с составом — открывается и закрывается по клику на бой.
    const detailRow = el('tr', 'detail-row');
    const detailCell = el('td');
    detailCell.colSpan = 7;
    detailRow.append(detailCell);
    detailRow.hidden = true;

    let loaded = false;
    tr.addEventListener('click', async () => {
      detailRow.hidden = !detailRow.hidden;
      if (detailRow.hidden || loaded) return;
      const details = await window.wt.db.battleDetails(b.id);
      detailCell.replaceChildren(
        details ? battleRoster(details) : el('div', 'empty', 'Состав не найден')
      );
      loaded = true;
    });

    tbody.append(tr, detailRow);
  }

  table.append(tbody);
  body.replaceChildren(table);
}

$('battlesLimit').addEventListener('change', refreshBattles);

// --- Вкладка «Игроки» ---------------------------------------------------

/** Плашка КДА: убийства / смерти / ассисты и отношение (K+A)/D. */
function kdaBadge(kills, deaths, assists) {
  const k = kills ?? 0;
  const d = deaths ?? 0;
  const a = assists ?? 0;
  const ratio = d > 0 ? ((k + a) / d).toFixed(2) : (k + a).toFixed(2);

  const badge = el('span', 'kda');
  badge.append(
    el('b', 'kda-k', String(k)),
    el('i', 'kda-sep', '/'),
    el('b', 'kda-d', String(d)),
    el('i', 'kda-sep', '/'),
    el('b', 'kda-a', String(a)),
    el('span', 'kda-ratio', ratio)
  );
  badge.title = `убийств ${k}, смертей ${d}, ассистов ${a}\n(K+A)/D = ${ratio}${
    d === 0 ? ' — смертей не было' : ''
  }`;
  return badge;
}

function topTable(rows) {
  if (!rows.length) return el('div', 'empty', 'Никто не набрал нужного числа встреч');

  const table = el('table');
  table.innerHTML =
    '<thead><tr><th class="nick">Ник</th><th class="num">Боёв</th><th>КДА</th>' +
    '<th>Последний раз</th></tr></thead>';
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const nick = el('td', 'nick', r.nick);
    nick.title = r.nick;

    const kda = el('td');
    kda.append(kdaBadge(r.kills, r.deaths, r.assists));

    tr.append(nick, el('td', 'num', String(r.battles)), kda, el('td', null, dateText(r.last_seen)));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

async function refreshPlayers() {
  const period = $('period').value || null;
  const minBattles = Math.max(1, Number($('minBattles').value) || 1);
  const [allies, enemies] = await Promise.all([
    window.wt.db.topPlayers({ side: 'ally', period, minBattles }),
    window.wt.db.topPlayers({ side: 'enemy', period, minBattles }),
  ]);
  $('topAllies').replaceChildren(topTable(allies));
  $('topEnemies').replaceChildren(topTable(enemies));
}

$('period').addEventListener('change', refreshPlayers);
$('minBattles').addEventListener('change', refreshPlayers);

// --- Вкладка «Моя техника» ----------------------------------------------

function vehicleTable(rows, { mine }) {
  if (!rows.length) {
    return el('div', 'empty', mine ? 'Данных пока нет' : 'Противники ещё не набрались');
  }

  const table = el('table');
  table.innerHTML = mine
    ? '<thead><tr><th>Техника</th><th class="num">Вылетов</th><th class="num">Фрагов</th>' +
      '<th class="num">Потерь</th><th>Винрейт</th></tr></thead>'
    : '<thead><tr><th>Техника</th><th class="num">Вылетов</th><th class="num">Фрагов</th>' +
      '<th class="num">Игроков</th></tr></thead>';
  const tbody = el('tbody');

  for (const r of rows) {
    const tr = el('tr');
    const veh = el('td');
    veh.append(vehicleNode(r.vehicle, null));

    if (mine) {
      const decided = (r.wins || 0) + (r.losses_battles || 0);
      const wr = decided ? `${Math.round((r.wins / decided) * 100)}%` : '—';
      const cell = el('td', decided ? '' : 'muted', wr);
      cell.title = decided
        ? `побед ${r.wins} из ${decided} боёв с известным исходом`
        : 'исход этих боёв не определён';
      tr.append(
        veh,
        el('td', 'num', String(r.sorties)),
        el('td', 'num', String(r.kills || 0)),
        el('td', 'num', String(r.losses || 0)),
        cell
      );
    } else {
      tr.append(
        veh,
        el('td', 'num', String(r.sorties)),
        el('td', 'num', String(r.kills || 0)),
        el('td', 'num', String(r.players))
      );
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

async function refreshMine() {
  const period = $('minePeriod').value || null;
  const [wr, mine, enemy] = await Promise.all([
    window.wt.db.winrate({ period }),
    window.wt.db.myVehicles({ period }),
    window.wt.db.enemyVehicles({ period }),
  ]);

  const tile = $('winrateTile');
  tile.replaceChildren(
    el('div', 'label', 'Винрейт'),
    el('div', 'value', wr.percent === null ? '—' : `${wr.percent}%`),
    el(
      'div',
      'since',
      wr.percent === null
        ? `боёв ${wr.total}, исход ни одного не определён`
        : `${wr.wins} побед / ${wr.losses} поражений${wr.unknown ? `, ${wr.unknown} без исхода` : ''}`
    )
  );

  $('myVehicles').replaceChildren(vehicleTable(mine, { mine: true }));
  $('enemyVehicles').replaceChildren(vehicleTable(enemy, { mine: false }));
}

$('minePeriod').addEventListener('change', refreshMine);

// --- Карточка игрока ----------------------------------------------------

let cardNick = null;

async function openCard(nick) {
  cardNick = nick;
  $('cardNick').textContent = nick;
  $('cardSummary').textContent = 'Загружаю…';
  $('cardBody').replaceChildren();
  $('cardModal').hidden = false;

  const [card, dossier] = await Promise.all([
    window.wt.db.playerCard(nick),
    window.wt.db.dossier([nick]),
  ]);
  const d = dossier[nick];
  $('cardNote').value = d?.note || '';

  if (!card) {
    $('cardSummary').textContent = 'Этого игрока ещё нет в базе — он попадёт туда, когда бой закончится.';
    return;
  }

  const asAlly = card.encounters.filter((e) => e.team === 'ally').length;
  const asEnemy = card.encounters.filter((e) => e.team === 'enemy').length;
  $('cardSummary').textContent =
    `Встреч: ${card.encounters.length} (в моей команде ${asAlly}, против ${asEnemy})` +
    (d ? ` · он убивал меня ${d.killedMe}, я его ${d.killedByMe}` : '');

  const table = el('table');
  table.innerHTML =
    '<thead><tr><th>Когда</th><th>Команда</th><th>КДА</th><th>Техника</th></tr></thead>';
  const tbody = el('tbody');
  for (const e of card.encounters.slice(0, 50)) {
    const tr = el('tr');
    const kda = el('td');
    kda.append(kdaBadge(e.kills, e.deaths, e.assists));
    tr.append(
      el('td', null, dateText(e.started_at)),
      el('td', `nick ${e.team}`, e.team === 'ally' ? 'свой' : e.team === 'enemy' ? 'против' : '—'),
      kda,
      el('td', 'muted', e.vehicles.join(' · ') || '—')
    );
    tbody.append(tr);
  }
  table.append(tbody);
  $('cardBody').replaceChildren(table);
}

$('cardClose').addEventListener('click', () => {
  $('cardModal').hidden = true;
  cardNick = null;
});
$('cardSave').addEventListener('click', async () => {
  if (!cardNick) return;
  await window.wt.db.setNote(cardNick, $('cardNote').value);
  $('cardModal').hidden = true;
  cardNick = null;
});

// --- Вкладка «Настройки» ------------------------------------------------

async function refreshDbStats() {
  const s = await window.wt.db.stats();
  const mb = (s.sizeBytes / 1024 / 1024).toFixed(2);
  $('dbStats').textContent = `Боёв: ${s.battles} · игроков: ${s.players} · размер: ${mb} МБ`;
  $('dbStats').title = s.file;
}

$('nick').addEventListener('input', () => {
  nickDirty = true;
});
$('nick').addEventListener('change', async () => {
  await window.wt.setNick($('nick').value);
  nickDirty = false;
});
$('nick').addEventListener('blur', () => {
  nickDirty = false;
});
$('onTop').addEventListener('change', (e) => window.wt.setAlwaysOnTop(e.target.checked));
$('reveal').addEventListener('click', () => window.wt.db.reveal());
$('resetBattleBtn').addEventListener('click', () => window.wt.resetBattle());

// --- Подтверждение опасных действий -------------------------------------

let confirmAction = null;

function askConfirm({ title, text, word = 'УДАЛИТЬ', action }) {
  $('modalTitle').textContent = title;
  $('modalText').textContent = text;
  $('modalWord').textContent = word;
  $('modalInput').value = '';
  $('modalOk').disabled = true;
  confirmAction = action;
  $('modal').hidden = false;
  $('modalInput').focus();
}

$('modalInput').addEventListener('input', (e) => {
  $('modalOk').disabled = e.target.value.trim().toUpperCase() !== $('modalWord').textContent;
});
$('modalCancel').addEventListener('click', () => {
  $('modal').hidden = true;
  confirmAction = null;
});
$('modalOk').addEventListener('click', async () => {
  const action = confirmAction;
  $('modal').hidden = true;
  confirmAction = null;
  if (action) await action();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) $('modalCancel').click();
});

$('clearHistory').addEventListener('click', () =>
  askConfirm({
    title: 'Очистить историю боёв',
    text: 'Удалит все записанные бои и обнулит все четыре счётчика. База игроков останется. Копия базы сохранится рядом с файлом.',
    action: async () => {
      await window.wt.db.clearHistory({ keepPlayers: true });
      refreshDbStats();
      refreshCounters();
    },
  })
);

$('clearPlayers').addEventListener('click', () =>
  askConfirm({
    title: 'Очистить базу игроков',
    text: 'Удалит всех накопленных игроков и их встречи — топы союзников и противников обнулятся. Копия базы сохранится рядом с файлом.',
    action: async () => {
      await window.wt.db.clearPlayers();
      refreshDbStats();
      refreshPlayers();
    },
  })
);

// --- Старт --------------------------------------------------------------

window.wt.onUpdate(renderBattle);
window.wt.onDbChanged(() => {
  refreshCounters();
  refreshBattles();
  refreshDbStats();
});
window.wt.onError((message) => {
  $('statusText').textContent = message;
});

window.wt.getState().then((state) => {
  $('onTop').checked = !!state.alwaysOnTop;
  renderBattle(state);
});
refreshCounters();
refreshDbStats();

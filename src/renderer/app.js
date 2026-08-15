'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const STATUS_TEXT = { battle: 'В бою', idle: 'В ангаре', offline: 'Игра не запущена' };
const PLAYER_STATUS = {
  alive: ['в бою', 'alive'],
  dead: ['уничтожен', 'dead'],
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

// --- Вкладки ------------------------------------------------------------

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`);
  }
  if (tab.dataset.tab === 'counters') refreshCounters();
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
    '<th>Статус</th><th>Техника (последняя — текущая)</th></tr></thead>';
  const tbody = el('tbody');

  for (const p of players) {
    const tr = el('tr');
    if (p.status === 'left') tr.classList.add('row-left');
    if (p.status === 'dead') tr.classList.add('row-dead');

    const nick = el('td', `nick${p.isSelf ? ' self' : ''}`, p.nick);
    nick.title = p.nick;

    const [label, cls] = PLAYER_STATUS[p.status] || PLAYER_STATUS.unknown;
    const st = el('td');
    st.append(el('span', `badge ${cls}`, label));

    tr.append(
      nick,
      el('td', 'num', String(p.kills)),
      el('td', 'num', String(p.deaths)),
      st,
      vehiclesCell(p)
    );
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function renderBattle(state) {
  lastState = state;

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

  const battles = await window.wt.db.recentBattles(50);
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
    const tr = el('tr');
    const actions = el('td');
    const del = el('button', 'small danger', 'Удалить');
    del.addEventListener('click', async () => {
      await window.wt.db.deleteBattle(b.id);
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
    tbody.append(tr);
  }
  table.append(tbody);
  body.replaceChildren(table);
}

// --- Вкладка «Игроки» ---------------------------------------------------

function topTable(rows) {
  if (!rows.length) return el('div', 'empty', 'Никто не набрал нужного числа встреч');

  const table = el('table');
  table.innerHTML =
    '<thead><tr><th class="nick">Ник</th><th class="num">Боёв</th><th class="num">K</th>' +
    '<th class="num">D</th><th>Последний раз</th></tr></thead>';
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const nick = el('td', 'nick', r.nick);
    nick.title = r.nick;
    tr.append(
      nick,
      el('td', 'num', String(r.battles)),
      el('td', 'num', String(r.kills ?? 0)),
      el('td', 'num', String(r.deaths ?? 0)),
      el('td', null, dateText(r.last_seen))
    );
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

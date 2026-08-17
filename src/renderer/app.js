'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// Все видимые строки идут через словарь (см. i18n.js). Короткое имя — потому
// что вызов встречается на каждой второй строке разметки таблиц.
const t = (key, params) => window.i18n.t(key, params);

/**
 * Шапка таблицы из ключей словаря.
 * @param {string[]} keys
 * @param {{num?: number[], nick?: number[]}} [classes] - индексы колонок,
 *   которым нужен свой класс: числовые прижимаются вправо, ник не переносится.
 */
function headRow(keys, { num = [], nick = [] } = {}) {
  const cells = keys.map((key, i) => {
    const cls = num.includes(i) ? ' class="num"' : nick.includes(i) ? ' class="nick"' : '';
    // Строки словаря вставляются как текст: перевод — данные, не разметка.
    const text = t(key).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    return `<th${cls}>${text}</th>`;
  });
  return `<thead><tr>${cells.join('')}</tr></thead>`;
}

const STATUS_KEY = { battle: 'status.battle', idle: 'status.idle', offline: 'status.offline' };
// «Уничтожен» само по себе читается как «выбыл из боя навсегда», поэтому
// добавлено «выбирает»: игрок жив, он в ангаре выбирает следующую машину.
const PLAYER_STATUS = {
  alive: ['player.alive', 'alive'],
  dead: ['player.dead', 'dead'],
  left: ['player.left', 'left'],
  unknown: ['player.idle', 'idle'],
};
// Иконки классов приходят из main вместе со снапшотом (см. vehicle-class.js).
const CLASS_ICON = { tank: '▮', spaa: '◬', plane: '✈', heli: '⊹', drone: '⌖' };
const COUNTER_KEYS = ['session', 'today', 'week', 'month', 'year'];

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
  if (tab.dataset.tab === 'battles') refreshVehicleFilter().then(() => refreshBattles());
  if (tab.dataset.tab === 'mine') refreshMine();
  if (tab.dataset.tab === 'players') refreshPlayers();
  if (tab.dataset.tab === 'settings') {
    refreshDbStats();
    refreshWindowFlags();
  }
  if (tab.dataset.tab === 'account') refreshAccount();
  if (tab.dataset.tab === 'help') renderHelp();
  if (tab.dataset.tab === 'about') renderAbout();
  if (tab.dataset.tab === 'admin') {
    refreshAdminUsers();
    refreshAdminReports();
    refreshAdminVehicles();
    refreshAdminLog();
  }
});

// --- Утилиты ------------------------------------------------------------

/**
 * Мой ли это ник. В базе ники лежат с клан-тегом («[CLAN] Username»),
 * а в настройках он записан без него — сверяем и по хвосту.
 */
function isMyNick(nick) {
  const self = (lastState?.selfNick || '').trim();
  if (!self || !nick) return false;
  return nick === self || nick.endsWith(` ${self}`);
}

function clockText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Целое число по языку интерфейса, а не по языку системы. */
function fmtInt(n) {
  return Number(n || 0).toLocaleString(window.i18n.locale());
}

function dateText(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString(window.i18n.locale(), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Награда одной строкой: «Снайпер», «Снайпер (2 ст.)», «Удар из тени ×5».
 * Степень отделена от названия в базе, поэтому собираем её обратно здесь.
 */
function awardText(a) {
  const tier = a.tier > 0 ? t('award.tier', { n: a.tier }) : '';
  const count = a.count > 1 ? ` ×${a.count}` : '';
  return `${a.name}${tier}${count}`;
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
    td.textContent = t(p.status === 'left' ? 'player.leftNoSortie' : 'player.idle');
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
    const state = t(
      s.destroyed
        ? 'tip.sortDestroyed'
        : isCurrent
          ? 'tip.sortCurrent'
          : isEnded
            ? 'tip.sortEnded'
            : 'tip.sortAlive'
    );
    // В подсказке — полное имя из игры со служебными символами и смысл ×N.
    chip.title = `${s.vehicle}\n${state}\n${t('tip.sortFrags', { n: s.kills })}`;
    wrap.append(chip);
  });
  td.append(wrap);
  return td;
}

function playersTable(players) {
  if (!players.length) return el('div', 'empty', t('battle.empty'));

  const table = el('table');
  table.innerHTML = headRow(['col.nick', 'col.kills', 'col.deaths', 'col.assists', 'col.awards', 'col.status', 'col.vehiclesCurrent'], { num: [1, 2, 3, 4], nick: [0] });
  const tbody = el('tbody');

  for (const p of players) {
    const tr = el('tr');
    if (p.isSelf) tr.classList.add('is-self');
    if (p.status === 'left') tr.classList.add('row-left');
    if (p.status === 'dead') tr.classList.add('row-dead');
    // Обидчик, за которого ещё можно взять «Око за око».
    if (p.isRevengeTarget) {
      tr.classList.add('revenge');
      tr.title = t('player.revenge');
    }

    const nick = el('td', `nick${p.isSelf ? ' self' : ''}`);
    // Отряд — те, с кем игрок зашёл в бой сам. Помечаем зелёным значком:
    // подсветка всей строки конфликтовала бы с подсветкой своей строки и
    // с золотой рамкой «Око за око».
    if (p.inSquad && !p.isSelf) {
      const mark = el('span', 'squad-mark', '●');
      mark.title = t('player.squad');
      nick.append(mark);
    } else if (p.isFriend && !p.isSelf) {
      // Друг не в отряде — тоже зелёным, но пустым кружком: он свой человек,
      // однако на какой он стороне, программа не знает. Заполненный значок
      // означает «точно со мной», и путать эти два случая нельзя.
      const mark = el('span', 'squad-mark friend', '○');
      mark.title = t('player.friend');
      nick.append(mark);
    }
    const nameEl = el('span', `nick-name${p.isUser ? ' is-user' : ''}`, p.nick);
    // Подчёркивание значит одно: у человека есть аккаунт в программе. О его
    // команде это не говорит ничего, зато говорит другое — этот бой будет
    // кому подтвердить.
    if (p.isUser && !p.isSelf) nameEl.title = t('player.isUser');
    nameEl.addEventListener('click', () => openCard(p.nick));
    nick.append(nameEl);
    nick.title = p.nick;

    // Досье из базы: сколько раз уже встречались и на чём он обычно ездит.
    const d = dossierCache[p.nick];
    if (d && d.battles > 0 && !p.isSelf) {
      const mark = el('span', 'dossier', `${d.battles}`);
      const fav = d.favourite[0];
      mark.title =
        t('tip.dossier', { n: d.battles }) +
        (fav ? `\n${t('tip.dossierFav', { vehicle: fav.vehicle, n: fav.sorties })}` : '') +
        `\n${t('tip.dossierDuel', { killedMe: d.killedMe, killedByMe: d.killedByMe })}` +
        (d.note ? `\n\n${t('tip.dossierNote', { note: d.note })}` : '');
      if (d.note) mark.classList.add('has-note');
      nick.append(mark);
    }

    const [labelKey, cls] = PLAYER_STATUS[p.status] || PLAYER_STATUS.unknown;
    const st = el('td');
    st.append(el('span', `badge ${cls}`, t(labelKey)));

    const assists = el('td', 'num', String(p.assists || 0));
    assists.title = t('tip.assists');

    // Награды за бой — те, что игра пишет в кил-фид.
    const awardsCell = el('td', 'num');
    if (p.awards && p.awards.length) {
      const total = p.awards.reduce((s, a) => s + (a.count || 1), 0);
      const badge = el('span', 'awards', `★${total}`);
      badge.title = p.awards.map(awardText).join('\n');
      awardsCell.append(badge);
    }

    tr.append(
      nick,
      el('td', 'num', String(p.kills)),
      el('td', 'num', String(p.deaths)),
      assists,
      awardsCell,
      st,
      vehiclesCell(p)
    );
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/**
 * Неопознанных разводим по группам связей: внутри группы точно известно, кто
 * против кого, неизвестно лишь, какая из сторон моя. Как только появится связь
 * с моей командой, группа целиком переедет в «Свои» и «Противники».
 */
function unknownGroups(players) {
  const wrap = el('div');
  const byComponent = new Map();
  for (const p of players) {
    if (!byComponent.has(p.component)) byComponent.set(p.component, []);
    byComponent.get(p.component).push(p);
  }

  // Одиночки — те, кто ни с кем ещё не пересёкся.
  const loners = [];
  const groups = [];
  for (const [, list] of byComponent) {
    if (list.length < 2) loners.push(...list);
    else groups.push(list);
  }
  groups.sort((a, b) => b.length - a.length);

  // Объяснение сверху, а не в подсказке под вопросиком: «Группа 2: сторона A»
  // без него не значит ничего, и человек справедливо не понимает, что ему
  // показали и почему это длится.
  wrap.append(el('p', 'muted footnote', t('battle.unknownHint')));

  groups.forEach((list, i) => {
    const sideA = list.filter((p) => p.side === 0);
    const sideB = list.filter((p) => p.side === 1);
    if (!sideA.length || !sideB.length) {
      // Все на одной стороне — просто список, делить нечего.
      wrap.append(el('div', 'section-title', t('battle.group', { n: i + 1 })), playersTable(list));
      return;
    }
    wrap.append(el('div', 'section-title', t('battle.pair', { n: i + 1 })));
    const split = el('div', 'split');
    for (const [label, rows] of [
      [t('battle.pairSideA'), sideA],
      [t('battle.pairSideB'), sideB],
    ]) {
      const side = el('div', 'side');
      side.append(
        el('div', 'side-title', t('battle.sideTitle', { label, n: rows.length })),
        playersTable(rows)
      );
      split.append(side);
    }
    wrap.append(split);
  });

  if (loners.length) {
    wrap.append(
      el('div', 'section-title', t('battle.loners', { n: loners.length })),
      playersTable(loners)
    );
  }
  return wrap;
}

function renderBattle(state) {
  const isNewBattle = lastState && state.startedAt !== lastState.startedAt;
  lastState = state;
  if (isNewBattle) dossierCache = {};
  ensureDossier(state.players.map((p) => p.nick));

  $('dot').className = `dot ${state.status || 'offline'}`;
  // Снапшот боя приходит четыре раза в секунду и затирал бы сообщение об
  // ошибке быстрее, чем человек успевал его прочитать.
  if (!$('statusText').classList.contains('error')) {
    $('statusText').textContent =
      t(STATUS_KEY[state.status] || 'status.unknown') + (state.detail ? ` · ${state.detail}` : '');
  }
  // Сколько людей в этом бою смогут подтвердить его запись. Показываем только
  // когда они есть: «в бою ещё 0 пользователей» — это не сведение, а укор.
  const peers = state.usersInBattle
    ? ` · ${t('status.usersInBattle', { n: state.usersInBattle })}`
    : '';
  $('counter').textContent =
    `${clockText(state.clock)} · ${t('status.known', { n: state.knownPlayers })}${peers}`;

  // Отряд, которого в бою не видно. Формулировка нарочно нейтральная: человек
  // мог ошибиться списком, а мог просто ехать с молчаливым сокомандником,
  // который ещё никого не тронул, — и различить это нечем.
  const missing = state.squadMissing || [];
  $('squadMissing').hidden = missing.length === 0;
  if (missing.length) {
    $('squadMissing').textContent = t('battle.squadMissing', { nicks: missing.join(', ') });
  }

  const byTeam = (team) => state.players.filter((p) => p.team === team);
  const allies = byTeam('ally');
  const enemies = byTeam('enemy');
  const unknown = byTeam('unknown');

  const alive = (rows) => rows.filter((p) => p.status === 'alive').length;
  $('allyTitle').textContent = t('battle.side', {
    title: t('battle.allies'),
    total: allies.length,
    alive: alive(allies),
  });
  $('enemyTitle').textContent = t('battle.side', {
    title: t('battle.enemies'),
    total: enemies.length,
    alive: alive(enemies),
  });

  $('allyBody').replaceChildren(playersTable(allies));
  $('enemyBody').replaceChildren(playersTable(enemies));

  $('unknownBox').hidden = unknown.length === 0;
  if (unknown.length) {
    $('unknownTitle').textContent = t('battle.unknownTeamCount', { n: unknown.length });
    $('unknownBody').replaceChildren(unknownGroups(unknown));
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

  for (const name of COUNTER_KEYS) {
    const c = counters[name] || { battles: 0, from: 0 };
    const tile = el('div', 'tile');
    tile.append(
      el('div', 'label', t(`counter.${name}`)),
      el('div', 'value', String(c.battles)),
      el('div', 'since', t('counter.since', { date: dateText(c.from) }))
    );
    const btn = el('button', 'small', t('counter.reset'));
    btn.addEventListener('click', async () => {
      await window.wt.db.resetCounter(name);
      refreshCounters();
    });
    tile.append(btn);
    tiles.append(tile);
  }

  refreshCharts();
}

/** Час в виде «21:00–21:59» — подписи в заметках под графиками. */
const hourRange = (h) => t('chart.hourRange', { h: String(h).padStart(2, '0') });

/**
 * Русское склонение по числу: «1 победа», «2 победы», «5 побед».
 * @param {number} n
 * @param {[string, string, string]} forms - для 1, для 2, для 5
 */
function streakNote(s) {
  if (s.current.type === 'none') return t('stats.streak.none');
  const n = s.current.length;
  const word = window.i18n.plural(n, s.current.type === 'win' ? 'plural.wins' : 'plural.losses');
  const parts = [t('stats.streak.current', { n, word })];
  if (s.bestWin) parts.push(t('stats.streak.best', { n: s.bestWin }));
  if (s.worstLoss) parts.push(t('stats.streak.worst', { n: s.worstLoss }));
  return parts.join(' · ');
}

/**
 * Ширина контейнера в настоящих пикселях. График строится сразу в ней, а не в
 * условных единицах с последующим сжатием: при сжатии вместе с картинкой
 * ужимался и шрифт подписей — на половинной карточке 9px превращались в 5px.
 */
const chartWidth = (id) => Math.max(320, $(id).clientWidth || 720);

async function refreshCharts() {
  const period = $('statsPeriod').value || null;
  const [hours, days, streaks] = await Promise.all([
    window.wt.db.activityByHour({ period }),
    window.wt.db.dailyStats({ period }),
    window.wt.db.streaks({ recent: 50 }),
  ]);

  $('chartHours').replaceChildren(
    window.charts.hoursChart(hours, { width: chartWidth('chartHours') })
  );
  const best = window.charts.bestHours(hours);
  $('hoursNote').textContent = best
    ? t('stats.hours.best', {
        best: hourRange(best.best.hour),
        bestWr: Math.round(best.best.wr * 100),
        bestN: best.best.played,
        bestWord: window.i18n.plural(best.best.played, 'plural.battles'),
        worst: hourRange(best.worst.hour),
        worstWr: Math.round(best.worst.wr * 100),
        worstN: best.worst.played,
      })
    : t('stats.hours.notEnough');

  $('chartStreak').replaceChildren(
    window.charts.streakStrip(streaks.recent, { width: chartWidth('chartStreak') })
  );
  $('streakNote').textContent = streakNote(streaks);

  // Линии по двум точкам смысла не имеют — честнее сказать, что рано.
  $('chartTrend').replaceChildren(
    days.length >= 2
      ? window.charts.trendChart(days, { width: chartWidth('chartTrend') })
      : el('div', 'empty', t('stats.trend.notEnough'))
  );

  // Календарь всегда за полгода: он про режим игры, а не про выбранный период.
  const allDays = period ? await window.wt.db.dailyStats({}) : days;
  $('chartGrass').replaceChildren(
    window.charts.grassChart(allDays, { weeks: 26, width: chartWidth('chartGrass') })
  );
}

$('statsPeriod').addEventListener('change', refreshCharts);

// Ширина графиков зашита в момент отрисовки, поэтому после изменения размера
// окна их надо построить заново — иначе подписи разъедутся с картинкой.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!$('panel-counters').classList.contains('active')) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refreshCharts, 200);
});

// --- Вкладка «Бои» ------------------------------------------------------

/** Состав боя: две колонки, свои и противники, как во вкладке «Бой». */
function battleRoster(details) {
  const wrap = el('div', 'roster');
  const split = el('div', 'split');

  for (const [team, titleKey] of [
    ['ally', 'battles.teamAlly'],
    ['enemy', 'battles.teamEnemy'],
    ['unknown', 'battles.teamUnknown'],
  ]) {
    const rows = details.players.filter((p) => p.team === team);
    if (!rows.length) continue;

    const side = el('div', 'side');
    side.append(
      el('div', `side-title ${team}`, t('battle.sideTitle', { label: t(titleKey), n: rows.length }))
    );

    const table = el('table');
    table.innerHTML = headRow(['col.nick', 'col.kda', 'col.awardsFull', 'col.vehicles'], { nick: [0] });
    const tbody = el('tbody');
    for (const p of rows) {
      const tr = el('tr');
      if (isMyNick(p.nick)) tr.classList.add('is-self');
      if (p.left_battle) tr.classList.add('row-left');
      const nick = el('td', `nick${isMyNick(p.nick) ? ' self' : ''}`, p.nick);
      nick.title = p.nick;
      const kda = el('td');
      kda.append(kdaBadge(p.kills, p.deaths, p.assists));

      const awards = el('td', 'muted');
      awards.textContent = (p.awards || []).map(awardText).join(', ') || '—';

      tr.append(nick, kda, awards, el('td', 'muted', p.vehicles.join(' · ') || '—'));
      tbody.append(tr);
    }
    table.append(tbody);
    side.append(table);
    split.append(side);
  }

  wrap.append(split);
  return wrap;
}

// Сколько боёв подгружается за раз. Рисовать всю историю разом нельзя: на
// нескольких тысячах записей окно встаёт колом на отрисовке таблицы.
const BATTLES_PAGE = 50;

const battlesFilter = { query: '', period: '', from: 0, to: 0, result: '', myVehicle: '' };
// Сколько строк сейчас на экране — от этого считается и «показать ещё», и
// перерисовка после записи нового боя: она не должна схлопывать выдачу к
// первой странице, если человек уже пролистал вглубь.
let battlesLoaded = 0;
// Номер последнего запроса. Обновлений может идти несколько сразу (переключение
// вкладки, ввод в поиске, запись боя), и ответы возвращаются не в том порядке,
// в каком уходили — устаревший ответ не должен затирать свежую выдачу.
let battlesRequest = 0;

const RESULT_CLASS = { win: 'result-win', loss: 'result-loss' };

/**
 * Значок доверия к записи о бое.
 *
 *   confirmed — кто-то ещё из участников прислал такую же запись;
 *   disputed  — чужая запись об этом бою расходится с нашей.
 *
 * Для pending и alone значка нет намеренно. Пока пользователей мало, игрок
 * в большинстве боёв единственный, и подтверждать его записи попросту некому;
 * значок «не подтверждено» у всех подряд читался бы как подозрение.
 */
const TRUST_MARK = { confirmed: '✓', disputed: '!' };

// --- Удаление боя --------------------------------------------------------

// Какой бой сейчас в окне подтверждения. Держим отдельно, чтобы обработчик
// кнопки не зависел от того, что успело перерисоваться в таблице.
let battleToDelete = null;

/**
 * Спрашивает подтверждение и только потом удаляет.
 *
 * Подтверждённый бой — это бой, который прислал кто-то ещё из участников, и
 * записи сошлись. Такой удаляется через отдельную галочку: у обычного боя цена
 * ошибки — своя же строка в истории, а тут человек трогает то, что служит
 * доказательством и ему самому.
 *
 * ВАЖНО, чего удаление НЕ делает и делать не будет: оно не уменьшает
 * накопительные итоги. Всего боёв, всего побед и КДА за всё время считаются
 * отдельно от списка (account_totals на сервере) и от удаления не меняются.
 * Иначе «удалить неудачные бои» стало бы способом нарисовать себе статистику,
 * и всей сверке грош цена.
 */
function askDeleteBattle(b) {
  battleToDelete = b;
  const confirmed = b.trust === 'confirmed';

  $('delBattleWhat').textContent = t('delBattle.what', {
    when: dateText(b.started_at),
    kda: b.cancelled ? '—' : `${b.my_kills}/${b.my_deaths}/${b.my_assists}`,
  });
  $('delBattleConfirmed').hidden = !confirmed;
  $('delBattleAgree').checked = false;
  // У обычного боя кнопка активна сразу: лишний клик по галочке там ничего не
  // защищает, а раздражает каждый раз.
  $('delBattleGo').disabled = confirmed;
  $('deleteBattleModal').hidden = false;
}

$('delBattleAgree').addEventListener('change', (e) => {
  $('delBattleGo').disabled = !e.target.checked;
});

$('delBattleCancel').addEventListener('click', () => {
  $('deleteBattleModal').hidden = true;
  battleToDelete = null;
});

$('delBattleGo').addEventListener('click', async () => {
  if (!battleToDelete) return;
  const id = battleToDelete.id;
  $('deleteBattleModal').hidden = true;
  battleToDelete = null;
  await window.wt.db.deleteBattle(id);
  refreshBattles();
  refreshCounters();
});

/** Одна строка боя плюс скрытая строка с составом под ней. */
function battleRow(b) {
  const tr = el('tr', 'clickable');

  const actions = el('td');
  const del = el('button', 'small danger', t('battles.delete'));
  del.addEventListener('click', (e) => {
    e.stopPropagation(); // не раскрывать строку по клику на удаление
    askDeleteBattle(b);
  });
  actions.append(del);

  // У отменённого боя цифр не показываем вовсе. Нули читались бы как результат
  // («сыграл вничью по нулям»), а зачёркнутый КДА всё равно принимают за
  // настоящий. Прочерк честнее: данных нет.
  const kda = el('td');
  if (b.cancelled) {
    kda.className = 'muted';
    kda.textContent = '—';
  } else {
    kda.append(kdaBadge(b.my_kills, b.my_deaths, b.my_assists));
  }

  const resultClass = b.cancelled ? 'cancelled' : RESULT_CLASS[b.result] || 'muted';
  const resultLabel = b.cancelled
    ? t('battles.cancelled')
    : RESULT_CLASS[b.result]
      ? t(`result.${b.result}`)
      : t('result.none');

  if (b.cancelled) {
    tr.classList.add('row-cancelled');
    tr.title = t('battles.cancelledHint');
  }

  // Отметка доверия у даты. Показывается только когда есть что сказать:
  // у боя, которого никто больше не видел, отметки нет вовсе — отсутствие
  // подтверждения обвинением не является, и «серая галочка» читалась бы
  // именно как обвинение.
  const when = el('td', null);
  when.append(document.createTextNode(dateText(b.started_at)));
  const mark = TRUST_MARK[b.trust];
  if (mark) {
    const badge = el('span', `trust ${b.trust}`, mark);
    badge.title = t(`trust.${b.trust}`);
    when.append(badge);
  }

  tr.append(
    when,
    el('td', 'num', clockText(b.duration)),
    el('td', resultClass, resultLabel),
    kda,
    el('td', null, b.my_vehicles.join(', ') || '—'),
    el('td', 'num', String(b.players_seen)),
    actions
  );

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
      details ? battleRoster(details) : el('div', 'empty', t('battles.rosterNotFound'))
    );
    loaded = true;
  });

  return [tr, detailRow];
}

/** Дата из поля ввода в миллисекунды. edge='end' — конец суток, а не начало. */
function dateInputMs(value, edge = 'start') {
  if (!value) return 0;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 0;
  if (edge === 'end') d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Активен ли хоть один фильтр — от этого зависит текст пустой выдачи. */
function filtersActive() {
  const f = battlesFilter;
  return !!(f.query || f.period || f.from || f.to || f.result || f.myVehicle);
}

function readFilters() {
  battlesFilter.query = $('battleQuery').value.trim();
  battlesFilter.result = $('battleResult').value;
  battlesFilter.myVehicle = $('battleVehicle').value;

  const period = $('battlePeriod').value;
  const custom = period === 'custom';
  $('battleRange').hidden = !custom;
  battlesFilter.period = custom ? '' : period;
  let from = custom ? dateInputMs($('battleFrom').value) : 0;
  let to = custom ? dateInputMs($('battleTo').value, 'end') : 0;

  // Даты поставили задом наперёд — меняем местами, а не показываем пустой
  // список. Человек почти наверняка перепутал поля, и молчаливое «ничего не
  // найдено» он воспримет как поломку программы, а не как свою ошибку.
  if (from && to && from > to) {
    [from, to] = [to, from];
    const a = $('battleFrom').value;
    $('battleFrom').value = $('battleTo').value;
    $('battleTo').value = a;
  }

  battlesFilter.from = from;
  battlesFilter.to = to;
}

function summaryText(s) {
  if (!s.battles && !s.cancelled) return '';
  const parts = [t('battles.found', { n: s.battles })];
  if (s.percent !== null) parts.push(t('battles.winPercent', { n: s.percent }));
  if (s.battles) parts.push(t('battles.kda', { n: s.kda.toFixed(2) }));
  if (s.unknown) parts.push(t('battles.noResult', { n: s.unknown }));
  // Отменённые считаем отдельно и говорим об этом вслух: иначе человек увидит
  // в списке двадцать боёв, а в сводке восемнадцать и решит, что она врёт.
  if (s.cancelled) parts.push(t('summary.cancelled', { n: s.cancelled }));
  return parts.join(' · ');
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.append] - дописать следующую страницу вместо
 *   перерисовки: иначе «показать ещё» дёргало бы список к началу.
 */
async function refreshBattles({ append = false } = {}) {
  if (!append) readFilters();

  const limit = append ? BATTLES_PAGE : Math.max(BATTLES_PAGE, battlesLoaded);
  const offset = append ? battlesLoaded : 0;
  const ticket = ++battlesRequest;

  const [found, stats] = await Promise.all([
    window.wt.db.searchBattles({ ...battlesFilter, limit, offset }),
    window.wt.db.stats(),
  ]);
  if (ticket !== battlesRequest) return; // нас обогнал более свежий запрос

  const mb = (stats.sizeBytes / 1024 / 1024).toFixed(1);
  $('battlesTotal').textContent = t('battles.total', { battles: stats.battles, mb });
  $('battlesSummary').textContent = summaryText(found.summary);

  const body = $('battlesBody');
  const tbody = append ? body.querySelector('tbody') : null;

  if (append && tbody) {
    for (const b of found.rows) tbody.append(...battleRow(b));
    battlesLoaded += found.rows.length;
  } else {
    if (!found.rows.length) {
      body.replaceChildren(
        el(
          'div',
          'empty',
          t(filtersActive() ? 'battles.emptyFiltered' : 'battles.empty')
        )
      );
      battlesLoaded = 0;
      $('battlesMore').hidden = true;
      return;
    }

    const table = el('table');
    table.innerHTML = headRow(
      ['col.when', 'col.duration', 'col.result', 'col.kda', 'col.myVehicles', 'col.playersSeen', 'empty.cell'],
      { num: [1, 5] }
    );
    const fresh = el('tbody');
    for (const b of found.rows) fresh.append(...battleRow(b));
    table.append(fresh);
    body.replaceChildren(table);
    battlesLoaded = found.rows.length;
  }

  const left = found.total - battlesLoaded;
  $('battlesMore').hidden = left <= 0;
  $('battlesMore').textContent = t('battles.more', { n: Math.min(left, BATTLES_PAGE), left });
}

/** Список моей техники для фильтра. Выбранное значение переживает обновление. */
async function refreshVehicleFilter() {
  const rows = await window.wt.db.myVehicles({});
  const select = $('battleVehicle');
  const previous = select.value;

  // value обязателен: у <option> без него значением становится сам текст, и
  // «любая» уехала бы в фильтр как название машины.
  const any = el('option', null, t('battles.anyVehicle'));
  any.value = '';
  select.replaceChildren(any);
  for (const r of rows) {
    const option = el('option', null, r.label || r.vehicle);
    option.value = r.vehicle;
    select.append(option);
  }
  // Машина могла исчезнуть вместе с удалённым боем — тогда фильтр снимаем.
  select.value = [...select.options].some((o) => o.value === previous) ? previous : '';
}

// Ввод в поиске не дёргает базу на каждую букву.
let queryTimer = null;
$('battleQuery').addEventListener('input', () => {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    battlesLoaded = 0; // новый запрос — снова с первой страницы
    refreshBattles();
  }, 200);
});

for (const id of ['battlePeriod', 'battleResult', 'battleVehicle', 'battleFrom', 'battleTo']) {
  $(id).addEventListener('change', () => {
    battlesLoaded = 0;
    refreshBattles();
  });
}

$('battleReset').addEventListener('click', () => {
  $('battleQuery').value = '';
  $('battlePeriod').value = '';
  $('battleFrom').value = '';
  $('battleTo').value = '';
  $('battleResult').value = '';
  $('battleVehicle').value = '';
  battlesLoaded = 0;
  refreshBattles();
});

$('battlesMore').addEventListener('click', () => refreshBattles({ append: true }));

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
  badge.title =
    `${t('tip.kda', { k, d, a })}\n${t('tip.kdaRatio', { ratio })}` +
    (d === 0 ? t('tip.kdaNoDeaths') : '');
  return badge;
}

function topTable(rows) {
  if (!rows.length) return el('div', 'empty', t('players.emptyTop'));

  const table = el('table');
  table.innerHTML = headRow(['col.nick', 'col.battles', 'col.kda', 'col.lastSeen'], {
    nick: [0],
    num: [1],
  });
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
  // Ограничения в разметке (min/max) — подсказка браузеру, а не защита: их
  // обходит и ввод с клавиатуры, и вставка из буфера. Дробное «5.5» тоже
  // приходит сюда как есть. Поэтому чиним значение здесь, а не надеемся.
  const raw = Math.floor(Number($('minBattles').value));
  const minBattles = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 1;
  if (String(minBattles) !== $('minBattles').value) $('minBattles').value = minBattles;
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

/** Винрейт по машине: только бои, где исход удалось распознать. */
function winrateOf(r) {
  const decided = (r.wins || 0) + (r.losses_battles || 0);
  return decided ? r.wins / decided : null;
}

// Колонки таблиц «Моей техники». value — по чему сортируем, cell — что рисуем.
const MY_COLUMNS = [
  { key: 'vehicle', title: 'col.vehicle', value: (r) => (r.label || r.vehicle).toLowerCase() },
  { key: 'sorties', title: 'col.sorties', num: true, value: (r) => r.sorties },
  { key: 'kills', title: 'col.frags', num: true, value: (r) => r.kills || 0 },
  { key: 'losses', title: 'col.losses', num: true, value: (r) => r.losses || 0 },
  {
    key: 'winrate',
    title: 'col.winrate',
    num: true,
    // Машины без известного исхода держим внизу при любом направлении.
    value: (r) => (winrateOf(r) === null ? -1 : winrateOf(r)),
  },
];

const ENEMY_COLUMNS = [
  { key: 'vehicle', title: 'col.vehicle', value: (r) => (r.label || r.vehicle).toLowerCase() },
  { key: 'sorties', title: 'col.sorties', num: true, value: (r) => r.sorties },
  { key: 'kills', title: 'col.frags', num: true, value: (r) => r.kills || 0 },
  { key: 'players', title: 'col.playersCount', num: true, value: (r) => r.players },
];

// Состояние сортировки у каждой таблицы своё.
const sortState = {
  mine: { key: 'sorties', dir: 'desc' },
  enemy: { key: 'sorties', dir: 'desc' },
};

function vehicleTable(rows, { mine }) {
  if (!rows.length) {
    return el('div', 'empty', t(mine ? 'mine.emptyMine' : 'mine.emptyEnemy'));
  }

  const columns = mine ? MY_COLUMNS : ENEMY_COLUMNS;
  const state = sortState[mine ? 'mine' : 'enemy'];
  const column = columns.find((c) => c.key === state.key) || columns[1];

  const sorted = [...rows].sort((a, b) => {
    const av = column.value(a);
    const bv = column.value(b);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return state.dir === 'asc' ? cmp : -cmp;
  });

  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const c of columns) {
    const th = el('th', `sortable${c.num ? ' num' : ''}`);
    th.append(t(c.title));
    if (c.key === state.key) {
      th.append(el('span', 'sort-arrow', state.dir === 'asc' ? ' ↑' : ' ↓'));
      th.classList.add('sorted');
    }
    th.title = t('tip.sortable');
    th.addEventListener('click', () => {
      // Повторный клик по той же колонке переворачивает порядок.
      if (state.key === c.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else {
        state.key = c.key;
        // Числа интереснее сверху вниз, названия — по алфавиту.
        state.dir = c.num ? 'desc' : 'asc';
      }
      refreshMine();
    });
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const r of sorted) {
    const tr = el('tr');
    const veh = el('td');
    veh.append(vehicleNode(r.label || r.vehicle, r.class));
    veh.title = r.vehicle;

    if (mine) {
      const ratio = winrateOf(r);
      const cell = el('td', `num${ratio === null ? ' muted' : ''}`, ratio === null ? '—' : `${Math.round(ratio * 100)}%`);
      cell.title =
        ratio === null
          ? t('tip.winrateUnknown')
          : t('tip.winrateOf', {
              wins: r.wins,
              total: (r.wins || 0) + (r.losses_battles || 0),
            });
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
    el('div', 'label', t('mine.winrate')),
    el('div', 'value', wr.percent === null ? '—' : `${wr.percent}%`),
    el(
      'div',
      'since',
      wr.percent === null
        ? t('mine.winrateNone', { n: wr.total })
        : t('mine.winrateSome', { wins: wr.wins, losses: wr.losses }) +
          (wr.unknown ? t('mine.winrateUnknownTail', { n: wr.unknown }) : '')
    )
  );

  $('myVehicles').replaceChildren(vehicleTable(mine, { mine: true }));
  $('enemyVehicles').replaceChildren(vehicleTable(enemy, { mine: false }));
}

$('minePeriod').addEventListener('change', refreshMine);

// --- Аккаунт ------------------------------------------------------------

const AUTH_SCREENS = ['authGuest', 'authSignIn', 'authRegister', 'authSignedIn'];

function showAuthScreen(id) {
  for (const screen of AUTH_SCREENS) $(screen).hidden = screen !== id;
  for (const box of ['siError', 'regError']) $(box).hidden = true;
}

// --- Жалоба на игрока ----------------------------------------------------

$('cardReportSend').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const message = $('cardReportText').value.trim();
  if (message.length < 10) {
    $('cardReportError').textContent = t('report.tooShort');
    $('cardReportError').hidden = false;
    return;
  }
  setBusy(button, true);
  try {
    await window.wt.support.reportPlayer({ nick: cardNick, message });
    $('cardReport').open = false;
    $('cardReportText').value = '';
    showError(t('card.reportSent'));
  } catch (err) {
    $('cardReportError').textContent = err?.offline ? t('acc.offline') : err?.message || String(err);
    $('cardReportError').hidden = false;
  } finally {
    setBusy(button, false);
  }
});

// --- Сообщение о проблеме ------------------------------------------------

/** Сведения, которые программа прикладывает к сообщению. */
let reportContext = null;

/**
 * Показывает ровно то, что уйдёт вместе с текстом.
 *
 * Не список названий, а сами значения: «прикладываются версия и язык» человек
 * прочитает как «что-то техническое», а «uiLang: ru» — как то, что он может
 * оценить и с чем может не согласиться.
 */
function renderReportContext() {
  const box = $('reportMeta');
  if (!reportContext || !$('reportAttach').checked) {
    box.textContent = t('report.attachedNone');
    return;
  }
  const c = reportContext;
  const строки = [
    `${t('report.ctx.version')}: ${c.appVersion}`,
    `${t('report.ctx.os')}: ${c.osVersion}`,
    `${t('report.ctx.lang')}: ${c.lang}`,
    `${t('report.ctx.who')}: ${c.login || t('report.noAccount')}`,
    `${t('report.ctx.game')}: ${t(STATUS_KEY[c.gameStatus] || 'status.unknown')}`,
  ];
  if (c.unparsed?.length) {
    строки.push('', `${t('report.ctx.unparsed')}:`, ...c.unparsed.map((l) => `  ${l}`));
  }
  box.textContent = строки.join('\n');
}

$('reportBtn').addEventListener('click', async () => {
  $('reportError').hidden = true;
  for (const id of ['reportTitle', 'reportText', 'reportSteps']) $(id).value = '';
  $('reportTag').value = '';
  $('reportAttach').checked = true;
  $('reportModal').hidden = false;
  reportContext = await window.wt.support.context();
  renderReportContext();
  renderMyReports();
  $('reportTag').focus();
});

$('reportAttach').addEventListener('change', renderReportContext);

/** Прежние сообщения и что с ними стало. Только для тех, кто вошёл. */
async function renderMyReports() {
  const box = $('reportMineBox');
  box.hidden = true;
  if (!reportContext?.signedIn) return;
  let items;
  try {
    items = (await window.wt.support.mine())?.items || [];
  } catch {
    // Сервера нет — молчим. Список прежних сообщений не то, ради чего стоит
    // показывать ошибку поверх формы, которую человек как раз заполняет.
    return;
  }
  if (!items.length) return;

  $('reportMine').replaceChildren(
    ...items.slice(0, 10).map((r) => {
      const row = el('div', 'friend-row');
      const name = el('div', 'friend-name');
      name.append(el('div', null, `#${r.id} · ${r.title || t(`report.tag.${r.tag}`) || r.tag}`));
      name.append(
        el('div', 'friend-status', t(r.status === 'resolved' ? 'report.resolved' : 'report.open'))
      );
      // Ответ администратора виден автору. Ответ, который человек не может
      // прочитать, ответом не является.
      if (r.answer) name.append(el('div', 'friend-status', r.answer));
      row.append(name);
      return row;
    })
  );
  box.hidden = false;
}

$('reportCancel').addEventListener('click', () => {
  $('reportModal').hidden = true;
});

$('reportSend').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const message = $('reportText').value.trim();
  // Тег обязателен. Проверяем до текста: без тега сообщение попадёт в общую
  // кучу, и тогда неважно, насколько хорошо оно написано.
  if (!$('reportTag').value) {
    $('reportError').textContent = t('report.needTag');
    $('reportError').hidden = false;
    $('reportTag').focus();
    return;
  }
  if (message.length < 10) {
    $('reportError').textContent = t('report.tooShort');
    $('reportError').hidden = false;
    return;
  }
  setBusy(button, true);
  try {
    const answer = await window.wt.support.send({
      message,
      tag: $('reportTag').value,
      title: $('reportTitle').value.trim(),
      steps: $('reportSteps').value.trim(),
      // Отказался прикладывать — уходит пусто. Тихо приложить всё равно
      // означало бы, что галочка ничего не решает.
      context: $('reportAttach').checked ? reportContext : null,
    });
    $('reportModal').hidden = true;
    // Подтверждение — в строке состояния: отдельная «спасибо»-модалка поверх
    // только что закрытой это ещё одно окно, которое надо закрывать.
    // Номер обязателен: по нему человек потом спросит, что решили.
    showError(t('report.sentNumber', { n: answer?.id ?? '—' }));
  } catch (err) {
    $('reportError').textContent = err?.offline ? t('acc.offline') : err?.message || String(err);
    $('reportError').hidden = false;
  } finally {
    setBusy(button, false);
  }
});

// --- Администрирование ---------------------------------------------------

function showAdminError(error) {
  const box = $('adminError');
  box.textContent = error?.offline ? t('acc.offline') : error?.message || String(error);
  box.hidden = false;
}

/** Кнопка, которая сама блокируется на время запроса и ловит ошибку. */
function adminButton(label, run, cls) {
  const button = el('button', `small ${cls || ''}`, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    $('adminError').hidden = true;
    try {
      await run();
    } catch (e) {
      showAdminError(e);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

/**
 * Спрашивает одно или несколько значений прямо в строке пользователя.
 *
 * prompt() в Electron не работает, а отдельное окно ради двух полей — это
 * разметка и обработчики на каждое действие.
 *
 * Поле «ваш пароль» у опасных действий — не формальность и не проверка
 * памяти. Токен даёт доступ к аккаунту, но пароля в нём нет: одна лишняя
 * строка отделяет «увели сессию» от «сменили пароль всем пользователям».
 *
 * @param {HTMLElement} row
 * @param {Array<{name: string, label: string, placeholder?: string, password?: boolean}>} fields
 * @param {(values: Record<string, string>) => Promise<void>} onDone
 */
function askFields(row, fields, onDone) {
  // Второе нажатие не должно открывать вторую форму поверх первой.
  row.querySelector('.admin-ask')?.remove();

  const form = el('form', 'admin-ask');
  const inputs = {};
  for (const f of fields) {
    const input = el('input');
    input.type = f.password ? 'password' : 'text';
    input.placeholder = f.placeholder || '';
    if (f.password) input.autocomplete = 'current-password';
    inputs[f.name] = input;
    form.append(el('span', 'muted', f.label), input);
  }
  form.append(el('button', 'small', t('admin.apply')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const [name, input] of Object.entries(inputs)) {
      const value = input.value.trim();
      if (!value) return; // пустое поле — просто не отправляем
      values[name] = value;
    }
    form.remove();
    try {
      await onDone(values);
    } catch (err) {
      showAdminError(err);
    }
  });
  row.append(form);
  Object.values(inputs)[0]?.focus();
}

/** Поле «ваш пароль» — одинаковое во всех опасных действиях. */
const confirmField = () => ({
  name: 'confirm',
  label: t('admin.yourPassword'),
  placeholder: t('admin.yourPasswordHint'),
  password: true,
});

function adminUserRow(u) {
  const row = el('div', 'admin-user');
  const head = el('div', 'admin-user-head');
  head.append(
    el('span', 'admin-login', u.login),
    el('span', 'muted', `#${u.id} · ${t(`acc.role.${u.role === 'admin' ? 'admin' : 'user'}`)}`)
  );
  if (u.blocked) head.append(el('span', 'trust disputed', t('admin.blocked')));
  // Сколько раз этого человека блокировали. Первый случай и пятый — разные
  // разговоры, и знать это надо до того, как принимаешь решение, а не после
  // раскопок в журнале.
  if (u.bans > 0) head.append(el('span', 'muted small', t('admin.bans', { n: u.bans })));
  if (u.avatar_banned) head.append(el('span', 'muted small', t('admin.avatarBanned')));
  row.append(head);

  const actions = el('div', 'admin-actions');

  actions.append(
    adminButton(t('admin.newCode'), () =>
      // Новый код восстановления — это ключ от чужого аккаунта, опасно ровно
      // так же, как смена пароля.
      askFields(row, [confirmField()], async ({ confirm }) => {
        const { recovery_code: code } = await window.wt.admin.newRecoveryCode(u.id, confirm);
        // Код показывается один раз и нигде не хранится — в том числе у нас.
        // Поэтому не всплывающее сообщение, а строка, которую можно выделить.
        row.append(el('div', 'admin-result', t('admin.newCodeResult', { code })));
      })
    )
  );

  // Пароль администратор не назначает, а объявляет негодным: назначить — значит
  // знать пароль от чужого аккаунта и мочь войти под ним. Новый задаёт сам
  // игрок по своему коду восстановления, и код администратору не показывается.
  actions.append(
    adminButton(t('admin.resetPassword'), () =>
      askFields(row, [confirmField()], async ({ confirm }) => {
        await window.wt.admin.setPassword(u.id, '', confirm);
        row.append(el('div', 'admin-result', t('admin.resetPasswordDone')));
      })
    )
  );

  actions.append(
    adminButton(t('admin.clearAvatar'), async () => {
      await window.wt.admin.clearAvatar(u.id);
      row.append(el('div', 'admin-result', t('admin.clearAvatarDone')));
    })
  );

  actions.append(
    u.blocked
      ? adminButton(t('admin.unblock'), () =>
          askFields(row, [confirmField()], async ({ confirm }) => {
            await window.wt.admin.block(u.id, false, null, confirm);
            refreshAdminUsers();
          })
        )
      : adminButton(
          t('admin.block'),
          () =>
            // Причина обязательна: молчаливый бан порождает переписку «за что»,
            // на которую через полгода нечем ответить.
            askFields(
              row,
              [
                { name: 'reason', label: t('admin.blockReason'), placeholder: t('admin.blockReasonHint') },
                confirmField(),
              ],
              async ({ reason, confirm }) => {
                await window.wt.admin.block(u.id, true, reason, confirm);
                refreshAdminUsers();
              }
            ),
          'danger'
        )
  );

  // Права заблокированному не выдаются, и кнопки для этого нет: предлагать
  // действие, которое сервер всё равно отклонит, — обман интерфейса. Снять
  // права заблокированному по-прежнему можно: иначе администратора, который
  // натворил дел и потому заблокирован, нельзя было бы разжаловать.
  const можноМенятьРоль = u.role === 'admin' || !u.blocked;
  if (можноМенятьРоль) {
    actions.append(
      adminButton(u.role === 'admin' ? t('admin.demote') : t('admin.promote'), () =>
        askFields(row, [confirmField()], async ({ confirm }) => {
          await window.wt.admin.setRole(u.id, u.role === 'admin' ? 'user' : 'admin', confirm);
          refreshAdminUsers();
        })
      )
    );
  }

  row.append(actions);
  return row;
}

async function refreshAdminUsers() {
  const query = $('adminQuery').value.trim();
  $('adminError').hidden = true;
  try {
    const users = await window.wt.admin.findUsers(query);
    $('adminUsers').replaceChildren(
      ...(users.length ? users.map(adminUserRow) : [el('div', 'empty', t('admin.noUsers'))])
    );
  } catch (e) {
    showAdminError(e);
  }
}

function adminReportRow(r) {
  const row = el('div', `admin-user${r.resolved ? ' resolved' : ''}`);
  const head = el('div', 'admin-user-head');
  head.append(
    el('span', 'admin-login', t(`report.kind.${r.kind}`)),
    el('span', 'muted', `#${r.id} · ${r.login || t('report.noAccount')} · ${dateText(Date.parse(r.created_at))}`)
  );
  // Жалоба на игрока: на кого и сколько таких всего. Пять жалоб на один ник —
  // совсем другой разговор, чем одна, и видеть это надо сразу.
  if (r.target_nick) {
    const target = el('span', 'trust disputed', r.target_nick);
    if (r.target_reports > 1) {
      target.append(document.createTextNode(` · ${t('admin.targetCount', { n: r.target_reports })}`));
    }
    head.append(target);
  }
  if (r.app_version) head.append(el('span', 'muted', `${r.app_version} · ${r.os_version || '—'}`));
  row.append(head);

  // Текст сообщения как есть, с переносами: люди присылают шаги
  // воспроизведения списком, и склеивать их в абзац — терять смысл.
  row.append(el('pre', 'admin-report-text', r.message));
  if (r.admin_note) row.append(el('div', 'admin-result', r.admin_note));

  const actions = el('div', 'admin-actions');
  actions.append(
    r.resolved
      ? adminButton(t('admin.reopen'), async () => {
          await window.wt.admin.resolveReport(r.id, false);
          refreshAdminReports();
        })
      : adminButton(t('admin.resolve'), () =>
          // Пометка не опасное действие: пароль тут был бы издевательством.
          askFields(
            row,
            [{ name: 'note', label: t('admin.note'), placeholder: t('admin.noteHint') }],
            async ({ note }) => {
              await window.wt.admin.resolveReport(r.id, true, note);
              refreshAdminReports();
            }
          )
        )
  );
  row.append(actions);
  return row;
}

async function refreshAdminReports() {
  try {
    const reports = await window.wt.admin.reports($('adminReportScope').value);
    $('adminReports').replaceChildren(
      ...(reports.length ? reports.map(adminReportRow) : [el('div', 'empty', t('admin.noReports'))])
    );
  } catch (e) {
    showAdminError(e);
  }
}

/**
 * Журнал административных действий.
 *
 * Читать может любой администратор — в этом и смысл: журнал ведётся не для
 * себя, а друг для друга. Записи не удаляются и не правятся, поэтому кнопок
 * тут нет вовсе, только список.
 */
async function refreshAdminLog() {
  try {
    const rows = await window.wt.admin.log();
    $('adminLog').replaceChildren(
      ...(rows.length
        ? rows.map((r) => {
            const row = el('div', 'admin-user');
            const head = el('div', 'admin-user-head');
            head.append(
              el('span', 'admin-login', t(`admin.action.${r.action}`) || r.action),
              el('span', 'muted', `${r.admin_login} → ${r.target_login || '—'}`),
              el('span', 'muted', dateText(Date.parse(r.at)))
            );
            row.append(head);
            const details = Object.entries(r.details || {}).filter(([, v]) => v !== null && v !== '');
            if (details.length) {
              row.append(
                el('div', 'admin-result', details.map(([k, v]) => `${k}: ${v}`).join(' · '))
              );
            }
            return row;
          })
        : [el('div', 'empty', t('admin.logEmpty'))])
    );
  } catch (e) {
    showAdminError(e);
  }
}

/**
 * Названия техники, встреченные в боях.
 *
 * Половину работы делает транслитерация на сервере: «Т-80БВМ» и «T-80BVM»
 * сходятся сами. Сюда попадает то, что механически не сводится, — переведённые
 * словом названия вроде «Пантера» и «Panther». Сортировка по частоте: сводить
 * имеет смысл то, на чём реально ездят, а не весь справочник игры.
 */
async function refreshAdminVehicles() {
  try {
    const rows = await window.wt.admin.vehicles();
    $('adminVehicles').replaceChildren(
      ...(rows.length
        ? rows.map((v) => {
            const row = el('div', 'admin-user');
            const head = el('div', 'admin-user-head');
            head.append(
              el('span', 'admin-login', v.spellings.join(' · ')),
              el('span', 'muted', t('admin.vehicleSorties', { n: v.sorties }))
            );
            // Несколько написаний под одним ключом — уже сведено само.
            if (v.spellings.length > 1) head.append(el('span', 'trust confirmed', '✓'));
            if (v.canonical) head.append(el('span', 'muted', `→ ${v.canonical}`));
            row.append(head);

            const actions = el('div', 'admin-actions');
            actions.append(
              adminButton(t('admin.vehicleMerge'), () =>
                askFields(
                  row,
                  [
                    {
                      name: 'canonical',
                      label: t('admin.vehicleCanonical'),
                      placeholder: t('admin.vehicleCanonicalHint'),
                    },
                  ],
                  async ({ canonical }) => {
                    await window.wt.admin.setVehicleAlias(v.spellings[0], canonical);
                    refreshAdminVehicles();
                  }
                )
              )
            );
            row.append(actions);
            return row;
          })
        : [el('div', 'empty', t('admin.vehiclesEmpty'))])
    );
  } catch (e) {
    showAdminError(e);
  }
}

$('adminVehiclesRefresh').addEventListener('click', refreshAdminVehicles);
$('adminLogRefresh').addEventListener('click', refreshAdminLog);
$('adminSearch').addEventListener('click', refreshAdminUsers);
$('adminQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') refreshAdminUsers();
});
$('adminReportScope').addEventListener('change', refreshAdminReports);
$('adminReportsRefresh').addEventListener('click', refreshAdminReports);

// --- Друзья и отряд ------------------------------------------------------

// Последнее, что известно про друзей. Приходит из main и обновляется само —
// окно друзей может быть закрыто, а отряд разбору боя нужен всё равно.
let friendsState = { friends: [], incoming: [], outgoing: [], squad: [], limit: 100, signedIn: false };
// Свой логин — только чтобы подписать своё место в отряде. Обновляется вместе
// с состоянием аккаунта.
let accountLogin = null;

const PRESENCE_CLASS = { battle: 'battle', hangar: 'hangar', offline: '' };

/** Подпись под ником: «В бою · 3/1/0», «В ангаре», «Не в сети». */
function presenceText(friend) {
  if (friend.presence === 'battle' && friend.score) {
    const s = friend.score;
    return t('friends.inBattleScore', { k: s.kills, d: s.deaths, a: s.assists });
  }
  return t(`friends.presence.${friend.presence}`);
}

/** Первая буква логина — то, что показывается, пока аватарки нет. */
const initial = (login) => String(login || '?').trim().charAt(0).toUpperCase();

/**
 * Содержимое квадратика: картинка, если аватарка есть, иначе первая буква.
 *
 * Картинка идёт по своей схеме адресов, а не по http: файл скачивается один
 * раз и лежит в кэше, поэтому список друзей не ходит в сеть на каждый показ и
 * не пустеет, когда сети нет.
 */
function avatarContent(login, avatar) {
  if (!avatar) return el('span', 'avatar-letter', initial(login));
  const img = el('img', 'avatar-img');
  img.src = `sightline-avatar://${avatar}`;
  img.alt = '';
  // Файл мог не скачаться — тогда возвращаемся к букве, а не показываем
  // сломанную картинку.
  img.addEventListener('error', () => img.replaceWith(el('span', 'avatar-letter', initial(login))));
  return img;
}

function renderSquad() {
  const strip = $('squadStrip');
  strip.replaceChildren();
  // Без аккаунта отряд собрать не из кого, и пустые квадратики только
  // занимали бы место и вызывали вопросы.
  strip.hidden = !friendsState.signedIn;
  if (strip.hidden) return;

  const mine = friendsState.me || { login: accountLogin, avatar: null };
  const me = el('button', 'squad-slot self taken');
  me.append(avatarContent(mine.login || accountLogin, mine.avatar));
  me.title = t('friends.you');
  strip.append(me);

  const byLogin = new Map(friendsState.friends.map((f) => [f.login.toLowerCase(), f]));
  for (let i = 0; i < 3; i++) {
    const login = friendsState.squad[i];
    const friend = login ? byLogin.get(login.toLowerCase()) : null;

    if (!login) {
      const plus = el('button', 'squad-slot', '+');
      plus.title = t('friends.addSlot');
      plus.addEventListener('click', openFriends);
      strip.append(plus);
      continue;
    }

    const slot = el('button', 'squad-slot taken');
    slot.append(avatarContent(login, friend?.avatar));
    slot.title = friend
      ? `${login} · ${presenceText(friend)}\n${t('friends.clickToRemove')}`
      : `${login}\n${t('friends.clickToRemove')}`;
    const dot = el('span', `presence ${PRESENCE_CLASS[friend?.presence] || ''}`);
    slot.append(dot);
    slot.addEventListener('click', async () => {
      friendsState = await window.wt.friends.removeFromSquad(login);
      renderSquad();
    });
    strip.append(slot);
  }
}

function friendRow(friend, actions) {
  const row = el('div', `friend-row ${friend.presence === 'offline' ? 'offline' : ''}`);
  const face = el('span', 'friend-avatar');
  face.append(avatarContent(friend.login, friend.avatar));
  row.append(face, el('span', `friend-dot ${PRESENCE_CLASS[friend.presence] || ''}`));

  const name = el('div', 'friend-name');
  name.append(el('div', null, friend.login));
  if (friend.presence) name.append(el('div', 'friend-status', presenceText(friend)));
  // Друг, не заявивший игровой ник, в бою неузнаваем: в кил-фиде он под ником,
  // а у нас только логин. Молчать об этом нельзя — человек поставит его в
  // отряд, не увидит никакого эффекта и решит, что отряд не работает.
  if (friend.presence && !friend.game_nick) {
    name.append(el('div', 'friend-status warn', t('friends.noGameNick')));
  }
  row.append(name);

  for (const [label, handler, cls, disabled] of actions) {
    const button = el('button', `small ${cls || ''}`, label);
    // Кнопка может приехать уже погашенной: приглашение этому человеку сейчас
    // на задержке, и включать её, чтобы тут же ответить отказом, — обман.
    if (disabled) button.disabled = true;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        // Обработчику отдаём саму кнопку: отсчёт идёт на ней, а не в отдельном
        // месте — человек смотрит туда, куда только что нажал.
        await handler(button);
      } catch (e) {
        showFriendsError(e);
      } finally {
        if (!button.dataset.counting) button.disabled = false;
      }
    });
    row.append(button);
  }
  return row;
}

// --- Приглашения в отряд --------------------------------------------------

/**
 * Когда можно снова звать этого человека. Ключ — логин в нижнем регистре,
 * значение — момент времени.
 *
 * Живёт в памяти окна намеренно: это подсказка, а не правило. Правило на
 * сервере, и оно переживает перезапуск программы, а эта карта — нет.
 * Перезапуск не должен выглядеть способом обойти задержку, поэтому сервер
 * всё равно ответит отказом, и мы покажем его ответ.
 */
const inviteCooldowns = new Map();

function inviteCooldownLeft(login) {
  const until = inviteCooldowns.get(String(login).toLowerCase()) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function inviteLabel(login) {
  const left = inviteCooldownLeft(login);
  return left ? t('squad.inviteSent', { n: left }) : t('squad.invite');
}

/** Зовёт друга и ведёт обратный отсчёт прямо на кнопке. */
async function inviteToSquad(login, button) {
  let answer;
  try {
    answer = await window.wt.friends.invite(login);
  } catch (e) {
    // Задержка после отказов приходит отдельным числом секунд. Разбирать текст
    // ошибки нельзя: формулировку однажды поправят, и разбор молча перестанет
    // работать.
    if (typeof e?.retryAfter === 'number') {
      showFriendsError({
        message: t('squad.inviteCooldown', { n: Math.max(1, Math.ceil(e.retryAfter / 60)) }),
      });
      countdown(button, e.retryAfter, login);
      return;
    }
    throw e;
  }
  countdown(button, Number(answer?.cooldown) || 10, login);
}

/**
 * Гасит кнопку на n секунд и показывает, сколько осталось.
 *
 * Без отсчёта серая кнопка выглядит поломкой: человек нажал, ничего не
 * произошло, нажать снова нельзя и непонятно почему.
 */
function countdown(button, seconds, login) {
  inviteCooldowns.set(String(login).toLowerCase(), Date.now() + seconds * 1000);
  button.dataset.counting = '1';
  button.disabled = true;

  const tick = () => {
    const left = inviteCooldownLeft(login);
    if (left <= 0) {
      clearInterval(timer);
      delete button.dataset.counting;
      button.disabled = false;
      button.textContent = t('squad.invite');
      return;
    }
    button.textContent = t('squad.inviteSent', { n: left });
  };
  const timer = setInterval(tick, 500);
  tick();
}

// --- Окно приглашения -----------------------------------------------------

let inviteShown = null;
let inviteTimer = null;

/**
 * Показывает первое приглашение из очереди. Именно первое, а не все сразу:
 * два окна поверх друг друга человек закрывает не глядя.
 */
function renderInvites(invites) {
  const list = Array.isArray(invites) ? invites : [];
  const next = list[0];

  if (!next) {
    closeInvite();
    return;
  }
  if (inviteShown && inviteShown.id === next.id) return;

  inviteShown = { ...next, until: Date.now() + next.expires_in * 1000 };
  $('inviteLogin').textContent = next.from_login;
  $('inviteAvatar').replaceChildren(avatarContent(next.from_login, next.from_avatar));
  $('inviteError').hidden = true;
  $('squadInviteModal').hidden = false;

  clearInterval(inviteTimer);
  const tick = () => {
    const left = Math.max(0, Math.ceil((inviteShown.until - Date.now()) / 1000));
    $('inviteLeft').textContent = t('squad.seconds', { n: left });
    // Протухло — закрываем сами. Окно, которое нельзя ни принять, ни
    // отклонить, только злит.
    if (left <= 0) closeInvite();
  };
  inviteTimer = setInterval(tick, 500);
  tick();
}

function closeInvite() {
  clearInterval(inviteTimer);
  inviteTimer = null;
  inviteShown = null;
  $('squadInviteModal').hidden = true;
}

async function answerInvite(accept) {
  if (!inviteShown) return;
  const id = inviteShown.id;
  try {
    friendsState = accept
      ? await window.wt.friends.acceptInvite(id)
      : await window.wt.friends.declineInvite(id);
    closeInvite();
    renderFriends();
    renderSquad();
  } catch (e) {
    $('inviteError').textContent = e?.offline ? t('acc.offline') : e?.message || String(e);
    $('inviteError').hidden = false;
  }
}

$('inviteAccept').addEventListener('click', () => answerInvite(true));
$('inviteDecline').addEventListener('click', () => answerInvite(false));
window.wt.onSquadInvites(renderInvites);

function showFriendsError(error) {
  const box = $('friendsError');
  box.textContent = error?.offline ? t('acc.offline') : error?.message || String(error);
  box.hidden = false;
}

/**
 * Действие над дружбой. Список после него приходит уже обновлённым — main
 * перечитывает его сам, чтобы окно не показывало состояние, которого на
 * сервере уже нет.
 */
const afterAction = async (promise) => renderFriends(await promise);

function renderFriends(state) {
  if (state) friendsState = state;
  renderSquad();
  if ($('friendsModal').hidden) return;

  $('friendsGuest').hidden = friendsState.signedIn;
  $('friendsBody').hidden = !friendsState.signedIn;
  if (!friendsState.signedIn) return;

  if (friendsState.error) showFriendsError({ message: friendsState.error });

  const section = (titleId, bodyId, rows, titleKey) => {
    $(titleId).hidden = !rows.length;
    $(titleId).textContent = t(titleKey, { n: rows.length });
    $(bodyId).replaceChildren(...rows);
  };

  section(
    'friendsIncomingTitle',
    'friendsIncoming',
    friendsState.incoming.map((f) =>
      friendRow(f, [
        [t('friends.accept'), () => afterAction(window.wt.friends.accept(f.login))],
        [t('friends.decline'), () => afterAction(window.wt.friends.remove(f.login))],
      ])
    ),
    'friends.incoming'
  );

  section(
    'friendsOutgoingTitle',
    'friendsOutgoing',
    friendsState.outgoing.map((f) =>
      friendRow(f, [[t('friends.cancel'), () => afterAction(window.wt.friends.remove(f.login))]])
    ),
    'friends.outgoing'
  );

  $('friendsListTitle').textContent = t('friends.list', {
    n: friendsState.friends.length,
    limit: friendsState.limit,
  });

  const inSquad = new Set(friendsState.squad.map((l) => l.toLowerCase()));
  const full = friendsState.squad.length >= 3;
  $('friendsList').replaceChildren(
    ...(friendsState.friends.length
      ? friendsState.friends.map((f) => {
          const actions = [];
          if (inSquad.has(f.login.toLowerCase())) {
            actions.push([
              t('friends.leaveSquad'),
              async () => {
                friendsState = await window.wt.friends.removeFromSquad(f.login);
                renderFriends();
              },
            ]);
          } else if (!full) {
            // Именно «Пригласить», а не «В отряд»: программа больше не
            // добавляет человека молча, она его зовёт. Слово должно совпадать
            // с тем, что произойдёт, иначе оно врёт.
            actions.push([
              inviteLabel(f.login),
              (button) => inviteToSquad(f.login, button),
              '',
              inviteCooldownLeft(f.login) > 0,
            ]);
          }
          actions.push([
            t('friends.remove'),
            () => afterAction(window.wt.friends.remove(f.login)),
            'danger',
          ]);
          return friendRow(f, actions);
        })
      : [el('div', 'empty', t('friends.none'))])
  );
}

// --- Своя аватарка -------------------------------------------------------

function renderMyAvatar() {
  const mine = friendsState.me || { login: accountLogin, avatar: null };
  const login = mine.login || accountLogin;
  // Две картинки: крупная в карточке и обычная рядом с кнопками замены.
  // Один и тот же узел в двух местах показать нельзя — DOM его переносит.
  $('accAvatar').replaceChildren(avatarContent(login, mine.avatar));
  $('accAvatarEdit').replaceChildren(avatarContent(login, mine.avatar));
  $('avatarRemove').disabled = !mine.avatar;
}

/**
 * Плитки профиля: бои, победы, КДА и серия за последние 30 дней.
 *
 * Считается по местной истории. Серверных публичных профилей ещё нет, и
 * подписывать эти цифры «так вас видят другие» было бы обещанием того, чего
 * пока не существует, — поэтому под плитками стоит честная оговорка.
 */
async function renderProfileStats() {
  const МЕСЯЦ = 30 * 24 * 60 * 60 * 1000;
  const box = $('accStats');
  try {
    const [{ summary }, streaks] = await Promise.all([
      // limit: 1 — сами бои не нужны, нужна только сводка по ним.
      window.wt.db.searchBattles({ from: Date.now() - МЕСЯЦ, limit: 1 }),
      window.wt.db.streaks({ from: Date.now() - МЕСЯЦ }),
    ]);

    // Главное число — бои за месяц. Крупно и отдельно: остальные три отвечают
    // на вопрос «как», это отвечает на вопрос «сколько», и смешивать их в один
    // ряд значит терять и то, и другое.
    const hero = el('div', 'profile-hero-value', fmtInt(summary.battles));
    $('accHero').replaceChildren(
      hero,
      el(
        'div',
        'profile-hero-label',
        // Через словарь форм, а не строкой: «1 боёв за месяц» уже чинили
        // однажды в подписях графиков, второй раз наступать не будем.
        t('acc.stat.battlesPeriod', {
          word: window.i18n.plural(summary.battles, 'plural.battles'),
        })
      )
    );

    const плитки = [
      {
        value: summary.percent === null ? t('acc.stat.none') : `${summary.percent}%`,
        label: t('acc.stat.winrate'),
        tone: summary.percent === null ? '' : summary.percent >= 50 ? 'good' : 'bad',
      },
      { value: summary.battles ? summary.kda.toFixed(2) : t('acc.stat.none'), label: t('acc.stat.kda') },
      // Лучшая серия побед, а не текущая серия поражений. Показывать человеку
      // его худшее — сомнительная услуга; профиль смотрят, чтобы порадоваться,
      // а не чтобы расстроиться.
      {
        value: streaks.bestWin ? fmtInt(streaks.bestWin) : t('acc.stat.none'),
        label: t('acc.stat.bestWin'),
        tone: streaks.bestWin ? 'good' : '',
      },
    ];

    box.replaceChildren(...плитки.map((п) => {
      const tile = el('div', 'profile-stat');
      const value = el('div', `profile-stat-value${п.tone ? ' ' + п.tone : ''}`, п.value);
      tile.append(value, el('div', 'profile-stat-label', п.label));
      return tile;
    }));
  } catch {
    // Профиль без цифр лучше, чем раздел аккаунта, который не открылся из-за
    // сбоя в базе: войти и сменить пароль человек должен мочь всегда.
    box.replaceChildren();
    $('accHero').replaceChildren();
  }
}


/** Обёртка над действиями с аватаркой: одна кнопка, одно место для ошибки. */
async function avatarAction(button, run) {
  $('avatarError').hidden = true;
  button.disabled = true;
  try {
    await run();
    renderFriends(await window.wt.friends.state());
    renderMyAvatar();
  } catch (e) {
    $('avatarError').textContent = e?.offline ? t('acc.offline') : e?.message || String(e);
    $('avatarError').hidden = false;
  } finally {
    button.disabled = false;
    renderMyAvatar();
  }
}

$('avatarChoose').addEventListener('click', (e) =>
  avatarAction(e.currentTarget, () => window.wt.account.chooseAvatar())
);
$('avatarRemove').addEventListener('click', (e) =>
  avatarAction(e.currentTarget, () => window.wt.account.removeAvatar())
);

async function openFriends() {
  $('friendsModal').hidden = false;
  $('friendsError').hidden = true;
  $('friendSearch').value = '';
  $('friendSearchResults').replaceChildren();
  renderFriends(await window.wt.friends.refresh());
}

$('friendsClose').addEventListener('click', () => {
  $('friendsModal').hidden = true;
});

// Поиск с задержкой: печатать быстрее, чем ходит запрос, — обычное дело, а
// каждый нажатый символ отдельным обращением к серверу не нужен никому.
let friendSearchTimer = null;
$('friendSearch').addEventListener('input', (e) => {
  const query = e.target.value.trim();
  clearTimeout(friendSearchTimer);
  if (query.length < 3) {
    $('friendSearchResults').replaceChildren();
    return;
  }
  friendSearchTimer = setTimeout(async () => {
    try {
      const found = await window.wt.friends.search(query);
      $('friendSearchResults').replaceChildren(
        ...(found.length
          ? found.map((p) => {
              const row = friendRow(
                { login: p.login, presence: null },
                p.relation === 'none'
                  ? [[t('friends.add'), () => afterAction(window.wt.friends.request(p.login))]]
                  : []
              );
              // Уже друг, уже позвали, это я сам — кнопки нет, но сказать,
              // почему её нет, надо: иначе выглядит как неработающий поиск.
              if (p.relation !== 'none') {
                row.append(el('span', 'friend-status', t(`friends.relation.${p.relation}`)));
              }
              return row;
            })
          : [el('div', 'empty', t('friends.notFound'))])
      );
    } catch (err) {
      showFriendsError(err);
    }
  }, 300);
});

window.wt.onFriendsUpdate((state) => renderFriends(state));

// --- Версия программы ----------------------------------------------------

/**
 * Показывает или прячет блокирующее окно «программа устарела».
 *
 * Проверка идёт при запуске и повторяется после каждого обращения к серверу:
 * минимум могли поднять, пока окно висело открытым сутками.
 *
 * Недоступный сервер устареванием НЕ считается. Разбор кил-фида, история боёв
 * и графики работают без сети вообще, и выключать их из-за пропавшего
 * интернета было бы издевательством — в этом случае недоступен только аккаунт.
 */
/**
 * Какую версию человек уже попросил не напоминать.
 *
 * В памяти окна, а не в настройках: «позже» значит «не сейчас», а не «никогда
 * больше». Перезапуск программы — как раз тот момент, когда напомнить уместно.
 */
let updateDismissed = null;

function applyVersion(version) {
  const outdated = version && version.ok === false;
  $('outdatedModal').hidden = !outdated;
  if (outdated) {
    // Сборка не годится вовсе — полоса про мягкое обновление тут лишняя, поверх
    // неё уже висит окно, которое нельзя закрыть.
    $('updateBar').hidden = true;
    $('outdatedVersions').textContent = t('update.versions', {
      mine: version.appVersion || '—',
      min: version.minClient || '—',
    });
    return;
  }

  const надо = !!version?.updateAvailable && version.latestClient !== updateDismissed;
  $('updateBar').hidden = !надо;
  if (!надо) return;

  $('updateTitle').textContent = t('update.available', { version: version.latestClient });
  // Что человек получит, обновившись. Приходит с сервера: старая сборка не
  // может знать, что появилось после неё. Голое «есть обновление» не отвечает
  // на единственный вопрос, который у человека возникает, — а зачем мне это
  // сейчас, — и потому его закрывают не читая.
  $('updateNotes').textContent = version.latestNotes || t('update.nothingToSay');
}

$('updateGo').addEventListener('click', () => window.wt.account.openDownload());
$('updateLater').addEventListener('click', async () => {
  const version = await window.wt.account.state();
  updateDismissed = version?.version?.latestClient || null;
  $('updateBar').hidden = true;
});

async function checkVersion() {
  try {
    applyVersion(await window.wt.account.checkVersion());
  } catch {
    // Проверка не прошла — значит сервера сейчас нет. Молчим: местная часть
    // программы от этого не зависит.
  }
}

// Редактор — отдельное окно. Карточка это то, что человек пришёл посмотреть, и
// формы смены пароля под ней превращали её в предисловие к анкете.
function closeProfileEditor() {
  $('profileEditModal').hidden = true;
}

$('profileEdit').addEventListener('click', () => {
  $('profileEditModal').hidden = false;
  // Шапка редактора повторяет карточку: человек должен видеть, что правит
  // именно то, на что только что смотрел.
  $('editorLogin').textContent = $('accLogin').textContent;
  $('editorRole').textContent = $('accRole').textContent;
  renderMyAvatar();
  // Поля паролей каждый раз пустые: оставлять введённое в закрытом окне —
  // способ однажды сменить пароль случайно.
  for (const id of ['cpOld', 'cpNew', 'cpNew2']) $(id).value = '';
  $('cpError').hidden = true;
  $('avatarError').hidden = true;
  $('laError').hidden = true;
});

$('profileEditClose').addEventListener('click', closeProfileEditor);
// Клик по затемнению закрывает — как у остальных окон.
$('profileEditModal').addEventListener('click', (e) => {
  if (e.target === $('profileEditModal')) closeProfileEditor();
});

// --- Пароль сброшен администратором ---------------------------------------

function openForcedPassword(login) {
  $('fpLogin').value = login || '';
  for (const id of ['fpCode', 'fpNew', 'fpNew2']) $(id).value = '';
  $('fpError').hidden = true;
  $('forcedPasswordModal').hidden = false;
  $('fpCode').focus();
}

$('fpSubmit').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const пароль = $('fpNew').value;
  if (пароль.length < 8) {
    return showAuthError('fpError', { message: t('acc.passwordHint') });
  }
  if (пароль !== $('fpNew2').value) {
    return showAuthError('fpError', { message: t('acc.mismatch') });
  }

  setBusy(button, true);
  try {
    const { recoveryCode } = await window.wt.account.forcedPassword({
      login: $('fpLogin').value.trim(),
      recoveryCode: $('fpCode').value,
      newPassword: пароль,
    });
    $('forcedPasswordModal').hidden = true;
    // Новый код показывается тем же окном, что и при регистрации: он такой же
    // единственный ключ, и закрыть окно, не подтвердив сохранение, нельзя.
    showRecoveryCode(recoveryCode);
    await refreshAccount();
  } catch (err) {
    showAuthError('fpError', err);
  } finally {
    setBusy(button, false);
  }
});

$('outdatedDownload').addEventListener('click', () => window.wt.account.openDownload());
$('outdatedRetry').addEventListener('click', checkVersion);

/**
 * «Гость» или «Вошли как X» в шапке.
 *
 * Отдельной функцией, потому что состояние аккаунта меняется в трёх местах:
 * вход, выход и проверка при запуске. Показывать это только во вкладке
 * «Аккаунт» бесполезно — туда и заходят раз в месяц, а вопрос «идёт ли
 * синхронизация» возникает не там.
 */
function renderWhoAmI(state) {
  const кнопка = $('whoAmI');
  const вошли = !!state?.signedIn;
  кнопка.textContent = вошли ? t('who.signedIn', { login: state.login }) : t('who.guest');
  кнопка.classList.toggle('guest', !вошли);
}

// Нажатие ведёт в «Аккаунт»: там и вход, и выход. Тем же способом, что и
// внешняя команда открыть вкладку, — щелчком по самой кнопке раздела.
$('whoAmI').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="account"]')?.click();
});

async function refreshAccount() {
  const state = await window.wt.account.state();
  renderWhoAmI(state);
  applyVersion(state.version);
  accountLogin = state.login;
  // Раздел администратора показывается по роли из сессии. Роль приезжает с
  // сервера при входе; если права выдали позже, надо перезайти.
  $('tabAdmin').hidden = !state.isAdmin;
  renderSquad();
  renderMyAvatar();
  if (state.signedIn) {
    $('accLogin').textContent = state.login;
    $('accRole').textContent = t(state.isAdmin ? 'acc.role.admin' : 'acc.role.user');
    // Форма редактирования каждый раз закрыта: раздел открывают, чтобы
    // посмотреть на себя, а не чтобы сменить пароль.
    closeProfileEditor();
    renderProfileStats();
    showAuthScreen('authSignedIn');
  } else {
    showAuthScreen('authGuest');
  }
  return state;
}

/**
 * Показывает ошибку запроса. Отсутствие сети отделено от отказа сервера:
 * «нет связи» — это не «неверный пароль», и человек должен понимать, что
 * ему делать, а не гадать.
 */
function showAuthError(boxId, error) {
  const box = $(boxId);
  box.textContent = error?.offline ? t('acc.offline') : error?.message || String(error);
  box.hidden = false;
}

/** Блокирует форму на время запроса: два нажатия подряд — два аккаунта. */
function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.label = button.dataset.label || button.textContent;
  button.textContent = busy ? t('acc.working') : button.dataset.label;
}

// Проверка от ботов занимает несколько секунд настоящих вычислений. Без
// отчёта о ходе работы это выглядит как зависшая программа, и человек нажмёт
// кнопку ещё раз или закроет окно.
window.wt.onProofProgress((tried) => {
  const button = $('regSubmit');
  if (!button.disabled) return;
  button.textContent = t('acc.proof', { n: Math.round(tried / 1000) });
});

$('authShowSignIn').addEventListener('click', () => showAuthScreen('authSignIn'));
$('authShowRegister').addEventListener('click', () => {
  if (!$('regNick').value) $('regNick').value = $('nick').value || '';
  showAuthScreen('authRegister');
});
for (const back of document.querySelectorAll('.auth-back')) {
  back.addEventListener('click', () => showAuthScreen('authGuest'));
}

$('authSignIn').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('siSubmit');
  setBusy(button, true);
  try {
    await window.wt.account.signIn({
      login: $('siLogin').value.trim(),
      password: $('siPassword').value,
    });
    $('siPassword').value = '';
    await refreshAccount();
  } catch (err) {
    // Пароль сброшен администратором. Это единственный момент, когда человеку
    // можно об этом сказать: сессии закрыты, уведомления ему недоступны, и без
    // этой ветки он бесконечно пробовал бы свой старый пароль.
    if (err?.code === 'password_reset_required') {
      openForcedPassword($('siLogin').value.trim());
      return;
    }
    showAuthError('siError', err);
  } finally {
    setBusy(button, false);
  }
});

// Кнопка регистрации оживает только вместе с галочкой согласия: без согласия
// обрабатывать персональные данные нельзя, а логин с паролем — уже они.
const updateRegisterButton = () => {
  $('regSubmit').disabled = !$('regConsent').checked;
};
$('regConsent').addEventListener('change', updateRegisterButton);

$('authRegister').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('regPassword').value;
  if (password !== $('regPassword2').value) {
    showAuthError('regError', { message: t('acc.mismatch') });
    return;
  }

  const button = $('regSubmit');
  setBusy(button, true);
  try {
    const result = await window.wt.account.register({
      login: $('regLogin').value.trim(),
      password,
      lang: window.i18n.lang(),
      acceptTerms: $('regConsent').checked,
    });
    $('regPassword').value = '';
    $('regPassword2').value = '';

    // Ник из формы сразу уезжает в настройки: человек всё равно должен был бы
    // вписать его вручную, иначе программа не отличит его в бою от остальных.
    // Спросить один раз при регистрации дешевле, чем оставить его гадать,
    // почему таблица не подсвечивает его строку.
    const nick = $('regNick').value.trim();
    if (nick) {
      await window.wt.setNick(nick);
      $('nick').value = nick;
    }

    await refreshAccount();
    showRecoveryCode(result.recoveryCode);
  } catch (err) {
    showAuthError('regError', err);
  } finally {
    setBusy(button, false);
  }
});

$('authSignOut').addEventListener('click', async () => {
  await window.wt.account.signOut();
  await refreshAccount();
});

// Смена пароля. Новый код восстановления показывается тем же окном, что и при
// регистрации: старый после смены пароля перестаёт работать, и человек должен
// узнать об этом не тогда, когда попробует им воспользоваться.
$('authPassword').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPassword = $('cpNew').value;
  if (newPassword !== $('cpNew2').value) {
    showAuthError('cpError', { message: t('acc.mismatch') });
    return;
  }

  const button = $('cpSubmit');
  setBusy(button, true);
  $('cpError').hidden = true;
  try {
    const result = await window.wt.account.changePassword({
      oldPassword: $('cpOld').value,
      newPassword,
    });
    $('cpOld').value = '';
    $('cpNew').value = '';
    $('cpNew2').value = '';
    await refreshAccount();
    showRecoveryCode(result.recoveryCode);
  } catch (err) {
    showAuthError('cpError', err);
  } finally {
    setBusy(button, false);
  }
});

// Выход со всех устройств закрывает и эту сессию тоже — поэтому подтверждение
// отдельным окном: нажатие мимо кнопки не должно заканчиваться повторным
// вводом пароля на всех машинах сразу.
$('authLogoutAll').addEventListener('click', () => {
  $('laError').hidden = true;
  $('logoutAllModal').hidden = false;
});

$('logoutAllCancel').addEventListener('click', () => {
  $('logoutAllModal').hidden = true;
});

$('logoutAllGo').addEventListener('click', async () => {
  const button = $('logoutAllGo');
  setBusy(button, true);
  try {
    await window.wt.account.logoutAll();
    $('logoutAllModal').hidden = true;
    await refreshAccount();
  } catch (err) {
    // Сервер не ответил — сессии на других машинах остались живыми, и молча
    // выйти здесь значило бы соврать, что просьба выполнена.
    $('logoutAllModal').hidden = true;
    showAuthError('laError', err);
  } finally {
    setBusy(button, false);
  }
});

// --- Код восстановления --------------------------------------------------

function showRecoveryCode(code) {
  $('codeValue').textContent = code;
  $('codeStatus').textContent = '';
  $('codeConfirm').checked = false;
  $('codeClose').disabled = true;
  $('codeModal').hidden = false;
}

$('codeConfirm').addEventListener('change', (e) => {
  $('codeClose').disabled = !e.target.checked;
});

$('codeCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('codeValue').textContent);
  $('codeStatus').textContent = t('code.copied');
});

$('codeSave').addEventListener('click', async () => {
  const file = await window.wt.account.saveRecoveryCode($('codeValue').textContent);
  if (file) $('codeStatus').textContent = t('code.saved', { file });
});

$('codeClose').addEventListener('click', () => {
  $('codeModal').hidden = true;
  // Код стираем из разметки сразу: он больше нигде не хранится, и оставлять
  // его висеть в закрытом окне незачем.
  $('codeValue').textContent = '';
});

for (const [id, page] of [['linkTerms', 'terms'], ['linkPrivacy', 'privacy']]) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    window.wt.openExternal(page);
  });
}

// --- Инструкция и «О программе» -----------------------------------------

// Разделы инструкции по порядку. Каждый — пара ключей .title и .text в
// словаре; абзацы внутри текста разделены переводом строки.
const HELP_SECTIONS = [
  'start',
  'status',
  'who',
  'table',
  'icons',
  'stats',
  'history',
  'size',
  'window',
  'tray',
  'data',
  'problems',
];

// Какой раздел открывать по кнопке «?» с той или иной вкладки.
const HELP_FOR_TAB = {
  battle: 'table',
  counters: 'stats',
  battles: 'history',
  players: 'history',
  mine: 'stats',
  settings: 'tray',
};

function renderHelp() {
  const body = $('helpBody');
  body.replaceChildren();
  for (const id of HELP_SECTIONS) {
    const section = el('section', 'help-section');
    section.id = `help-${id}`;
    section.append(el('h2', null, t(`help.${id}.title`)));
    // Каждая строка словаря — отдельный абзац: сплошной текст в инструкции
    // читать тяжело, а ради этого её и пишем.
    for (const line of t(`help.${id}.text`).split('\n')) {
      if (line.trim()) section.append(el('p', null, line));
    }
    body.append(section);
  }
}

function openHelp(sectionId) {
  document.querySelector('.tab[data-tab="help"]').click();
  const target = sectionId && $(`help-${sectionId}`);
  if (target) target.scrollIntoView({ block: 'start' });
  else document.querySelector('main').scrollTop = 0;
}

$('helpBtn').addEventListener('click', () => {
  const current = document.querySelector('.tab.active')?.dataset.tab;
  openHelp(HELP_FOR_TAB[current]);
});

async function renderAbout() {
  const about = await window.wt.about();
  const facts = $('aboutFacts');
  facts.replaceChildren();

  const rows = [
    ['about.version', about.version],
    ['about.license', about.license],
    ['about.runtime', `Electron ${about.electron} · Node ${about.node}`],
    ['about.dataFile', about.dbFile],
  ];
  for (const [key, value] of rows) {
    if (!value) continue;
    facts.append(el('dt', null, t(key)), el('dd', null, String(value)));
  }

  // Исходный код — последней строкой и ссылкой, а не текстом. Программа читает
  // игровой API и шлёт данные на сервер; первый вопрос всегда «а что оно
  // отправляет», и на него лучше отвечать ссылкой, чем словами.
  if (about.repo) {
    const link = el('a', null, about.repo);
    link.href = '#';
    link.title = t('about.sourceOpen');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.wt.openExternal('repo');
    });
    const dd = el('dd');
    dd.append(link);
    facts.append(el('dt', null, t('about.source')), dd);
  }
}

// --- Карточка игрока ----------------------------------------------------

let cardNick = null;

async function openCard(nick) {
  cardNick = nick;
  $('cardNick').textContent = nick;
  $('cardSummary').textContent = t('card.loading');
  $('cardBody').replaceChildren();
  // Форма жалобы каждый раз закрыта и пуста: открытая настежь она
  // подталкивает жаловаться, а это не то, к чему стоит подталкивать.
  $('cardReport').open = false;
  $('cardReportText').value = '';
  $('cardReportError').hidden = true;
  // Без аккаунта жалоба невозможна: разбирать «кто-то на кого-то» нельзя.
  $('cardReport').hidden = !accountLogin;
  $('cardModal').hidden = false;

  const [card, dossier] = await Promise.all([
    window.wt.db.playerCard(nick),
    window.wt.db.dossier([nick]),
  ]);
  const d = dossier[nick];
  $('cardNote').value = d?.note || '';

  if (!card) {
    $('cardSummary').textContent = t('card.notFound');
    return;
  }

  const asAlly = card.encounters.filter((e) => e.team === 'ally').length;
  const asEnemy = card.encounters.filter((e) => e.team === 'enemy').length;
  $('cardSummary').textContent =
    t('card.summary', { total: card.encounters.length, ally: asAlly, enemy: asEnemy }) +
    (d ? t('card.summaryDuel', { killedMe: d.killedMe, killedByMe: d.killedByMe }) : '');

  const table = el('table');
  table.innerHTML = headRow(['col.when', 'col.team', 'col.kda', 'col.vehicles']);
  const tbody = el('tbody');
  for (const e of card.encounters.slice(0, 50)) {
    const tr = el('tr');
    const kda = el('td');
    kda.append(kdaBadge(e.kills, e.deaths, e.assists));
    tr.append(
      el('td', null, dateText(e.started_at)),
      el(
        'td',
        `nick ${e.team}`,
        e.team === 'ally' ? t('card.teamAlly') : e.team === 'enemy' ? t('card.teamEnemy') : '—'
      ),
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
  $('dbStats').textContent = t('settings.dbStats', { battles: s.battles, players: s.players, mb });
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

// Галочки поведения окна и трея — все однотипные, поэтому вешаем один
// обработчик и не плодим четыре одинаковых.
const WINDOW_FLAGS = ['closeToTray', 'launchWithSystem', 'showOnGameStart', 'hideOnGameExit'];
for (const name of WINDOW_FLAGS) {
  $(name).addEventListener('change', (e) => window.wt.setWindowFlag(name, e.target.checked));
}

async function refreshWindowFlags() {
  const flags = await window.wt.windowFlags();
  for (const name of WINDOW_FLAGS) $(name).checked = !!flags[name];
}

// Пункт «Настройки» в меню трея открывает именно эту вкладку.
window.wt.onOpenTab((tab) => {
  const button = document.querySelector(`.tab[data-tab="${tab}"]`);
  if (button) button.click();
});

$('uiScale').addEventListener('change', async (e) => {
  await window.wt.setUiScale(e.target.value);
  // Масштаб меняет ширину карточек в CSS-пикселях, а размеры графика зашиты
  // в момент отрисовки — без пересборки подписи разъедутся с картинкой.
  if ($('panel-counters').classList.contains('active')) refreshCharts();
});
$('reveal').addEventListener('click', () => window.wt.db.reveal());
$('resetBattleBtn').addEventListener('click', () => window.wt.resetBattle());

// --- Подтверждение опасных действий -------------------------------------

let confirmAction = null;

function askConfirm({ title, text, word = t('confirm.word'), action }) {
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
    title: t('confirm.clearHistory.title'),
    text: t('confirm.clearHistory.text'),
    action: async () => {
      await window.wt.db.clearHistory({ keepPlayers: true });
      refreshDbStats();
      refreshCounters();
    },
  })
);

$('clearPlayers').addEventListener('click', () =>
  askConfirm({
    title: t('confirm.clearPlayers.title'),
    text: t('confirm.clearPlayers.text'),
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
  refreshVehicleFilter().then(() => refreshBattles());
  refreshDbStats();
});
// Запросы к main рассыпаны по всему файлу, и оборачивать каждый в try/catch
// значило бы засыпать код одинаковыми блоками. Ловим отказы одной точкой:
// упавший запрос теперь виден в строке состояния, а не превращает вкладку в
// молча замершую.
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  const message = e.reason?.message || String(e.reason);
  // Electron приписывает к сообщению служебный префикс канала — он нужен в
  // логе, но не человеку.
  showError(message.replace(/^Error invoking remote method '[^']+':\s*/, ''));
});

function showError(message) {
  const box = $('statusText');
  box.textContent = message;
  box.classList.add('error');
  clearTimeout(showError.timer);
  // Через полминуты строка вернётся к обычному состоянию: постоянно висящая
  // старая ошибка мешает видеть, что происходит сейчас.
  showError.timer = setTimeout(() => box.classList.remove('error'), 30000);
}

window.wt.onError(showError);

// Настройки приехали из учётной записи: значения уже применены в main, окну
// осталось показать их. Перерисовываем ровно то, что от них зависит, — целиком
// вкладку настроек, а при смене языка ещё и весь интерфейс.
window.wt.onSettingsChanged(async ({ keys = [], locale } = {}) => {
  if (keys.includes('uiLang') && locale) {
    applyLocale(locale);
    rerenderAll();
  }
  const state = await window.wt.getState();
  if (keys.includes('selfNick')) $('nick').value = state.selfNick || '';
  if (state.uiScale) $('uiScale').value = String(state.uiScale);
  $('onTop').checked = !!state.alwaysOnTop;
  refreshWindowFlags();
});

/**
 * Раскладывает язык по интерфейсу: словарь в i18n, статические подписи в
 * разметку, список языков в настройки. Каждый язык назван на самом себе —
 * человек, открывший программу на незнакомом языке, всё равно найдёт свой.
 */
function applyLocale(locale) {
  window.i18n.setLocale(locale);
  window.i18n.apply();
  // Подпись у замка рисуется псевдоэлементом, а он читает только атрибут —
  // перевести его иначе нечем.
  document.querySelector('#privacyToggle .lock')?.setAttribute('data-soon', t('acc.soon'));

  const select = $('uiLang');
  if (locale.languages) {
    select.replaceChildren();
    for (const l of locale.languages) {
      const option = el('option', null, l.name);
      option.value = l.code;
      select.append(option);
    }
  }
  select.value = locale.lang;
}

/** Перерисовывает то, что построено из строк, а не из разметки. */
function rerenderAll() {
  if (lastState) renderBattle(lastState);
  refreshCounters();
  refreshDbStats();
  const active = document.querySelector('.panel.active')?.id;
  if (active === 'panel-battles') refreshVehicleFilter().then(() => refreshBattles());
  if (active === 'panel-players') refreshPlayers();
  if (active === 'panel-mine') refreshMine();
  if (active === 'panel-help') renderHelp();
  if (active === 'panel-about') renderAbout();
}

$('uiLang').addEventListener('change', async (e) => {
  applyLocale(await window.wt.setLang(e.target.value));
  rerenderAll();
});

window.wt.getState().then((state) => {
  // Язык раскладываем до первой отрисовки, иначе на долю секунды мелькнут
  // ключи словаря вместо текста.
  applyLocale(state);
  $('onTop').checked = !!state.alwaysOnTop;
  if (state.uiScale) $('uiScale').value = String(state.uiScale);
  renderBattle(state);
  refreshCounters();
  refreshDbStats();
  // Спрашиваем сервер о версии сразу при запуске, а не при первом заходе во
  // вкладку аккаунта: устаревшая сборка не должна успеть показать человеку
  // хоть что-то, чему нельзя верить.
  checkVersion();
  // Отряд рисуем сразу: он в шапке и виден с первого экрана, а не только
  // после захода во вкладку аккаунта.
  refreshAccount().then(() => window.wt.friends.state().then(renderFriends));
});

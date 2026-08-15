'use strict';

// Графики рисуются инлайновым SVG, без сторонних библиотек. Chart.js весит
// четверть мегабайта и требует ослабить CSP (script-src 'self'), а нам нужны
// четыре простых картинки. Здесь только отрисовка: данные считает база.
//
// Всё завёрнуто в функцию: обычные <script> делят одну глобальную область, и
// любое имя, совпавшее с именем из app.js, уронило бы весь файл целиком.
// Наружу торчит только window.charts.
(function () {

const SVG_NS = 'http://www.w3.org/2000/svg';

// Подписи и подсказки берутся из словаря — см. i18n.js.
const t = (key, params) => window.i18n.t(key, params);

function svgEl(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Холст, который тянется по ширине карточки и сохраняет пропорции. */
function canvas(width, height, cls = '') {
  // width/height заданы явно: без них svg растягивается на всю ширину блока и
  // масштабирует viewBox вместе с текстом. Здесь размер уже посчитан в
  // настоящих пикселях, поэтому масштаб должен остаться 1:1.
  return svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    preserveAspectRatio: 'xMidYMid meet',
    class: `chart ${cls}`.trim(),
    role: 'img',
  });
}

/** Подсказка при наведении — встроенный <title>, без своих всплывашек. */
function withTitle(node, text) {
  node.append(svgEl('title', {}, text));
  return node;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** '2026-08-15' → Date по местному времени (без сдвига на UTC). */
function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const dayKey = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const kdaOf = (r) => (r.deaths > 0 ? (r.kills + r.assists) / r.deaths : r.kills + r.assists);

// --- Активность по часам -------------------------------------------------

/**
 * 24 столбика: высота — число боёв, заливка разбита на победы, поражения и
 * бои без исхода. Так один график отвечает сразу на два вопроса: когда играю
 * и когда выигрываю.
 */
function hoursChart(hours, { width = 720 } = {}) {
  const W = Math.max(320, width);
  const H = 200;
  const bottom = 32; // место под подписи часов
  const top = 14;
  const plot = H - bottom - top;
  const step = W / 24;
  const barW = step - 6;

  const svg = canvas(W, H, 'chart-hours');
  const max = Math.max(1, ...hours.map((h) => h.battles));

  // Горизонтальные направляющие: без них высоту столбика не с чем сравнить.
  for (const frac of [0.5, 1]) {
    const y = top + plot - plot * frac;
    svg.append(svgEl('line', { x1: 0, y1: y, x2: W, y2: y, class: 'grid' }));
    svg.append(svgEl('text', { x: 2, y: y - 3, class: 'axis' }, String(Math.round(max * frac))));
  }

  hours.forEach((h, i) => {
    const x = i * step + 3;
    if (h.battles > 0) {
      const total = plot * (h.battles / max);
      let y = top + plot;
      // Снизу вверх: победы, поражения, неопознанные.
      for (const [key, cls] of [['wins', 'win'], ['losses', 'loss'], ['unknown', 'unknown']]) {
        const value = key === 'unknown' ? h.battles - h.wins - h.losses : h[key];
        if (value <= 0) continue;
        const height = total * (value / h.battles);
        y -= height;
        svg.append(svgEl('rect', { x, y, width: barW, height, class: `bar ${cls}` }));
      }
    }

    // Прозрачная накладка на всю высоту — чтобы подсказка ловилась и на
    // пустом часе, а не только по самому столбику.
    const wr = h.wins + h.losses ? Math.round((h.wins / (h.wins + h.losses)) * 100) : null;
    svg.append(
      withTitle(
        svgEl('rect', { x, y: top, width: barW, height: plot, class: 'hit' }),
        `${t('chart.hourRange', { h: pad2(h.hour) })}\n` +
          t('chart.battles', { n: h.battles }) +
          (h.battles ? `\n${t('chart.winLoss', { wins: h.wins, losses: h.losses })}` : '') +
          (wr === null ? '' : `\n${t('chart.winrate', { n: wr })}`) +
          (h.battles ? `\n${t('chart.kda', { n: kdaOf(h).toFixed(2) })}` : '')
      )
    );

    // На узкой карточке 24 подписи сливаются — оставляем каждую шестую.
    const every = step < 34 ? 6 : 3;
    if (h.hour % every === 0) {
      svg.append(
        svgEl('text', { x: x + barW / 2, y: H - 8, class: 'axis mid' }, `${pad2(h.hour)}`)
      );
    }
  });

  return svg;
}

/**
 * Лучший и худший час по винрейту. Часы с парой боёв в расчёт не идут: на
 * двух боях «100% побед» — это не закономерность, а совпадение.
 */
function bestHours(hours, minBattles = 5) {
  const decided = hours
    .map((h) => ({ ...h, played: h.wins + h.losses }))
    .filter((h) => h.played >= minBattles)
    .map((h) => ({ hour: h.hour, played: h.played, wr: h.wins / h.played }));
  if (decided.length < 2) return null;

  const sorted = [...decided].sort((a, b) => b.wr - a.wr);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

// --- Календарь активности («травка») -------------------------------------

/**
 * Квадратик на день, как на GitHub. Насыщенность — по числу боёв.
 * @param {Array} days - строки dailyStats
 * @param {object} [opts]
 * @param {number} [opts.weeks] - сколько недель показывать
 */
function grassChart(days, { weeks = 26, width = 720 } = {}) {
  const GAP = 3;
  const LEFT = 34; // подписи дней недели
  const TOP = 22; // подписи месяцев
  // Клетка подгоняется под ширину карточки: полгода должны помещаться целиком,
  // но клетка меньше восьми пикселей уже не наводится мышью.
  const CELL = Math.max(8, Math.min(16, (Math.max(320, width) - LEFT) / weeks - GAP));
  const W = LEFT + weeks * (CELL + GAP);
  const H = TOP + 7 * (CELL + GAP);

  const byDay = new Map(days.map((d) => [d.day, d]));

  // Сетка заканчивается сегодняшней неделей и идёт с понедельника.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + ((7 - ((end.getDay() + 6) % 7)) % 7)); // до воскресенья
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));

  const svg = canvas(W, H, 'chart-grass');
  // Месяцы и дни недели — строкой через запятую в словаре: так их правит
  // переводчик, а не программист.
  const MONTHS = window.i18n.list('chart.months');
  const WEEKDAYS = window.i18n.list('chart.weekdays');

  WEEKDAYS.forEach((label, row) => {
    if (!label) return;
    svg.append(
      svgEl('text', { x: 0, y: TOP + row * (CELL + GAP) + CELL - 1, class: 'axis' }, label)
    );
  });

  let lastMonth = -1;
  const cursor = new Date(start);
  for (let week = 0; week < weeks; week++) {
    for (let row = 0; row < 7; row++) {
      const x = LEFT + week * (CELL + GAP);
      const y = TOP + row * (CELL + GAP);

      if (row === 0 && cursor.getMonth() !== lastMonth) {
        lastMonth = cursor.getMonth();
        svg.append(svgEl('text', { x, y: 12, class: 'axis' }, MONTHS[lastMonth]));
      }

      const key = dayKey(cursor);
      const d = byDay.get(key);
      const future = cursor > today;
      // Пять ступеней вместо непрерывной шкалы: глазом всё равно различимо
      // не больше четырёх-пяти уровней.
      const level = !d ? 0 : d.battles >= 10 ? 4 : d.battles >= 6 ? 3 : d.battles >= 3 ? 2 : 1;

      const cell = svgEl('rect', {
        x,
        y,
        width: CELL,
        height: CELL,
        rx: 2,
        class: `cell level-${level}${future ? ' future' : ''}`,
      });
      const date = `${pad2(cursor.getDate())}.${pad2(cursor.getMonth() + 1)}`;
      svg.append(
        withTitle(
          cell,
          d
            ? t('chart.dayFull', {
                date,
                battles: d.battles,
                wins: d.wins,
                kda: kdaOf(d).toFixed(2),
              })
            : t(future ? 'chart.dayFuture' : 'chart.dayEmpty', { date })
        )
      );
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return svg;
}

// --- КДА и винрейт по дням -----------------------------------------------

/**
 * Скользящее окно в N дней. Считается не среднее из дневных КДА, а КДА за
 * окно целиком: день с одним боем не должен весить столько же, сколько день
 * с двадцатью.
 */
function rolling(days, window = 7) {
  const out = [];
  for (let i = 0; i < days.length; i++) {
    const from = parseDay(days[i].day);
    from.setDate(from.getDate() - (window - 1));

    let kills = 0;
    let deaths = 0;
    let assists = 0;
    let wins = 0;
    let losses = 0;
    for (let j = i; j >= 0; j--) {
      if (parseDay(days[j].day) < from) break;
      kills += days[j].kills;
      deaths += days[j].deaths;
      assists += days[j].assists;
      wins += days[j].wins;
      losses += days[j].losses;
    }
    out.push({
      day: days[i].day,
      kda: deaths > 0 ? (kills + assists) / deaths : kills + assists,
      winrate: wins + losses ? wins / (wins + losses) : null,
    });
  }
  return out;
}

/**
 * Две линии на одном поле: КДА по левой оси, винрейт по правой. Обе —
 * скользящим средним за неделю; сырой дневной КДА показан точками, чтобы
 * было видно разброс, из которого линия и получена.
 */
function trendChart(days, { window = 7, width = 720 } = {}) {
  const W = Math.max(320, width);
  const H = 230;
  const left = 42;
  const right = 50;
  const top = 14;
  const bottom = 30;
  const plotW = W - left - right;
  const plotH = H - top - bottom;

  const svg = canvas(W, H, 'chart-trend');
  if (days.length < 2) return svg;

  const smooth = rolling(days, window);
  const first = parseDay(days[0].day).getTime();
  const last = parseDay(days[days.length - 1].day).getTime();
  const span = Math.max(1, last - first);

  const x = (day) => left + plotW * ((parseDay(day).getTime() - first) / span);
  // Шкалу задаёт сглаженная линия, а не сырые точки: один вечер без смертей
  // даёт КДА под двадцать и придавил бы весь график к нулю. Верхние 10%
  // выбросов прижимаются к потолку — они здесь фон, а не сюжет.
  const sortedRaw = days.map(kdaOf).sort((a, b) => a - b);
  const p90 = sortedRaw[Math.floor(sortedRaw.length * 0.9)] || 1;
  const maxKda = Math.max(1, Math.max(...smooth.map((s) => s.kda)) * 1.25, p90);
  const yKda = (v) => top + plotH - plotH * Math.min(1, v / maxKda);
  const yWr = (v) => top + plotH - plotH * v;

  // Сетка и обе шкалы: слева КДА, справа проценты.
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const y = top + plotH - plotH * frac;
    svg.append(svgEl('line', { x1: left, y1: y, x2: W - right, y2: y, class: 'grid' }));
    svg.append(
      svgEl('text', { x: left - 4, y: y + 3, class: 'axis end kda' }, (maxKda * frac).toFixed(1))
    );
    svg.append(
      svgEl('text', { x: W - right + 4, y: y + 3, class: 'axis wr' }, `${Math.round(frac * 100)}%`)
    );
  }

  // Сырые дневные значения — фоном под линией.
  for (const d of days) {
    svg.append(
      withTitle(
        svgEl('circle', { cx: x(d.day), cy: yKda(kdaOf(d)), r: 1.8, class: 'dot' }),
        t('chart.dayPoint', { date: d.day, battles: d.battles, kda: kdaOf(d).toFixed(2) })
      )
    );
  }

  const path = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');

  svg.append(
    svgEl('path', {
      d: path(smooth.map((s) => [x(s.day), yKda(s.kda)])),
      class: 'line kda',
    })
  );

  // Винрейт рвётся там, где за всё окно не было ни одного распознанного
  // исхода: соединять такие куски прямой значило бы придумать данные.
  let segment = [];
  for (const s of smooth) {
    if (s.winrate === null) {
      if (segment.length > 1) svg.append(svgEl('path', { d: path(segment), class: 'line wr' }));
      segment = [];
      continue;
    }
    segment.push([x(s.day), yWr(s.winrate)]);
  }
  if (segment.length > 1) svg.append(svgEl('path', { d: path(segment), class: 'line wr' }));

  const dateLabel = (day) => {
    const d = parseDay(day);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  };
  svg.append(svgEl('text', { x: left, y: H - 6, class: 'axis' }, dateLabel(days[0].day)));
  svg.append(
    svgEl(
      'text',
      { x: W - right, y: H - 6, class: 'axis end' },
      dateLabel(days[days.length - 1].day)
    )
  );

  return svg;
}

// --- Полоска серий -------------------------------------------------------

/** Последние бои слева направо: зелёный — победа, красный — поражение. */
function streakStrip(recent, { width = 720 } = {}) {
  const GAP = 3;
  const n = Math.max(1, recent.length);
  const CELL = Math.max(5, Math.min(14, Math.max(320, width) / n - GAP));
  const H = 26;
  const W = n * (CELL + GAP);

  const svg = canvas(W, H, 'chart-streak');
  recent.forEach((b, i) => {
    const cls = b.result === 'win' ? 'win' : b.result === 'loss' ? 'loss' : 'unknown';
    svg.append(
      withTitle(
        svgEl(
          'rect',
          { x: i * (CELL + GAP), y: 4, width: CELL, height: 18, rx: 2, class: `pip ${cls}` }
        ),
        t(
          b.result === 'win'
            ? 'chart.pipWin'
            : b.result === 'loss'
              ? 'chart.pipLoss'
              : 'chart.pipUnknown'
        )
      )
    );
  });
  return svg;
}

window.charts = { hoursChart, bestHours, grassChart, trendChart, streakStrip, rolling };

})();

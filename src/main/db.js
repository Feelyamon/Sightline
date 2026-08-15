'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./migrations');

// SQLite встроен в Node внутри Electron — нативных модулей и пересборки под ABI
// не требуется, в собранный .exe база едет сама.

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS battles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,          -- unix ms, время начала записи боя
  ended_at    INTEGER NOT NULL,
  duration    INTEGER NOT NULL,          -- секунды по часам кил-фида
  my_kills    INTEGER NOT NULL DEFAULT 0,
  my_deaths   INTEGER NOT NULL DEFAULT 0,
  my_assists  INTEGER NOT NULL DEFAULT 0,
  my_vehicles TEXT    NOT NULL DEFAULT '[]',
  players_seen INTEGER NOT NULL DEFAULT 0,
  result      TEXT    NOT NULL DEFAULT 'unknown', -- win | loss | unknown
  -- Сдвиг местного времени от UTC в минутах на момент боя (Москва = 180).
  -- started_at всегда в UTC; сдвиг нужен, чтобы «в какие часы я играю»
  -- считалось по местному времени игрока и на сервере, где системного
  -- часового пояса игрока уже нет. NULL — у записей, сделанных до появления
  -- колонки: неизвестно, а не «ноль».
  tz_offset   INTEGER,
  -- Бой с заведомо неполными данными. В статистику не идёт вообще: ни в
  -- счётчики, ни в винрейт, ни в топы игроков. Показывается только в списке
  -- боёв, с пометкой и без КДА.
  cancelled     INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_battles_started ON battles(started_at);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nick       TEXT NOT NULL UNIQUE,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS battle_players (
  battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team      TEXT    NOT NULL,            -- ally | enemy | unknown
  kills     INTEGER NOT NULL DEFAULT 0,
  deaths    INTEGER NOT NULL DEFAULT 0,
  assists   INTEGER NOT NULL DEFAULT 0,
  vehicles  TEXT    NOT NULL DEFAULT '[]',
  left_battle INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (battle_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_bp_player ON battle_players(player_id);

-- Счётчики хранят не число боёв, а момент обнуления: сами числа считаются
-- запросом. Поэтому «сбросить» — это одна строка UPDATE, а удаление истории
-- обнуляет все счётчики автоматически.
-- reset_id — «водяной знак»: id последнего боя на момент сброса. Считать по
-- времени нельзя: бой, записанный в ту же миллисекунду, что и сброс, попадал
-- бы в счёт или нет случайно. reset_at остаётся только для показа «с такого-то».
CREATE TABLE IF NOT EXISTS counters (
  name     TEXT PRIMARY KEY,
  reset_at INTEGER NOT NULL,
  reset_id INTEGER NOT NULL DEFAULT 0
);
`;

// Счётчики боёв в шапке статистики. Новое имя достаточно дописать сюда:
// строка в таблице заводится при старте, а окно считает windowStart().
const COUNTERS = ['session', 'today', 'week', 'month', 'year'];

/** Экранирует спецсимволы LIKE, чтобы ник вроде «100%_pro» искался буквально. */
const escapeLike = (s) => String(s || '').replace(/[\\%_]/g, (c) => `\\${c}`);

// Потолок на список совпадений в поиске: у SQLite ограничено число параметров
// в запросе. Упереться в него можно только запросом из одной буквы по большой
// базе — а такой запрос и так возвращает «почти всё».
const MAX_MATCHES = 5000;

/** Начало суток/недели/месяца по локальному времени. */
function windowStart(name, now = Date.now()) {
  const d = new Date(now);
  switch (name) {
    case 'today':
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    case 'week': {
      d.setHours(0, 0, 0, 0);
      const shift = (d.getDay() + 6) % 7; // неделя с понедельника
      d.setDate(d.getDate() - shift);
      return d.getTime();
    }
    case 'month':
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      return d.getTime();
    // Календарный год, а не «последние 365 дней»: «в этом году» люди понимают
    // как «с января», и в январе такой период честно окажется коротким.
    case 'year':
      d.setHours(0, 0, 0, 0);
      d.setMonth(0, 1);
      return d.getTime();
    default:
      return 0; // session — только по ручному сбросу
  }
}

class Db {
  constructor(userDataDir, { file = 'battles.db' } = {}) {
    this.file = path.join(userDataDir, file);
    fs.mkdirSync(userDataDir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);

    // Вылеты и дуэли появились позже — без них не построить статистику по
    // своей технике и досье на противника.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sorties (
        battle_id  INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        vehicle    TEXT    NOT NULL,
        kills      INTEGER NOT NULL DEFAULT 0,
        destroyed  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (battle_id, player_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_sorties_vehicle ON sorties(vehicle);
      -- Фильтр «мои бои на этой машине» ходит по паре игрок+техника.
      CREATE INDEX IF NOT EXISTS idx_sorties_player_vehicle ON sorties(player_id, vehicle);

      CREATE TABLE IF NOT EXISTS duels (
        battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        killer_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        victim_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        count     INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (battle_id, killer_id, victim_id)
      );
      CREATE INDEX IF NOT EXISTS idx_duels_victim ON duels(victim_id);

      -- Награды за бой: игра пишет их в кил-фид, поэтому они собираются
      -- по каждому игроку и сохраняются вместе с боем.
      -- tier — степень награды, отделённая от названия («Снайпер II» →
      -- «Снайпер», 2). 0 означает «награда без степеней».
      CREATE TABLE IF NOT EXISTS awards (
        battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        name      TEXT    NOT NULL,
        count     INTEGER NOT NULL DEFAULT 1,
        tier      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (battle_id, player_id, name)
      );

      -- Ручные пометки на игрока: всплывают при следующей встрече.
      CREATE TABLE IF NOT EXISTS player_notes (
        player_id  INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        note       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Схема доводится до актуальной версии до первого запроса к данным.
    // Бэкап делается только если есть что применять — см. migrations.js.
    this.migration = migrate(this.db, { backup: () => this.backup() });

    const now = Date.now();
    const ins = this.db.prepare(
      'INSERT INTO counters(name, reset_at, reset_id) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING'
    );
    for (const name of COUNTERS) ins.run(name, now);
  }

  lastBattleId() {
    return this.db.prepare('SELECT COALESCE(MAX(id), 0) id FROM battles').get().id;
  }

  /**
   * id игрока по нику из настроек. В базе ник лежит с клан-тегом
   * («[CLAN] Username»), а пользователь вводит его без тега — поэтому ищем
   * и точное совпадение, и хвост строки.
   * @returns {number|null}
   */
  selfId(nick) {
    const self = String(nick || '').trim();
    if (!self) return null;
    const row = this.db
      .prepare("SELECT id FROM players WHERE nick = ? OR nick LIKE ? ESCAPE '\\' LIMIT 1")
      .get(self, `% ${escapeLike(self)}`);
    return row?.id ?? null;
  }

  /**
   * Обнуляет счётчик «с запуска». Вызывается приложением явно: делать это в
   * конструкторе нельзя — тогда любое открытие файла (скриптом, утилитой)
   * сбрасывало бы счётчик пользователя.
   */
  startSession() {
    this.resetCounter('session');
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Закрываемся при выходе — падать тут незачем.
    }
  }

  /**
   * Пишет завершённый бой. Возвращает id или null, если писать нечего.
   * @param {object} snapshot - снапшот BattleState
   */
  saveBattle(snapshot, { startedAt, endedAt, result = 'unknown', cancelReason = null } = {}) {
    const players = snapshot.players || [];
    if (!players.length) return null;

    const now = Date.now();
    const start = startedAt || now;
    const end = endedAt || now;
    const me = players.find((p) => p.isSelf);

    const tx = () => {
      const battleId = this.db
        .prepare(
          `INSERT INTO battles (started_at, ended_at, duration, my_kills, my_deaths, my_assists, my_vehicles, players_seen, result, tz_offset, cancelled, cancel_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          start,
          end,
          snapshot.clock || 0,
          me ? me.kills : 0,
          me ? me.deaths : 0,
          me ? me.assists || 0 : 0,
          JSON.stringify(me ? me.vehicles : []),
          players.length,
          result,
          // getTimezoneOffset() возвращает «сколько минут прибавить к местному,
          // чтобы получить UTC» — знак обратный привычному. Москва даёт -180,
          // а человек ожидает +180, поэтому переворачиваем здесь, один раз.
          -new Date(start).getTimezoneOffset(),
          cancelReason ? 1 : 0,
          cancelReason
        ).lastInsertRowid;

      const upsertPlayer = this.db.prepare(
        `INSERT INTO players (nick, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(nick) DO UPDATE SET last_seen = excluded.last_seen`
      );
      const findPlayer = this.db.prepare('SELECT id FROM players WHERE nick = ?');
      const insBp = this.db.prepare(
        `INSERT INTO battle_players (battle_id, player_id, team, kills, deaths, assists, vehicles, left_battle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const insSortie = this.db.prepare(
        `INSERT INTO sorties (battle_id, player_id, seq, vehicle, kills, destroyed)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insDuel = this.db.prepare(
        `INSERT INTO duels (battle_id, killer_id, victim_id, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(battle_id, killer_id, victim_id) DO UPDATE SET count = count + excluded.count`
      );
      const insAward = this.db.prepare(
        `INSERT INTO awards (battle_id, player_id, name, count, tier) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(battle_id, player_id, name) DO UPDATE SET
           count = excluded.count,
           tier  = MAX(tier, excluded.tier)`
      );
      const ids = new Map();

      for (const p of players) {
        upsertPlayer.run(p.nick, start, end);
        const { id } = findPlayer.get(p.nick);
        ids.set(p.nick, id);

        // Вылеты — основа статистики «моя техника» и «что выкатывают против».
        (p.sorties || []).forEach((s, seq) => {
          if (!s.vehicle) return;
          insSortie.run(battleId, id, seq, s.vehicle, s.kills || 0, s.destroyed ? 1 : 0);
        });

        for (const a of p.awards || []) {
          insAward.run(battleId, id, a.name, a.count || 1, a.tier || 0);
        }

        insBp.run(
          battleId,
          id,
          p.team,
          p.kills,
          p.deaths,
          p.assists || 0,
          JSON.stringify(p.vehicles || []),
          p.status === 'left' ? 1 : 0
        );
      }

      // Личные счёты: без них не показать «против тебя 8/3».
      for (const d of snapshot.duels || []) {
        const killerId = ids.get(d.killer);
        const victimId = ids.get(d.victim);
        if (killerId && victimId) insDuel.run(battleId, killerId, victimId, d.count);
      }

      return battleId;
    };

    this.db.exec('BEGIN');
    try {
      const id = tx();
      this.db.exec('COMMIT');
      return id;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Перезаписывает уже сохранённый бой. Нужен, чтобы один бой оставался одной
   * записью: раньше повторные сохранения вставляли его заново, и статистика
   * росла в разы.
   */
  updateBattle(id, snapshot, opts = {}) {
    // Запись могли удалить из-под нас (очистка истории, удаление боя вручную) —
    // тогда просто пишем бой заново.
    const exists = this.db.prepare('SELECT 1 FROM battles WHERE id = ?').get(id);
    if (!exists) return this.saveBattle(snapshot, opts);

    this.db.exec('BEGIN');
    try {
      // Дочерние строки проще пересобрать, чем сверять по одной.
      this.db.prepare('DELETE FROM battle_players WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM sorties WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM duels WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM awards WHERE battle_id = ?').run(id);
      this.db.prepare('DELETE FROM battles WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.saveBattle(snapshot, opts);
  }

  /** Четыре счётчика: сколько боёв попало в окно с момента последнего сброса. */
  counters() {
    const rows = this.db.prepare('SELECT name, reset_at, reset_id FROM counters').all();
    const resets = Object.fromEntries(rows.map((r) => [r.name, r]));
    const count = this.db.prepare(
      'SELECT COUNT(*) n FROM battles WHERE id > ? AND started_at >= ? AND cancelled = 0'
    );

    const out = {};
    for (const name of COUNTERS) {
      const r = resets[name] || { reset_at: 0, reset_id: 0 };
      // Две независимые границы: номер боя на момент ручного сброса и начало
      // календарного окна (для today/week/month).
      const from = Math.max(r.reset_at || 0, windowStart(name));
      out[name] = { battles: count.get(r.reset_id || 0, windowStart(name)).n, from };
    }
    return out;
  }

  resetCounter(name) {
    if (!COUNTERS.includes(name)) throw new Error(`Неизвестный счётчик: ${name}`);
    this.db
      .prepare('UPDATE counters SET reset_at = ?, reset_id = ? WHERE name = ?')
      .run(Date.now(), this.lastBattleId(), name);
  }

  /**
   * Условие отбора боёв — общее для выдачи строк и для итогов по ним.
   * Собирается динамически, но значения всегда идут плейсхолдерами: склеивать
   * пользовательский ввод в SQL нельзя даже в локальной базе.
   * @returns {{sql: string, params: Array}}
   */
  battleFilter({ query = '', from = 0, to = 0, result = '', myVehicle = '', selfNick = '' } = {}) {
    const where = [];
    const params = [];

    if (from) {
      where.push('b.started_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('b.started_at <= ?');
      params.push(to);
    }
    if (result) {
      where.push('b.result = ?');
      params.push(result);
    }

    // Одна строка поиска на ник и на технику: человек ищет «кого-то или
    // что-то», а не выбирает заранее, по какому полю искать.
    //
    // Совпадение ищем в JS, а не через LIKE. LIKE в SQLite приводит регистр
    // только для латиницы, а у нас кириллические ники и названия техники из
    // русского клиента: «т-80» не нашло бы «Т-80БВМ». Сканируем справочники
    // (игроки и список машин — тысячи строк, не сотни тысяч), а по боям идём
    // уже готовым списком id.
    const q = String(query || '').trim();
    if (q) {
      // toLowerCase, а не toLocaleLowerCase: последний зависит от языка
      // системы. В турецкой локали «I» превращается в «ı» без точки, и
      // турецкий игрок, ищущий «isu», не нашёл бы «ISU» в своей же базе.
      // Здесь нужна предсказуемость, а не языковая правильность.
      const needle = q.toLowerCase();
      const matches = (s) => String(s || '').toLowerCase().includes(needle);

      const playerIds = this.db
        .prepare('SELECT id, nick FROM players')
        .all()
        .filter((p) => matches(p.nick))
        .map((p) => p.id)
        .slice(0, MAX_MATCHES);
      const vehicles = this.db
        .prepare('SELECT DISTINCT vehicle FROM sorties')
        .all()
        .map((r) => r.vehicle)
        .filter(matches)
        .slice(0, MAX_MATCHES);

      const parts = [];
      if (playerIds.length) {
        parts.push(
          `EXISTS (SELECT 1 FROM battle_players bp WHERE bp.battle_id = b.id
                   AND bp.player_id IN (${playerIds.map(() => '?').join(',')}))`
        );
        params.push(...playerIds);
      }
      if (vehicles.length) {
        parts.push(
          `EXISTS (SELECT 1 FROM sorties s WHERE s.battle_id = b.id
                   AND s.vehicle IN (${vehicles.map(() => '?').join(',')}))`
        );
        params.push(...vehicles);
      }
      // Ни одного совпадения в справочниках — искать в боях нечего.
      where.push(parts.length ? `(${parts.join(' OR ')})` : '0 = 1');
    }

    if (myVehicle) {
      const me = this.selfId(selfNick);
      if (me === null) {
        // Ник не задан или ещё не встречался — «моих боёв» на этой машине нет.
        where.push('0 = 1');
      } else {
        where.push(
          `EXISTS (SELECT 1 FROM sorties s
                   WHERE s.battle_id = b.id AND s.player_id = ? AND s.vehicle = ?)`
        );
        params.push(me, myVehicle);
      }
    }

    return { sql: where.length ? where.join(' AND ') : '1 = 1', params };
  }

  /**
   * Бои с фильтрами и постраничной выдачей. Итоги (винрейт, КДА) считаются по
   * той же выборке, что и строки: иначе фильтр показывал бы одно, а сводка над
   * ним — статистику по всей базе.
   * @returns {{rows: Array, total: number, summary: object}}
   */
  searchBattles(opts = {}) {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 5000));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const { sql, params } = this.battleFilter(opts);

    const rows = this.db
      .prepare(
        `SELECT id, started_at, duration, my_kills, my_deaths, my_assists, my_vehicles,
                players_seen, result, cancelled, cancel_reason
         FROM battles b
         WHERE ${sql}
         ORDER BY started_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map((b) => ({ ...b, my_vehicles: JSON.parse(b.my_vehicles || '[]') }));

    // total считается по всей выдаче — от него зависит постраничная загрузка.
    // А суммы и винрейт — только по незачёркнутым боям: отменённый бой в
    // списке видно, но в цифры он не входит.
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN b.cancelled = 1 THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN b.cancelled = 0 AND b.result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN b.cancelled = 0 AND b.result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(CASE WHEN b.cancelled = 0 THEN b.my_kills   ELSE 0 END), 0) AS kills,
                COALESCE(SUM(CASE WHEN b.cancelled = 0 THEN b.my_deaths  ELSE 0 END), 0) AS deaths,
                COALESCE(SUM(CASE WHEN b.cancelled = 0 THEN b.my_assists ELSE 0 END), 0) AS assists
         FROM battles b WHERE ${sql}`
      )
      .get(...params);

    const total = agg.total || 0;
    const cancelled = agg.cancelled || 0;
    const counted = total - cancelled;
    const wins = agg.wins || 0;
    const losses = agg.losses || 0;
    const decided = wins + losses;

    return {
      rows,
      total,
      summary: {
        battles: counted,
        cancelled,
        wins,
        losses,
        unknown: counted - decided,
        percent: decided ? Math.round((wins / decided) * 100) : null,
        kills: agg.kills,
        deaths: agg.deaths,
        assists: agg.assists,
        // Тот же расчёт, что в плашке КДА: без смертей делить не на что.
        kda: agg.deaths > 0 ? (agg.kills + agg.assists) / agg.deaths : agg.kills + agg.assists,
      },
    };
  }

  /** Последние бои без фильтров. */
  recentBattles(limit = 50) {
    return this.searchBattles({ limit }).rows;
  }

  /** Состав одного боя — для раскрывающейся строки во вкладке «Бои». */
  battleDetails(id) {
    const battle = this.db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
    if (!battle) return null;
    const players = this.db
      .prepare(
        `SELECT p.nick, bp.team, bp.kills, bp.deaths, bp.assists, bp.vehicles, bp.left_battle
         FROM battle_players bp JOIN players p ON p.id = bp.player_id
         WHERE bp.battle_id = ?
         ORDER BY bp.kills DESC, bp.deaths ASC`
      )
      .all(id)
      .map((r) => ({ ...r, vehicles: JSON.parse(r.vehicles || '[]') }));

    // Награды подкладываем к своим игрокам, чтобы их было видно в составе боя.
    const awards = this.db
      .prepare(
        `SELECT p.nick, a.name, a.count, a.tier FROM awards a
         JOIN players p ON p.id = a.player_id WHERE a.battle_id = ?`
      )
      .all(id);
    for (const p of players) {
      p.awards = awards
        .filter((a) => a.nick === p.nick)
        .map((a) => ({ name: a.name, count: a.count, tier: a.tier }));
    }

    return {
      ...battle,
      my_vehicles: JSON.parse(battle.my_vehicles || '[]'),
      players,
    };
  }

  deleteBattle(id) {
    this.db.prepare('DELETE FROM battles WHERE id = ?').run(id);
  }

  /**
   * Топ игроков. side='ally' — с кем чаще играю, 'enemy' — против кого.
   * since — граница окна (например, месяц), minBattles — порог показа.
   */
  topPlayers({ side = 'enemy', since = 0, minBattles = 1, limit = 50, excludeNick = '' } = {}) {
    // Себя в топах показывать незачем — в своей же команде игрок встречается
    // в каждом бою. В кил-фиде ник идёт с клан-тегом, поэтому отсекаем и
    // точное совпадение, и вариант «<тег> <ник>».
    const self = String(excludeNick || '').trim();
    const escaped = escapeLike(self);
    return this.db
      .prepare(
        `SELECT p.nick,
                COUNT(*) AS battles,
                SUM(bp.kills)   AS kills,
                SUM(bp.deaths)  AS deaths,
                SUM(bp.assists) AS assists,
                MAX(b.started_at) AS last_seen
         FROM battle_players bp
         JOIN players p ON p.id = bp.player_id
         JOIN battles b ON b.id = bp.battle_id
         WHERE bp.team = ? AND b.started_at >= ? AND b.cancelled = 0
           AND (? = '' OR (p.nick <> ? AND p.nick NOT LIKE ? ESCAPE '\\'))
         GROUP BY p.id
         HAVING battles >= ?
         ORDER BY battles DESC, last_seen DESC
         LIMIT ?`
      )
      .all(side, since, self, self, `% ${escaped}`, minBattles, limit);
  }

  /** Вся история встреч с конкретным игроком. */
  playerCard(nick) {
    const player = this.db.prepare('SELECT * FROM players WHERE nick = ?').get(nick);
    if (!player) return null;
    const rows = this.db
      .prepare(
        `SELECT b.id, b.started_at, bp.team, bp.kills, bp.deaths, bp.assists, bp.vehicles
         FROM battle_players bp JOIN battles b ON b.id = bp.battle_id
         WHERE bp.player_id = ? AND b.cancelled = 0 ORDER BY b.started_at DESC LIMIT 200`
      )
      .all(player.id)
      .map((r) => ({ ...r, vehicles: JSON.parse(r.vehicles || '[]') }));
    return { ...player, encounters: rows };
  }

  /**
   * Досье на игроков для показа прямо в бою: сколько раз встречались, какая
   * техника у него обычно, личный счёт против меня и ручная пометка.
   * Берём пачкой на весь бой — по запросу на игрока было бы расточительно.
   */
  dossier(nicks, selfNick = '') {
    const list = (nicks || []).filter(Boolean);
    if (!list.length) return {};

    const holes = list.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT p.id, p.nick, COUNT(*) AS battles, MAX(b.started_at) AS last_seen
         FROM battle_players bp
         JOIN players p ON p.id = bp.player_id
         JOIN battles b ON b.id = bp.battle_id
         WHERE p.nick IN (${holes}) AND b.cancelled = 0
         GROUP BY p.id`
      )
      .all(...list);
    if (!rows.length) return {};

    const byId = new Map(rows.map((r) => [r.id, r]));
    const idHoles = [...byId.keys()].map(() => '?').join(',');
    const idList = [...byId.keys()];

    // Любимая техника — та, на которой игрока видели в наибольшем числе вылетов.
    const favourites = this.db
      .prepare(
        `SELECT player_id, vehicle, COUNT(*) AS n, SUM(kills) AS kills
         FROM sorties WHERE player_id IN (${idHoles})
         GROUP BY player_id, vehicle ORDER BY n DESC`
      )
      .all(...idList);

    const me = this.selfId(selfNick);

    let duelRows = [];
    if (me !== null) {
      duelRows = this.db
        .prepare(
          `SELECT killer_id, victim_id, SUM(count) AS n FROM duels
           WHERE (killer_id = ? AND victim_id IN (${idHoles}))
              OR (victim_id = ? AND killer_id IN (${idHoles}))
           GROUP BY killer_id, victim_id`
        )
        .all(me, ...idList, me, ...idList);
    }

    const notes = this.db
      .prepare(`SELECT player_id, note FROM player_notes WHERE player_id IN (${idHoles})`)
      .all(...idList);

    const out = {};
    for (const r of rows) {
      const fav = favourites.filter((f) => f.player_id === r.id).slice(0, 3);
      const killedMe = duelRows
        .filter((d) => d.killer_id === r.id && d.victim_id === me)
        .reduce((s, d) => s + d.n, 0);
      const killedByMe = duelRows
        .filter((d) => d.victim_id === r.id && d.killer_id === me)
        .reduce((s, d) => s + d.n, 0);
      out[r.nick] = {
        battles: r.battles,
        lastSeen: r.last_seen,
        favourite: fav.map((f) => ({ vehicle: f.vehicle, sorties: f.n, kills: f.kills })),
        killedMe,
        killedByMe,
        note: notes.find((n) => n.player_id === r.id)?.note || '',
      };
    }
    return out;
  }

  /** Статистика по своей технике: вылеты, фраги, потери, винрейт. */
  myVehicles(selfNick = '', { since = 0 } = {}) {
    const me = this.selfId(selfNick);
    if (me === null) return [];

    return this.db
      .prepare(
        `SELECT s.vehicle,
                COUNT(*)             AS sorties,
                SUM(s.kills)         AS kills,
                SUM(s.destroyed)     AS losses,
                COUNT(DISTINCT s.battle_id) AS battles,
                SUM(CASE WHEN b.result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN b.result = 'loss' THEN 1 ELSE 0 END) AS losses_battles,
                MAX(b.started_at)    AS last_used
         FROM sorties s JOIN battles b ON b.id = s.battle_id
         WHERE s.player_id = ? AND b.started_at >= ? AND b.cancelled = 0
         GROUP BY s.vehicle
         ORDER BY sorties DESC`
      )
      .all(me, since);
  }

  /** Что чаще всего выкатывают против меня — к чему готовиться. */
  enemyVehicles({ since = 0, limit = 25 } = {}) {
    return this.db
      .prepare(
        `SELECT s.vehicle, COUNT(*) AS sorties, SUM(s.kills) AS kills,
                COUNT(DISTINCT s.player_id) AS players
         FROM sorties s
         JOIN battle_players bp
           ON bp.battle_id = s.battle_id AND bp.player_id = s.player_id
         JOIN battles b ON b.id = s.battle_id
         WHERE bp.team = 'enemy' AND b.started_at >= ? AND b.cancelled = 0
         GROUP BY s.vehicle
         ORDER BY sorties DESC
         LIMIT ?`
      )
      .all(since, limit);
  }

  /**
   * Бои по часам суток — «когда я вообще играю» и в какие часы выигрываю.
   * Час берётся по местному времени: интересует режим дня игрока, а не UTC.
   * Возвращает ровно 24 строки, включая пустые часы — иначе на графике
   * ночные провалы схлопывались бы, и сутки читались бы неправильно.
   */
  activityByHour({ from = 0, to = 0 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                COUNT(*) AS battles,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(my_kills), 0)   AS kills,
                COALESCE(SUM(my_deaths), 0)  AS deaths,
                COALESCE(SUM(my_assists), 0) AS assists
         FROM battles
         WHERE started_at >= ? AND (? = 0 OR started_at <= ?) AND cancelled = 0
         GROUP BY hour`
      )
      .all(from, to, to);

    const byHour = new Map(rows.map((r) => [r.hour, r]));
    return Array.from({ length: 24 }, (_, hour) => {
      const r = byHour.get(hour);
      return r || { hour, battles: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0 };
    });
  }

  /**
   * Сводка по дням — основа и для линий «КДА/винрейт по дням», и для
   * календаря активности. Дни без боёв не возвращаются: их дорисовывает
   * тот, кто строит сетку.
   */
  dailyStats({ from = 0, to = 0 } = {}) {
    return this.db
      .prepare(
        `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS battles,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(my_kills), 0)   AS kills,
                COALESCE(SUM(my_deaths), 0)  AS deaths,
                COALESCE(SUM(my_assists), 0) AS assists
         FROM battles
         WHERE started_at >= ? AND (? = 0 OR started_at <= ?) AND cancelled = 0
         GROUP BY day
         ORDER BY day`
      )
      .all(from, to, to);
  }

  /**
   * Серии побед и поражений. Бои с нераспознанным исходом серию не рвут и не
   * продолжают — их просто нет в расчёте: иначе один неопознанный бой посреди
   * вечера обнулял бы честную серию из десяти побед.
   * @param {object} [opts]
   * @param {number} [opts.recent] - сколько последних боёв вернуть полоской.
   */
  streaks({ recent = 50 } = {}) {
    const all = this.db
      .prepare('SELECT id, started_at, result FROM battles WHERE cancelled = 0 ORDER BY started_at, id')
      .all();

    let current = { type: 'none', length: 0 };
    let bestWin = 0;
    let worstLoss = 0;

    for (const b of all) {
      if (b.result !== 'win' && b.result !== 'loss') continue;
      if (current.type === b.result) current.length += 1;
      else current = { type: b.result, length: 1 };

      if (current.type === 'win') bestWin = Math.max(bestWin, current.length);
      else worstLoss = Math.max(worstLoss, current.length);
    }

    return {
      current,
      bestWin,
      worstLoss,
      // Полоска рисуется слева направо по времени, поэтому хвост, а не голова.
      recent: all.slice(-Math.max(1, recent)).map((b) => ({ id: b.id, result: b.result })),
    };
  }

  /** Винрейт за период. Бои без распознанного исхода не искажают числа. */
  winrate({ since = 0 } = {}) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
         FROM battles WHERE started_at >= ? AND cancelled = 0`
      )
      .get(since);
    const decided = (r.wins || 0) + (r.losses || 0);
    return {
      total: r.total || 0,
      wins: r.wins || 0,
      losses: r.losses || 0,
      unknown: (r.total || 0) - decided,
      percent: decided ? Math.round((r.wins / decided) * 100) : null,
    };
  }

  setNote(nick, note) {
    const p = this.db.prepare('SELECT id FROM players WHERE nick = ?').get(nick);
    if (!p) return false;
    const text = String(note || '').trim();
    if (!text) {
      this.db.prepare('DELETE FROM player_notes WHERE player_id = ?').run(p.id);
      return true;
    }
    this.db
      .prepare(
        `INSERT INTO player_notes (player_id, note, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
      )
      .run(p.id, text, Date.now());
    return true;
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    const battles = one('SELECT COUNT(*) n FROM battles').n;
    const players = one('SELECT COUNT(*) n FROM players').n;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      // База может быть ещё не сброшена на диск — не страшно.
    }
    return { battles, players, sizeBytes: size, file: this.file };
  }

  /** Копия файла рядом с базой — делается перед любым разрушительным сбросом. */
  backup() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${this.file}.${stamp}.bak`;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(this.file, target);
    return target;
  }

  /** Удаляет историю боёв. Игроки остаются, если keepPlayers. */
  clearHistory({ keepPlayers = true } = {}) {
    const backup = this.backup();
    this.db.exec('DELETE FROM battle_players');
    this.db.exec('DELETE FROM battles');
    if (!keepPlayers) this.db.exec('DELETE FROM players');
    // Боёв больше нет — водяные знаки возвращаем в ноль.
    const now = Date.now();
    const upd = this.db.prepare('UPDATE counters SET reset_at = ?, reset_id = 0 WHERE name = ?');
    for (const name of COUNTERS) upd.run(now, name);
    this.db.exec('VACUUM');
    return backup;
  }

  clearPlayers() {
    const backup = this.backup();
    this.db.exec('DELETE FROM battle_players');
    this.db.exec('DELETE FROM players');
    this.db.exec('VACUUM');
    return backup;
  }
}

module.exports = { Db, COUNTERS, windowStart };

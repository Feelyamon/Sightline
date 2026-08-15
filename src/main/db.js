'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
  my_vehicles TEXT    NOT NULL DEFAULT '[]',
  players_seen INTEGER NOT NULL DEFAULT 0,
  result      TEXT    NOT NULL DEFAULT 'unknown'  -- win | loss | unknown
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

const COUNTERS = ['session', 'today', 'week', 'month'];

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

    // Базы, созданные раньше нужных колонок, донастраиваем на месте.
    const hasColumn = (table, name) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);

    if (!hasColumn('counters', 'reset_id')) {
      this.db.exec('ALTER TABLE counters ADD COLUMN reset_id INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn('battle_players', 'assists')) {
      this.db.exec('ALTER TABLE battle_players ADD COLUMN assists INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn('battles', 'result')) {
      this.db.exec("ALTER TABLE battles ADD COLUMN result TEXT NOT NULL DEFAULT 'unknown'");
    }

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
      CREATE TABLE IF NOT EXISTS awards (
        battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        name      TEXT    NOT NULL,
        count     INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (battle_id, player_id, name)
      );

      -- Ручные пометки на игрока: всплывают при следующей встрече.
      CREATE TABLE IF NOT EXISTS player_notes (
        player_id  INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        note       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

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
  saveBattle(snapshot, { startedAt, endedAt, result = 'unknown' } = {}) {
    const players = snapshot.players || [];
    if (!players.length) return null;

    const now = Date.now();
    const start = startedAt || now;
    const end = endedAt || now;
    const me = players.find((p) => p.isSelf);

    const tx = () => {
      const battleId = this.db
        .prepare(
          `INSERT INTO battles (started_at, ended_at, duration, my_kills, my_deaths, my_vehicles, players_seen, result)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          start,
          end,
          snapshot.clock || 0,
          me ? me.kills : 0,
          me ? me.deaths : 0,
          JSON.stringify(me ? me.vehicles : []),
          players.length,
          result
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
        `INSERT INTO awards (battle_id, player_id, name, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(battle_id, player_id, name) DO UPDATE SET count = excluded.count`
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
          insAward.run(battleId, id, a.name, a.count || 1);
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
      'SELECT COUNT(*) n FROM battles WHERE id > ? AND started_at >= ?'
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

  /** Последние бои для вкладки истории. */
  recentBattles(limit = 50) {
    return this.db
      .prepare(
        `SELECT id, started_at, duration, my_kills, my_deaths, my_vehicles, players_seen
         FROM battles ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit)
      .map((b) => ({ ...b, my_vehicles: JSON.parse(b.my_vehicles || '[]') }));
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
        `SELECT p.nick, a.name, a.count FROM awards a
         JOIN players p ON p.id = a.player_id WHERE a.battle_id = ?`
      )
      .all(id);
    for (const p of players) {
      p.awards = awards.filter((a) => a.nick === p.nick).map((a) => ({ name: a.name, count: a.count }));
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
    const escaped = self.replace(/[\\%_]/g, (c) => `\\${c}`);
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
         WHERE bp.team = ? AND b.started_at >= ?
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
         WHERE bp.player_id = ? ORDER BY b.started_at DESC LIMIT 200`
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
         WHERE p.nick IN (${holes})
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

    const self = this.db
      .prepare('SELECT id FROM players WHERE nick = ? OR nick LIKE ? ESCAPE \'\\\' LIMIT 1')
      .get(selfNick, `% ${String(selfNick || '').replace(/[\\%_]/g, (c) => `\\${c}`)}`);

    let duelRows = [];
    if (self?.id) {
      duelRows = this.db
        .prepare(
          `SELECT killer_id, victim_id, SUM(count) AS n FROM duels
           WHERE (killer_id = ? AND victim_id IN (${idHoles}))
              OR (victim_id = ? AND killer_id IN (${idHoles}))
           GROUP BY killer_id, victim_id`
        )
        .all(self.id, ...idList, self.id, ...idList);
    }

    const notes = this.db
      .prepare(`SELECT player_id, note FROM player_notes WHERE player_id IN (${idHoles})`)
      .all(...idList);

    const out = {};
    for (const r of rows) {
      const fav = favourites.filter((f) => f.player_id === r.id).slice(0, 3);
      const killedMe = duelRows
        .filter((d) => d.killer_id === r.id && d.victim_id === self?.id)
        .reduce((s, d) => s + d.n, 0);
      const killedByMe = duelRows
        .filter((d) => d.victim_id === r.id && d.killer_id === self?.id)
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
    const escaped = String(selfNick || '').replace(/[\\%_]/g, (c) => `\\${c}`);
    const self = this.db
      .prepare("SELECT id FROM players WHERE nick = ? OR nick LIKE ? ESCAPE '\\' LIMIT 1")
      .get(selfNick, `% ${escaped}`);
    if (!self?.id) return [];

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
         WHERE s.player_id = ? AND b.started_at >= ?
         GROUP BY s.vehicle
         ORDER BY sorties DESC`
      )
      .all(self.id, since);
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
         WHERE bp.team = 'enemy' AND b.started_at >= ?
         GROUP BY s.vehicle
         ORDER BY sorties DESC
         LIMIT ?`
      )
      .all(since, limit);
  }

  /** Винрейт за период. Бои без распознанного исхода не искажают числа. */
  winrate({ since = 0 } = {}) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
         FROM battles WHERE started_at >= ?`
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

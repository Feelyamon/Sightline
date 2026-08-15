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
  players_seen INTEGER NOT NULL DEFAULT 0
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

    // Базы, созданные до появления reset_id, донастраиваем на месте.
    const cols = this.db.prepare('PRAGMA table_info(counters)').all();
    if (!cols.some((c) => c.name === 'reset_id')) {
      this.db.exec('ALTER TABLE counters ADD COLUMN reset_id INTEGER NOT NULL DEFAULT 0');
    }

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
  saveBattle(snapshot, { startedAt, endedAt } = {}) {
    const players = snapshot.players || [];
    if (!players.length) return null;

    const now = Date.now();
    const start = startedAt || now;
    const end = endedAt || now;
    const me = players.find((p) => p.isSelf);

    const tx = () => {
      const battleId = this.db
        .prepare(
          `INSERT INTO battles (started_at, ended_at, duration, my_kills, my_deaths, my_vehicles, players_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          start,
          end,
          snapshot.clock || 0,
          me ? me.kills : 0,
          me ? me.deaths : 0,
          JSON.stringify(me ? me.vehicles : []),
          players.length
        ).lastInsertRowid;

      const upsertPlayer = this.db.prepare(
        `INSERT INTO players (nick, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(nick) DO UPDATE SET last_seen = excluded.last_seen`
      );
      const findPlayer = this.db.prepare('SELECT id FROM players WHERE nick = ?');
      const insBp = this.db.prepare(
        `INSERT INTO battle_players (battle_id, player_id, team, kills, deaths, vehicles, left_battle)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const p of players) {
        upsertPlayer.run(p.nick, start, end);
        const { id } = findPlayer.get(p.nick);
        insBp.run(
          battleId,
          id,
          p.team,
          p.kills,
          p.deaths,
          JSON.stringify(p.vehicles || []),
          p.status === 'left' ? 1 : 0
        );
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

  deleteBattle(id) {
    this.db.prepare('DELETE FROM battles WHERE id = ?').run(id);
  }

  /**
   * Топ игроков. side='ally' — с кем чаще играю, 'enemy' — против кого.
   * since — граница окна (например, месяц), minBattles — порог показа.
   */
  topPlayers({ side = 'enemy', since = 0, minBattles = 1, limit = 50 } = {}) {
    return this.db
      .prepare(
        `SELECT p.nick,
                COUNT(*) AS battles,
                SUM(bp.kills)  AS kills,
                SUM(bp.deaths) AS deaths,
                MAX(b.started_at) AS last_seen
         FROM battle_players bp
         JOIN players p ON p.id = bp.player_id
         JOIN battles b ON b.id = bp.battle_id
         WHERE bp.team = ? AND b.started_at >= ?
         GROUP BY p.id
         HAVING battles >= ?
         ORDER BY battles DESC, last_seen DESC
         LIMIT ?`
      )
      .all(side, since, minBattles, limit);
  }

  /** Вся история встреч с конкретным игроком. */
  playerCard(nick) {
    const player = this.db.prepare('SELECT * FROM players WHERE nick = ?').get(nick);
    if (!player) return null;
    const rows = this.db
      .prepare(
        `SELECT b.id, b.started_at, bp.team, bp.kills, bp.deaths, bp.vehicles
         FROM battle_players bp JOIN battles b ON b.id = bp.battle_id
         WHERE bp.player_id = ? ORDER BY b.started_at DESC LIMIT 200`
      )
      .all(player.id)
      .map((r) => ({ ...r, vehicles: JSON.parse(r.vehicles || '[]') }));
    return { ...player, encounters: rows };
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

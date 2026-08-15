'use strict';

const { parseMessage } = require('./killfeed-parser');
const { classify, learn } = require('./vehicle-class');

const isDrone = (vehicle) => !!vehicle && classify(vehicle) === 'drone';

/**
 * Union-Find с чётностью: рёбра означают «эти двое в РАЗНЫХ командах».
 * Позволяет раскрасить кил-фид в две команды, не имея от игры признака команды.
 */
class ParityUnionFind {
  constructor() {
    this.parent = new Map(); // nick -> parent nick
    this.parity = new Map(); // nick -> чётность относительно родителя (0/1)
    this.rank = new Map();
    this.conflicts = 0; // тимкиллы и прочие противоречия
  }

  add(nick) {
    if (this.parent.has(nick)) return;
    this.parent.set(nick, nick);
    this.parity.set(nick, 0);
    this.rank.set(nick, 0);
  }

  /** @returns {{root: string, parity: 0|1}} */
  find(nick) {
    this.add(nick);
    let p = this.parent.get(nick);
    if (p === nick) return { root: nick, parity: 0 };
    const up = this.find(p);
    const parity = (this.parity.get(nick) + up.parity) % 2;
    this.parent.set(nick, up.root); // сжатие пути
    this.parity.set(nick, parity);
    return { root: up.root, parity };
  }

  /** relation: 1 — разные команды, 0 — одна команда. */
  union(a, b, relation) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra.root === rb.root) {
      if ((ra.parity + rb.parity) % 2 !== relation % 2) this.conflicts++;
      return;
    }
    // Чётность нового ребра между корнями.
    const edge = (ra.parity + rb.parity + relation) % 2;
    const rankA = this.rank.get(ra.root);
    const rankB = this.rank.get(rb.root);
    if (rankA < rankB) {
      this.parent.set(ra.root, rb.root);
      this.parity.set(ra.root, edge);
    } else {
      this.parent.set(rb.root, ra.root);
      this.parity.set(rb.root, edge);
      if (rankA === rankB) this.rank.set(ra.root, rankA + 1);
    }
  }

  /** Чётность относительно опорного ника, либо null если они не связаны. */
  parityTo(nick, reference) {
    if (!reference || !this.parent.has(nick) || !this.parent.has(reference)) return null;
    const a = this.find(nick);
    const b = this.find(reference);
    if (a.root !== b.root) return null;
    return (a.parity + b.parity) % 2;
  }
}

/** Состояние одного боя: игроки, их K/D и техника. Живёт до battle:reset. */
class BattleState {
  constructor(selfNick = '') {
    this.selfNick = (selfNick || '').trim();
    this.reset();
  }

  reset() {
    /** @type {Map<string, {nick, kills, deaths, vehicles: string[], lastVehicle: string|null, lastSeen: number}>} */
    this.players = new Map();
    this.teams = new ParityUnionFind();
    this.unparsed = [];
    this.events = 0;
    this.startedAt = Date.now();
  }

  setSelfNick(nick) {
    this.selfNick = (nick || '').trim();
  }

  player(nick) {
    let p = this.players.get(nick);
    if (!p) {
      p = {
        nick,
        kills: 0,
        deaths: 0,
        // Каждый вылет — отдельная запись: техника, фраги на ней и чем кончился.
        // Респавн на той же технике даёт новую запись, а не продолжает старую.
        sorties: [],
        status: 'unknown', // alive | dead | left | unknown
        lastSeen: 0,
      };
      this.players.set(nick, p);
      this.teams.add(nick);
    }
    return p;
  }

  /** Текущий (последний) вылет игрока. */
  currentSortie(p) {
    return p.sorties.length ? p.sorties[p.sorties.length - 1] : null;
  }

  /**
   * Отмечает, что игрока видели живым в этой технике.
   *
   * Новый вылет заводится, когда сменилась техника или предыдущий вылет
   * закончился уничтожением — так «выкатил снова тот же танк» не сливается
   * с прошлой жизнью.
   */
  seen(participant, at, { alive = true } = {}) {
    if (!participant || !participant.nick) return null;
    const p = this.player(participant.nick);
    p.lastSeen = at;

    const vehicle = participant.vehicle || null;
    let cur = this.currentSortie(p);
    const needNew =
      !cur ||
      cur.destroyed ||
      (vehicle && cur.vehicle !== vehicle) ||
      (vehicle && cur.vehicle === null);

    if (needNew) {
      // Запись без техники («ещё не выехал») не плодим повторно.
      if (!vehicle && cur && cur.vehicle === null && !cur.destroyed) {
        // нечего добавлять
      } else {
        cur = { vehicle, kills: 0, destroyed: false, from: at, to: at };
        p.sorties.push(cur);
      }
    } else if (vehicle && cur.vehicle === null) {
      cur.vehicle = vehicle;
    }

    cur = this.currentSortie(p);
    if (cur) cur.to = at;
    if (alive && p.status !== 'left') p.status = 'alive';
    return p;
  }

  /** Фраг идёт и в общий счёт, и в счёт текущего вылета. */
  addKill(p) {
    p.kills++;
    const cur = this.currentSortie(p);
    if (cur) cur.kills++;
  }

  /** Смерть закрывает текущий вылет — следующее появление откроет новый. */
  addDeath(p) {
    p.deaths++;
    const cur = this.currentSortie(p);
    if (cur) cur.destroyed = true;
    if (p.status !== 'left') p.status = 'dead';
  }

  /** Скармливает одну запись из /hudmsg (поле damage). */
  ingest(entry) {
    const at = typeof entry?.time === 'number' ? entry.time : Date.now();
    const parsed = parseMessage(entry?.msg);
    this.events++;

    // «Сбил X (машина)» — значит машина летала. Вертолёт от самолёта глагол
    // не отличает, поэтому пишем самолёт только если шаблоны молчат.
    if (parsed.victimAir && parsed.victim?.vehicle) {
      learn(parsed.victim.vehicle, 'plane');
    }

    switch (parsed.type) {
      case 'kill': {
        const killer = this.seen(parsed.actor, at);
        // Сбитый разведдрон — не потеря машины: жертву не трогаем вообще,
        // фраг убийце засчитываем.
        if (isDrone(parsed.victim?.vehicle)) {
          if (killer) this.addKill(killer);
          break;
        }
        const victim = this.seen(parsed.victim, at);
        if (!killer || !victim || killer.nick === victim.nick) {
          if (victim) this.addDeath(victim);
          break;
        }
        this.addKill(killer);
        this.addDeath(victim);
        this.teams.union(killer.nick, victim.nick, 1);
        break;
      }
      case 'damage': {
        // Счёт не меняем: важна только засветившаяся техника.
        this.seen(parsed.actor, at);
        if (isDrone(parsed.victim?.vehicle)) break;
        this.seen(parsed.victim, at);
        if (parsed.actor?.nick && parsed.victim?.nick && parsed.actor.nick !== parsed.victim.nick) {
          this.teams.union(parsed.actor.nick, parsed.victim.nick, 1);
        }
        break;
      }
      case 'selfDeath': {
        if (isDrone(parsed.victim?.vehicle)) break;
        const victim = this.seen(parsed.victim, at);
        if (victim) this.addDeath(victim);
        break;
      }
      case 'left': {
        // Техники в строке нет, поэтому игрока «живым» не помечаем.
        const nick = parsed.victim?.nick;
        if (!nick) break;
        const p = this.player(this.matchExisting(nick) || nick);
        p.lastSeen = at;
        p.status = 'left';
        break;
      }
      case 'noise':
        break;
      default:
        // Копим для дев-лога: по этим строкам дописываются глаголы в verbs.js.
        if (entry?.msg) {
          this.unparsed.push(String(entry.msg));
          if (this.unparsed.length > 200) this.unparsed.shift();
        }
    }
    return parsed;
  }

  /**
   * Находит игрока по введённому нику. В кил-фиде ник идёт вместе с клан-тегом
   * («[CLAN] Username»), а пользователь вводит его без тега — поэтому кроме
   * точного совпадения принимаем «<тег> <ник>». Если так совпало несколько
   * игроков, не угадываем и возвращаем null.
   */
  resolveSelf() {
    return this.matchExisting(this.selfNick);
  }

  /**
   * Ищет среди уже известных игроков того, кто скрывается за этим написанием
   * ника. Строки о выходе из боя иногда приходят без клан-тега, и без такого
   * сопоставления в таблице заводился бы игрок-двойник.
   * Возвращает null, если однозначного соответствия нет.
   */
  matchExisting(nick) {
    const name = (nick || '').trim();
    if (!name) return null;
    if (this.players.has(name)) return name;

    const known = [...this.players.keys()];
    // «Username» ↔ «[CLAN] Username» — в любую сторону.
    const matches = known.filter(
      (k) => k.endsWith(` ${name}`) || name.endsWith(` ${k}`)
    );
    return matches.length === 1 ? matches[0] : null;
  }

  /** Снапшот для UI. Он маленький — шлём целиком, без диффов. */
  snapshot() {
    const ref = this.resolveSelf();
    const rows = [];
    for (const p of this.players.values()) {
      const parity = this.teams.parityTo(p.nick, ref);
      const cur = this.currentSortie(p);
      const alive = p.status === 'alive';
      rows.push({
        nick: p.nick,
        kills: p.kills,
        deaths: p.deaths,
        status: p.status,
        // Техника «сейчас» — только пока игрок жив; иначе он в ангаре и что
        // выкатит дальше, кил-фид ещё не знает.
        currentVehicle: alive && cur && !cur.destroyed ? cur.vehicle : null,
        // На чём его сожгли последний раз.
        killedOn: cur && cur.destroyed ? cur.vehicle : null,
        // Класс считаем здесь: в renderer модулей main нет.
        currentClass: alive && cur && !cur.destroyed ? classify(cur.vehicle) : null,
        killedOnClass: cur && cur.destroyed ? classify(cur.vehicle) : null,
        sorties: p.sorties.map((s) => ({ ...s, class: classify(s.vehicle) })),
        vehicles: [...new Set(p.sorties.map((s) => s.vehicle).filter(Boolean))],
        lastSeen: p.lastSeen,
        isSelf: ref !== null && p.nick === ref,
        team: parity === null ? 'unknown' : parity === 0 ? 'ally' : 'enemy',
      });
    }
    // Вышедшие из боя — вниз: они уже не угрожают.
    rows.sort(
      (a, b) =>
        Number(a.status === 'left') - Number(b.status === 'left') ||
        b.kills - a.kills ||
        a.deaths - b.deaths ||
        a.nick.localeCompare(b.nick)
    );

    // Часы боя: время последнего события, к нему считается «видели N назад».
    const clock = rows.reduce((m, r) => Math.max(m, r.lastSeen || 0), 0);

    return {
      players: rows,
      knownPlayers: rows.length,
      alivePlayers: rows.filter((r) => r.status === 'alive').length,
      clock,
      selfNick: this.selfNick,
      selfSeen: ref !== null,
      teamConflicts: this.teams.conflicts,
      unparsed: this.unparsed.slice(-20),
      startedAt: this.startedAt,
    };
  }
}

module.exports = { BattleState, ParityUnionFind };

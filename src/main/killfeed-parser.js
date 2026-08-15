'use strict';

const {
  KILL_VERBS,
  DAMAGE_VERBS,
  SELF_DEATH_PATTERNS,
  LEFT_PATTERNS,
  NOISE_PATTERNS,
  AIR_VERBS,
  AWARD_PATTERNS,
  NAMED_AWARDS,
} = require('./verbs');

// Длинные глаголы вперёд: «тяжело повредил» должен победить «повредил»,
// «shot down» — «down» и т.п.
const byLengthDesc = (a, b) => b.length - a.length;
const KILLS = [...KILL_VERBS].sort(byLengthDesc);
const DAMAGES = [...DAMAGE_VERBS].sort(byLengthDesc);

/**
 * Разбирает «Ник (Техника)» с конца строки.
 *
 * Ник может содержать скобки (клан-теги, юникод-украшения), поэтому берём
 * ИМЕННО последнюю сбалансированную пару скобок в конце, а не первую попавшуюся.
 * Возвращает { nick, vehicle } либо { nick, vehicle: null }, если скобок нет
 * (так игра пишет про игроков вне техники).
 */
function parseParticipant(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (!s.endsWith(')')) return { nick: s, vehicle: null };

  let depth = 0;
  let open = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
  }
  if (open <= 0) return { nick: s, vehicle: null };

  const nick = s.slice(0, open).trim();
  const vehicle = s.slice(open + 1, s.length - 1).trim();
  if (!nick) return { nick: s, vehicle: null };
  return { nick, vehicle: vehicle || null };
}

/** Ищет глагол из списка как отдельное слово; возвращает позицию и длину. */
function findVerb(msg, verbs) {
  const lower = msg.toLowerCase();
  for (const verb of verbs) {
    const v = verb.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(v, from);
      if (at === -1) break;
      const before = at === 0 ? ' ' : lower[at - 1];
      const after = lower[at + v.length] === undefined ? ' ' : lower[at + v.length];
      // Границы слова: глагол должен стоять между участниками, а не внутри ника.
      if (/[\s)]/.test(before) && /[\s(]/.test(after)) {
        return { index: at, length: v.length, verb: v };
      }
      from = at + v.length;
    }
  }
  return null;
}

/**
 * Награда за бой: «Ник (Техника) получил "Снайпер"», «... получил
 * "Спасатель танков: x2"», «... ударил первым!».
 * @returns {{type:'award', actor, award, count}|null}
 */
function parseAward(text) {
  for (const re of AWARD_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const actor = parseParticipant(text.slice(0, m.index));
    if (!actor) continue;
    // Повторяемые награды приходят с хвостом «: x3» — иногда с восклицательным
    // знаком («Удар из тени: x5!»). Без него уровни одной награды разъезжались
    // на отдельные записи.
    const raw = m[1].trim();
    const withCount = /^(.*?):\s*x\s*(\d+)\s*!?$/i.exec(raw);
    return {
      type: 'award',
      actor,
      award: withCount ? withCount[1].trim() : raw,
      count: withCount ? Number(withCount[2]) : 1,
    };
  }

  for (const { re, name } of NAMED_AWARDS) {
    const m = re.exec(text);
    if (!m) continue;
    const actor = parseParticipant(text.slice(0, m.index));
    if (actor) return { type: 'award', actor, award: name, count: 1 };
  }
  return null;
}

/**
 * Разбирает одно сообщение кил-фида.
 *
 * @returns {object} одно из:
 *   { type: 'kill',      actor, victim }   — actor убил victim
 *   { type: 'damage',    actor, victim }   — обе машины засветились, счёт не меняется
 *   { type: 'selfDeath', victim }          — гибель без убийцы
 *   { type: 'left',      victim }          — игрок вышел из боя
 *   { type: 'noise' }                      — ачивки/захваты, игнор
 *   { type: 'unknown' }                    — не распознали, повод дописать verbs.js
 * actor/victim: { nick, vehicle|null }
 */
function parseMessage(msg) {
  const text = String(msg || '').trim();
  if (!text) return { type: 'noise' };

  // Награды проверяем раньше шума: часть их формулировок иначе была бы
  // отброшена как «ачивка».
  const award = parseAward(text);
  if (award) return award;

  if (NOISE_PATTERNS.some((re) => re.test(text))) return { type: 'noise' };

  // Раньше глаголов: строка про выход из боя не содержит второго участника.
  for (const re of LEFT_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const victim = parseParticipant(text.slice(0, m.index));
    if (victim) return { type: 'left', victim };
  }

  for (const [verbs, type] of [[KILLS, 'kill'], [DAMAGES, 'damage']]) {
    const hit = findVerb(text, verbs);
    if (!hit) continue;
    const actor = parseParticipant(text.slice(0, hit.index));
    const victim = parseParticipant(text.slice(hit.index + hit.length));
    // Нужны оба участника — иначе это не «А сделал Б», а что-то другое.
    if (actor && victim) {
      // «Сбил» говорит, что жертва была в воздухе.
      const victimAir = AIR_VERBS.some((v) => v.toLowerCase() === hit.verb);
      return { type, actor, victim, verb: hit.verb, victimAir };
    }
  }

  for (const re of SELF_DEATH_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const victim = parseParticipant(text.slice(0, m.index));
    if (victim) return { type: 'selfDeath', victim };
  }

  return { type: 'unknown' };
}

module.exports = { parseMessage, parseParticipant, parseAward };

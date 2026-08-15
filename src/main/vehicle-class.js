'use strict';

// Класс техники API не отдаёт — есть только название из кил-фида. Определяем
// двумя источниками:
//   1) шаблоны имён (ниже);
//   2) подсказка из глагола: «сбил» и «разбился» бывают только про воздух —
//      battle-state скармливает такие наблюдения через learn().
// Что не опознали — считаем наземкой (её большинство) и копим в unknownVehicles,
// чтобы шаблоны можно было дописать по факту.

const HELI_PATTERNS = [
  /^(?:ми|mi)-\d/i,
  /^(?:ка|ka)-\d/i,
  /^(?:ah|uh|oh|ch|sh|hh)-\d/i,
  /\bapache\b/i,
  /\bec-?665\b/i,
  /\btiger\s+(?:uht|had)/i,
  /\bhad-e\b/i,
  /\blynx\b/i,
  /\bgazelle\b/i,
  /\bz-\d{1,2}\b/i,
  /\bwz-?\d{1,2}\b/i,
  /\bcobra\b/i,
];

const PLANE_PATTERNS = [
  /^(?:bf|fw|me|ju|he|do|ta)\s?\d/i,
  /^(?:як|yak|ла|la|миг|mig|су|su|ил|il|пе|pe|ту|tu)-\d/i,
  /^(?:f|a|b|p|j|ki|d|g|r)-?\d{1,3}[a-z]?$/i,
  /^(?:f|mig|su)-\d{1,3}/i,
  /\bspitfire\b/i,
  /\bhurricane\b/i,
  /\bmustang\b/i,
  /\bthunderbolt\b/i,
  /\bcorsair\b/i,
  /\bphantom\b/i,
  /\btornado\b/i,
  /\bharrier\b/i,
  /\bgripen\b/i,
  /\brafale\b/i,
  /\bmirage\b/i,
  /\btyphoon\b/i,
];

// ЗСУ/ЗРК: формально наземка, но роль другая — отмечаем отдельно.
const SPAA_PATTERNS = [
  /панцирь/i,
  /тунгуска/i,
  /шилка/i,
  /стрела/i,
  /оса-/i,
  /\bgepard\b/i,
  /\broland\b/i,
  /\badats\b/i,
  /\bozelot\b/i,
  /\bitpsv\b/i,
  /\btype 93\b/i,
  /\bm163\b/i,
  /\bwirbelwind\b/i,
  /\bostwind\b/i,
];

const DRONE_PATTERNS = [/recon micro/i, /fly-?eye/i, /skylark/i, /\b(?:rq|mq)-\d/i, /скаут/i];

const ICONS = {
  tank: '▮',
  spaa: '◬',
  plane: '✈',
  heli: '⊹',
  drone: '⌖',
};

const LABELS = {
  tank: 'наземная техника',
  spaa: 'ЗСУ / ЗРК',
  plane: 'самолёт',
  heli: 'вертолёт',
  drone: 'разведдрон',
};

// Подсказки, добытые из глаголов кил-фида: имя техники → класс.
const learned = new Map();
// Названия, не подошедшие ни под один шаблон — сюда, для доработки списков.
const unknownVehicles = new Set();

/** Запоминает класс, выведенный из контекста (например, «сбил» → воздух). */
function learn(vehicle, klass) {
  if (!vehicle || !klass) return;
  const name = vehicle.trim();
  if (!name) return;
  // Шаблон всегда точнее догадки: если имя уже опознано, не перетираем.
  if (matchPatterns(name)) return;
  learned.set(name, klass);
  unknownVehicles.delete(name);
}

function matchPatterns(name) {
  if (DRONE_PATTERNS.some((re) => re.test(name))) return 'drone';
  if (HELI_PATTERNS.some((re) => re.test(name))) return 'heli';
  if (PLANE_PATTERNS.some((re) => re.test(name))) return 'plane';
  if (SPAA_PATTERNS.some((re) => re.test(name))) return 'spaa';
  return null;
}

/**
 * @returns {'tank'|'spaa'|'plane'|'heli'|'drone'}
 */
function classify(vehicle) {
  if (!vehicle) return 'tank';
  // Украшения в названиях («◍M1A1 HC», «▄Tigre HAD-E») мешают шаблонам.
  const name = vehicle.replace(/^[^\p{L}\p{N}]+/u, '').trim();

  const byPattern = matchPatterns(name);
  if (byPattern) return byPattern;

  const known = learned.get(name);
  if (known) return known;

  unknownVehicles.add(name);
  return 'tank';
}

/**
 * Имя для показа: игра приписывает к названиям служебные символы («◍M1A1 HC»,
 * «▄Su-30MK»). В таблице они читаются как мусор, поэтому режем ведущие
 * не-буквенные символы. Исходное имя остаётся в подсказке и уходит в базу.
 */
function displayName(vehicle) {
  if (!vehicle) return vehicle;
  const clean = vehicle.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return clean || vehicle;
}

const iconFor = (vehicle) => ICONS[classify(vehicle)];
const labelFor = (vehicle) => LABELS[classify(vehicle)];

/** Для дев-лога: что не опознано шаблонами. */
const getUnknownVehicles = () => [...unknownVehicles];

// Не игроки, а игровые сущности: игра пишет их в кил-фид так же, как людей.
// Живые примеры: «уничтожил [ии] Recon Micro» (дрон под управлением ИИ),
// «уничтожил weapons/us_agm_88a/short» (сбитая ракета). Техники в скобках у
// них нет, поэтому по названию машины они не отсеиваются.
const ENTITY_NICK_PATTERNS = [
  /^weapons\//i,
  /^\[(?:ии|ai)\]/i,
];

/**
 * Отличает игровую сущность от живого игрока по нику.
 * Дрон опознаётся и по имени после клан-тега: «[ии] Recon Micro».
 */
function isEntityNick(nick) {
  const name = String(nick || '').trim();
  if (!name) return false;
  if (ENTITY_NICK_PATTERNS.some((re) => re.test(name))) return true;
  // Ник вида «<тег> Recon Micro» — это сам дрон, а не его владелец.
  const withoutTag = name.replace(/^\[[^\]]*\]\s*/, '').trim();
  return matchPatterns(withoutTag) === 'drone';
}

module.exports = {
  classify,
  displayName,
  iconFor,
  labelFor,
  learn,
  isEntityNick,
  getUnknownVehicles,
  ICONS,
  LABELS,
};

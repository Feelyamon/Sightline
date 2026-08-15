'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseMessage, parseParticipant } = require('../src/main/killfeed-parser');

test('английское убийство танка', () => {
  const r = parseMessage('Username (T-34-85) destroyed Fritz_88 (Pz.IV G)');
  assert.equal(r.type, 'kill');
  assert.deepEqual(r.actor, { nick: 'Username', vehicle: 'T-34-85' });
  assert.deepEqual(r.victim, { nick: 'Fritz_88', vehicle: 'Pz.IV G' });
});

test('сбитие самолёта (двусловный глагол)', () => {
  const r = parseMessage('Ace (Yak-9T) shot down Bandit (Bf 109 F-4)');
  assert.equal(r.type, 'kill');
  assert.equal(r.actor.vehicle, 'Yak-9T');
  assert.equal(r.victim.nick, 'Bandit');
});

test('русское убийство', () => {
  const r = parseMessage('Игрок (ИС-2) уничтожил Враг (Тигр H1)');
  assert.equal(r.type, 'kill');
  assert.equal(r.actor.nick, 'Игрок');
  assert.equal(r.victim.vehicle, 'Тигр H1');
});

test('клан-тег остаётся частью ника', () => {
  const r = parseMessage('[CLAN]Hans (Panther D) destroyed Ally (KV-1)');
  assert.equal(r.actor.nick, '[CLAN]Hans');
});

test('ник со скобками не ломает разбор техники', () => {
  const r = parseMessage('Pro (RU) (T-44) destroyed Noob (M4A1)');
  assert.equal(r.type, 'kill');
  assert.equal(r.actor.nick, 'Pro (RU)');
  assert.equal(r.actor.vehicle, 'T-44');
});

test('повреждение — не убийство, но техника видна', () => {
  const r = parseMessage('Hans (Panther D) severely damaged Username (T-34-85)');
  assert.equal(r.type, 'damage');
  assert.equal(r.victim.vehicle, 'T-34-85');
});

test('«тяжело повредил» не матчится как «повредил»', () => {
  const r = parseMessage('Hans (Пантера) тяжело повредил Игрок (Т-34)');
  assert.equal(r.type, 'damage');
  assert.equal(r.actor.nick, 'Hans');
  assert.equal(r.victim.nick, 'Игрок');
});

test('крэш без убийцы', () => {
  const r = parseMessage('NoobPilot (Spitfire Mk Vb) has crashed.');
  assert.equal(r.type, 'selfDeath');
  assert.equal(r.victim.nick, 'NoobPilot');
  assert.equal(r.victim.vehicle, 'Spitfire Mk Vb');
});

test('ачивки и серии отбрасываются как шум', () => {
  assert.equal(parseMessage('Username has achieved Aviation Rank 3').type, 'noise');
  assert.equal(parseMessage('Username has captured the zone').type, 'noise');
});

test('незнакомая строка помечается unknown', () => {
  assert.equal(parseMessage('какая-то новая формулировка от Gaijin').type, 'unknown');
});

// Ниже — строки, снятые с живого боя 15.08.2026. Раньше падали в unknown.

test('живое: техника со скобками и кавычками внутри', () => {
  const r = parseMessage(
    '=CLNE= 玩家三号 (БМПТ-72) уничтожил [CLNF] ⋇PlayerFour (Type 90 (B) "Fuji")'
  );
  assert.equal(r.type, 'kill');
  assert.equal(r.actor.nick, '=CLNE= 玩家三号');
  assert.equal(r.victim.nick, '[CLNF] ⋇PlayerFour');
  assert.equal(r.victim.vehicle, 'Type 90 (B) "Fuji"');
});

test('живое: скобки в названии техники', () => {
  const r = parseMessage('PLAYERTHIRTEEN (Т-90М (Арена-М)) уничтожил V10000 (M1A1 Click-Bait)');
  assert.equal(r.actor.vehicle, 'Т-90М (Арена-М)');
});

test('живое: фатальное повреждение — это фраг', () => {
  const r = parseMessage(
    '玩家十四号 (Панцирь-С1) нанёс фатальное повреждение PlayerFifteen69 (Recon Micro)'
  );
  assert.equal(r.type, 'kill');
  assert.equal(r.victim.nick, 'PlayerFifteen69');
});

test('живое: дисконнект — выход из боя, его дубль-ключ — шум', () => {
  const r = parseMessage('*CLNA* PlayerSeventeen потерял связь');
  assert.equal(r.type, 'left');
  assert.equal(r.victim.nick, '*CLNA* PlayerSeventeen');
  assert.equal(
    parseMessage('PlayerSeventeentd! kd?NET_PLAYER_DISCONNECT_FROM_GAME').type,
    'noise'
  );
});

test('живое: награды разбираются с названием и количеством', () => {
  const sniper = parseMessage('=CLNE= Ник (БМПТ-72) получил "Снайпер"');
  assert.equal(sniper.type, 'award');
  assert.equal(sniper.award, 'Снайпер');
  assert.equal(sniper.count, 1);
  assert.equal(sniper.actor.vehicle, 'БМПТ-72');

  // Повторяемые награды приходят с хвостом «: xN».
  const saver = parseMessage('=CLNE= Ник (БМПТ-72) получил "Спасатель танков: x2"');
  assert.equal(saver.award, 'Спасатель танков');
  assert.equal(saver.count, 2);

  // Живой случай: у части наград после числа стоит восклицательный знак,
  // и уровни одной награды разъезжались на отдельные записи.
  const shadow = parseMessage('Ник (Т-80БВМ) получил "Удар из тени: x5!"');
  assert.equal(shadow.award, 'Удар из тени');
  assert.equal(shadow.count, 5);

  // Награда без кавычек — своя формулировка.
  const first = parseMessage('[CLNC] Ник (Leopard 2A4M) ударил первым!');
  assert.equal(first.type, 'award');
  assert.equal(first.award, 'Ударил первым');
});

test('участник без техники', () => {
  assert.deepEqual(parseParticipant('JustNick'), { nick: 'JustNick', vehicle: null });
});

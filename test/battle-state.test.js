'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BattleState } = require('../src/main/battle-state');

function feed(state, messages) {
  messages.forEach((msg, i) => state.ingest({ id: i + 1, msg, time: i }));
  return state.snapshot();
}
const find = (snap, nick) => snap.players.find((p) => p.nick === nick);

test('считает убийства, смерти и историю техники', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Me (T-34-85) destroyed Foe (Pz.IV G)',
    'Me (T-34-85) destroyed Foe (Tiger H1)',
    'Foe (Tiger H1) destroyed Me (T-34-85)',
  ]);
  assert.equal(find(snap, 'Me').kills, 2);
  assert.equal(find(snap, 'Me').deaths, 1);
  assert.deepEqual(find(snap, 'Foe').vehicles, ['Pz.IV G', 'Tiger H1']);
});

test('статус: жив, уничтожен, снова жив на новой технике', () => {
  const s = new BattleState('Me');
  let snap = feed(s, ['Foe (Pz.IV G) уничтожил Ally (M4)']);
  assert.equal(find(snap, 'Foe').status, 'alive');
  assert.equal(find(snap, 'Foe').currentVehicle, 'Pz.IV G');
  assert.equal(find(snap, 'Ally').status, 'dead');
  assert.equal(find(snap, 'Ally').killedOn, 'M4');
  assert.equal(find(snap, 'Ally').currentVehicle, null);

  s.ingest({ id: 9, msg: 'Ally (Sherman Firefly) уничтожил Foe (Pz.IV G)', time: 50 });
  snap = s.snapshot();
  assert.equal(find(snap, 'Ally').status, 'alive');
  assert.equal(find(snap, 'Ally').currentVehicle, 'Sherman Firefly');
  assert.equal(find(snap, 'Foe').status, 'dead');
  assert.equal(find(snap, 'Foe').killedOn, 'Pz.IV G');
});

test('вылеты копят фраги отдельно, респавн на той же технике — новый вылет', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Foe (Tiger H1) уничтожил A (M4)',
    'Foe (Tiger H1) уничтожил B (M4)',
    'C (ИС-2) уничтожил Foe (Tiger H1)',
    'Foe (Tiger H1) уничтожил D (M4)',
  ]);
  const foe = find(snap, 'Foe');
  assert.equal(foe.sorties.length, 2);
  assert.deepEqual(
    foe.sorties.map((x) => [x.vehicle, x.kills, x.destroyed]),
    [['Tiger H1', 2, true], ['Tiger H1', 1, false]]
  );
  assert.deepEqual(foe.vehicles, ['Tiger H1']);
  assert.equal(foe.status, 'alive');
});

test('выход из боя фиксируется и уводит игрока вниз списка', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Foe (Tiger H1) уничтожил A (M4)',
    '*CLNA* Foe потерял связь',
  ]);
  assert.equal(find(snap, 'Foe').status, 'left');
  assert.equal(snap.players[snap.players.length - 1].nick, 'Foe');
});

test('сбитый разведдрон не считается смертью и не пишется в технику', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Foe (Панцирь-С1) нанёс фатальное повреждение Ally (Recon Micro)',
  ]);
  assert.equal(find(snap, 'Foe').kills, 1);
  assert.equal(find(snap, 'Ally'), undefined);
});

test('игрок без техники помечается как «не выехал»', () => {
  const s = new BattleState('Me');
  const snap = feed(s, ['SomeGuy потерял связь']);
  assert.equal(find(snap, 'SomeGuy').status, 'left');
  assert.deepEqual(find(snap, 'SomeGuy').vehicles, []);
});

test('раскрашивает команды транзитивно от моего ника', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Foe (Tiger H1) destroyed Me (T-34-85)',
    'Ally (SU-100) destroyed Foe (Tiger H1)',
    'Foe2 (Panther D) destroyed Ally (SU-100)',
  ]);
  assert.equal(find(snap, 'Me').team, 'ally');
  assert.equal(find(snap, 'Me').isSelf, true);
  assert.equal(find(snap, 'Foe').team, 'enemy');
  assert.equal(find(snap, 'Ally').team, 'ally');
  assert.equal(find(snap, 'Foe2').team, 'enemy');
});

test('несвязанные с моим боем игроки — unknown', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Me (T-34) destroyed Foe (Pz.IV)',
    'Stranger1 (M4) destroyed Stranger2 (Ho-Ri)',
  ]);
  assert.equal(find(snap, 'Stranger1').team, 'unknown');
});

test('повреждение даёт технику, но не очки', () => {
  const s = new BattleState('Me');
  const snap = feed(s, ['Foe (Panther D) severely damaged Me (T-34-85)']);
  assert.equal(find(snap, 'Foe').kills, 0);
  assert.equal(find(snap, 'Me').deaths, 0);
  assert.equal(find(snap, 'Foe').currentVehicle, 'Panther D');
});

test('крэш засчитывается только как смерть', () => {
  const s = new BattleState('Me');
  const snap = feed(s, ['Noob (Spitfire Mk Vb) has crashed.']);
  assert.equal(find(snap, 'Noob').deaths, 1);
  assert.equal(find(snap, 'Noob').kills, 0);
});

test('свой ник находится, даже если в фиде он с клан-тегом', () => {
  const s = new BattleState('Username');
  const snap = feed(s, [
    '[CLAN] Username (Т-80БВМ) уничтожил =CLNM= player_twelve (M1A2 SEP)',
  ]);
  assert.equal(snap.selfSeen, true);
  assert.equal(find(snap, '[CLAN] Username').isSelf, true);
  assert.equal(find(snap, '[CLAN] Username').team, 'ally');
  assert.equal(find(snap, '=CLNM= player_twelve').team, 'enemy');
});

test('неоднозначный ник не угадывается', () => {
  const s = new BattleState('Ivan');
  const snap = feed(s, [
    '[A] Ivan (Т-72) уничтожил Foe (M1A1)',
    '[B] Ivan (Т-80) уничтожил Foe2 (M1A2)',
  ]);
  assert.equal(snap.selfSeen, false);
  assert.equal(find(snap, '[A] Ivan').team, 'unknown');
});

test('reset очищает бой', () => {
  const s = new BattleState('Me');
  feed(s, ['Me (T-34) destroyed Foe (Pz.IV)']);
  s.reset();
  assert.equal(s.snapshot().players.length, 0);
});

test('запись живого боя: смена техники, гибель, выход, дрон', () => {
  const file = path.join(__dirname, '..', 'fixtures', 'hudmsg-live.json');
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = new BattleState('Username');
  for (const e of entries) s.ingest(e);
  const snap = s.snapshot();

  assert.deepEqual(snap.unparsed, []);
  assert.equal(snap.selfSeen, true);
  assert.equal(snap.teamConflicts, 0);

  // Пересел после потери машины: старый вылет закрыт, новый идёт.
  const yao = find(snap, '=CLNM= player_twelve');
  assert.equal(yao.status, 'alive');
  assert.equal(yao.currentVehicle, 'M1A2 SEPv3');
  assert.deepEqual(
    yao.sorties.map((x) => [x.vehicle, x.destroyed]),
    [['M1A2 SEP', true], ['M1A2 SEPv3', false]]
  );

  // Уничтожен и ещё не выехал заново.
  const dead = find(snap, '┾CLNH┿ 玩家六号');
  assert.equal(dead.status, 'dead');
  assert.equal(dead.currentVehicle, null);
  assert.equal(dead.killedOn, 'ZTZ96B');

  // Вышел из боя, так и не появившись в технике.
  const left = find(snap, '*CLNA* PlayerSeventeen');
  assert.equal(left.status, 'left');
  assert.deepEqual(left.vehicles, []);

  // Владелец сбитого дрона в таблицу не попал, фраг у стрелка есть.
  assert.equal(find(snap, 'PlayerFifteen69'), undefined);
  assert.equal(find(snap, '玩家十四号').kills, 1);
});

test('мок-фикстура проигрывается без unknown-строк', () => {
  const file = path.join(__dirname, '..', 'fixtures', 'hudmsg-sample.json');
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = new BattleState('Username');
  for (const e of entries) s.ingest(e);
  const snap = s.snapshot();
  assert.deepEqual(snap.unparsed, []);
  assert.equal(find(snap, 'Fritz_88').team, 'enemy');
  assert.equal(find(snap, 'AllyOne').team, 'ally');
});

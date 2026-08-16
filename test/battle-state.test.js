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

test('сбитый разведдрон не считается ни смертью, ни фрагом', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Foe (Панцирь-С1) нанёс фатальное повреждение Ally (Recon Micro)',
  ]);
  // Машину владелец не терял, а стрелку фраг не идёт: на тот же дрон придёт
  // вторая строка «уничтожил [ии] Recon Micro», и счёт бы задвоился.
  assert.equal(find(snap, 'Foe').kills, 0);
  assert.equal(find(snap, 'Foe').currentVehicle, 'Панцирь-С1', 'техника стрелка видна');
  assert.equal(find(snap, 'Ally'), undefined);
});

test('ассист: повредил цель, добил другой', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Helper (Т-80БВМ) поджёг Victim (M1A2)',
    'Finisher (ИС-2) уничтожил Victim (M1A2)',
  ]);
  assert.equal(find(snap, 'Helper').assists, 1);
  assert.equal(find(snap, 'Helper').kills, 0);
  assert.equal(find(snap, 'Finisher').kills, 1);
  assert.equal(find(snap, 'Finisher').assists, 0, 'добивший ассист себе не пишет');
});

test('ассист не начисляется тому, кто сам и добил', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Solo (Т-80БВМ) поджёг Victim (M1A2)',
    'Solo (Т-80БВМ) уничтожил Victim (M1A2)',
  ]);
  assert.equal(find(snap, 'Solo').kills, 1);
  assert.equal(find(snap, 'Solo').assists, 0);
});

test('после гибели урон по новой жизни считается заново', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Helper (Т-80) поджёг Victim (M1A2)',
    'Finisher (ИС-2) уничтожил Victim (M1A2)',
    'Finisher (ИС-2) уничтожил Victim (M1A1)',
  ]);
  assert.equal(find(snap, 'Helper').assists, 1, 'старый урон не даёт второй ассист');
});

test('живое: «разбился» распознаётся (кириллица и \\b несовместимы)', () => {
  const s = new BattleState('Me');
  const snap = feed(s, ['=LHina= Ник (Ми-28НМ) разбился']);
  assert.deepEqual(snap.unparsed, []);
  assert.equal(find(snap, '=LHina= Ник').deaths, 1);
  assert.equal(find(snap, '=LHina= Ник').killedOn, 'Ми-28НМ');
});

test('живое: бортовое сообщение — шум, «последний удар» — награда', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Двигатель перегрелся',
    '[120B] Ник (Challenger 2 OES) нанёс последний удар!',
  ]);
  assert.deepEqual(snap.unparsed, []);
  assert.equal(snap.players.length, 1, 'бортовое сообщение игрока не создаёт');
  assert.deepEqual(find(snap, '[120B] Ник').awards, [
    { name: 'Последний удар', count: 1, tier: 0 },
  ]);
});

test('награды собираются по игрокам, повторяемые — с количеством', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Ace (БМПТ-72) уничтожил X (M1A2)',
    'Ace (БМПТ-72) получил "Снайпер"',
    'Ace (БМПТ-72) получил "Спасатель танков: x2"',
    'Ace (БМПТ-72) ударил первым!',
  ]);
  assert.deepEqual(snap.unparsed, []);
  const awards = find(snap, 'Ace').awards;
  assert.deepEqual(
    awards.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Спасатель танков', count: 2, tier: 0 },
      { name: 'Снайпер', count: 1, tier: 0 },
      { name: 'Ударил первым', count: 1, tier: 0 },
    ].sort((a, b) => a.name.localeCompare(b.name))
  );
});

test('степень награды растёт по ходу боя, а не плодит записи', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Ace (БМПТ-72) уничтожил X (M1A2)',
    'Ace (БМПТ-72) получил "Тактик"',
    'Ace (БМПТ-72) получил "Тактик II"',
    'Ace (БМПТ-72) получил "Тактик 3 степени"',
  ]);
  assert.deepEqual(snap.unparsed, []);
  assert.deepEqual(find(snap, 'Ace').awards, [{ name: 'Тактик', count: 1, tier: 3 }]);
});

test('«Око за око»: цель появляется после моей смерти и снимается', () => {
  const s = new BattleState('Me');

  feed(s, ['Killer (Leopard 2A4) уничтожил Me (Т-80БВМ)']);
  let snap = s.snapshot();
  assert.equal(snap.revengeTarget, 'Killer');
  assert.equal(find(snap, 'Killer').isRevengeTarget, true);

  // Отомстил — отметка не нужна.
  s.ingest({ id: 90, msg: 'Me (Т-80БВМ) уничтожил Killer (Leopard 2A4)', time: 90 });
  assert.equal(s.snapshot().revengeTarget, null);
});

test('«Око за око»: цель снимается, если обидчика убил кто-то другой', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Killer (Leopard 2A4) уничтожил Me (Т-80БВМ)',
    'Mate (ИС-2) уничтожил Killer (Leopard 2A4)',
  ]);
  assert.equal(snap.revengeTarget, null, 'медаль уже не получить');
});

test('«Око за око»: новый обидчик заменяет прежнего', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Killer1 (Leopard 2A4) уничтожил Me (Т-80БВМ)',
    'Killer2 (M1A2) уничтожил Me (Т-72Б3)',
  ]);
  assert.equal(snap.revengeTarget, 'Killer2');
});

test('служебные символы из имени техники не показываются', () => {
  const s = new BattleState('Me');
  const snap = feed(s, ['Foe (▄Su-30MK) сбил Ally (◍M1A1 HC)']);
  const foe = find(snap, 'Foe');
  assert.equal(foe.sorties[0].label, 'Su-30MK', 'для показа — без символов');
  assert.equal(foe.sorties[0].vehicle, '▄Su-30MK', 'исходное имя сохранено');
  assert.equal(foe.sorties[0].class, 'plane');
});

test('дрон не даёт двойного фрага: обе строки про него игнорируются', () => {
  const s = new BattleState('Me');
  // Игра шлёт на один сбитый дрон две строки подряд.
  const snap = feed(s, [
    '玩家十四号 (Панцирь-С1) нанёс фатальное повреждение PlayerFifteen69 (Recon Micro)',
    '玩家十四号 (Панцирь-С1) уничтожил [ии] Recon Micro',
  ]);
  assert.equal(find(snap, '玩家十四号').kills, 0, 'фраг за дрон не начисляется');
  assert.equal(find(snap, '[ии] Recon Micro'), undefined, 'сущность ИИ не игрок');
  assert.equal(find(snap, 'PlayerFifteen69'), undefined, 'владелец дрона машину не терял');
});

test('сбитая ракета не попадает в таблицу игроков', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    '玩家十四号 (Панцирь-С1) уничтожил weapons/us_agm_88a/short',
    // Живой случай: сырой идентификатор боеприпаса вместо ника.
    'Ally (Тунгуска) уничтожил 130mm_9m120_1',
    'Ally (Тунгуска) уничтожил 130mm_9m120_1',
  ]);
  assert.equal(find(snap, 'weapons/us_agm_88a/short'), undefined);
  assert.equal(find(snap, '130mm_9m120_1'), undefined);
  assert.equal(find(snap, '玩家十四号').kills, 0);
  assert.equal(find(snap, 'Ally').kills, 0, 'за сбитую ракету фраг не идёт');
});

test('ник с подчёркиваниями за сущность не принимается', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Me (Т-80) уничтожил cool_guy_1 (M1A2)',
    'Me (Т-80) уничтожил killman20 (Leopard)',
    'Me (Т-80) уничтожил 130mm_9m120_1',
  ]);
  assert.ok(find(snap, 'cool_guy_1'), 'обычный ник остаётся игроком');
  assert.ok(find(snap, 'killman20'), 'ник с цифрами остаётся игроком');
  assert.equal(find(snap, '130mm_9m120_1'), undefined);
});

test('живое: «нанёс критическое повреждение» — урон, а не фраг', () => {
  const s = new BattleState('Me');
  const snap = feed(s, [
    '=6dog9= Ник (CS/SA5) нанёс критическое повреждение Враг (Type 90)',
  ]);
  assert.deepEqual(snap.unparsed, []);
  assert.equal(find(snap, '=6dog9= Ник').kills, 0);
  assert.equal(find(snap, 'Враг').deaths, 0);
  assert.equal(find(snap, 'Враг').currentVehicle, 'Type 90');
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

test('командный чат определяет союзника, а его жертву — противником', () => {
  const s = new BattleState('Me');
  feed(s, [
    'Me (Т-80) уничтожил Foe (M1A2)',
    // Эта пара ни с кем не пересеклась — по кил-фиду команда неизвестна.
    'Talker (Leopard 2PL) уничтожил Silent (Т-72)',
  ]);
  assert.equal(find(s.snapshot(), 'Talker').team, 'unknown');

  s.ingestChat({ sender: 'Talker', mode: 'Команда', msg: 'Воздух!' });
  const snap = s.snapshot();
  assert.equal(find(snap, 'Talker').team, 'ally', 'писал в командный чат — свой');
  assert.equal(find(snap, 'Silent').team, 'enemy', 'его жертва — противник');
});

test('команды раскрашиваются по чату, даже если меня ещё нет в кил-фиде', () => {
  const s = new BattleState('Me');
  // Начало боя: я ещё никого не убил и меня не убили.
  feed(s, ['Mate (Т-80) уничтожил Foe (M1A2)', 'Foe2 (Leopard) уничтожил Mate2 (Т-72)']);
  assert.equal(s.snapshot().selfSeen, false);
  assert.equal(find(s.snapshot(), 'Mate').team, 'unknown');

  s.ingestChat({ sender: 'Mate', mode: 'Команда', msg: 'иду на точку' });
  const snap = s.snapshot();
  assert.equal(snap.selfSeen, false, 'меня по-прежнему нет в фиде');
  assert.equal(find(snap, 'Mate').team, 'ally');
  assert.equal(find(snap, 'Foe').team, 'enemy', 'жертва союзника — противник');
});

test('общий чат команду не выдаёт', () => {
  const s = new BattleState('Me');
  feed(s, ['Me (Т-80) уничтожил Foe (M1A2)', 'Talker (Leopard) уничтожил X (Т-72)']);
  s.ingestChat({ sender: 'Talker', mode: 'Все', msg: 'gg' });
  assert.equal(find(s.snapshot(), 'Talker').team, 'unknown');
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

  // Владелец сбитого дрона в таблицу не попал, фраг за дрон не начислен.
  assert.equal(find(snap, 'PlayerFifteen69'), undefined);
  assert.equal(find(snap, '玩家十四号').kills, 0);
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

test('значок игры перед ником не заводит второго игрока', () => {
  // Живой случай: строку про убийство игра пишет без значка, а строку про
  // награду — со значком. Раньше это давало две записи: фраги у одной,
  // награда у другой, и обе висели в таблице рядом.
  const s = new BattleState('Me');
  const snap = feed(s, [
    '^ILAZ^ DeathVision (M1A2 SEP V2) уничтожил Foe (Т-80БВМ)',
    '⋇^ILAZ^ DeathVision (M1A2 SEP V2) ударил первым!',
  ]);

  const rows = snap.players.filter((p) => p.nick.includes('DeathVision'));
  assert.equal(rows.length, 1, 'игрок должен быть один');
  assert.equal(rows[0].nick, '^ILAZ^ DeathVision', 'остаётся написание из кил-фида');
  assert.equal(rows[0].kills, 1);
  assert.equal(rows[0].awards.length, 1);
});

test('ник из одних значков не сливается с другим таким же', () => {
  // Свёртка выбрасывает всё, кроме букв и цифр; у таких ников она пустая, и
  // сравнивать по ней нельзя — иначе они схлопнутся в одного человека.
  const s = new BattleState('Me');
  const snap = feed(s, [
    '★★★ (T-34) уничтожил ⋇⋇⋇ (Tiger H1)',
  ]);
  assert.equal(snap.players.length, 2);
});

test('отряд из программы — якорь: команды видны до того, как я засветился', () => {
  // Ради этого друзья и заводились. Сокомандник, попавший в кил-фид раньше
  // меня, тянет за собой всех, кого он убил, — в противники, а всех, кого
  // убили вместе с ним, разбор доводит по цепочке.
  const s = new BattleState('Me');
  s.setKnownPlayers({ squad: ['Buddy'], friends: ['Buddy', 'Neutral'] });
  const snap = feed(s, ['Buddy (T-34) уничтожил Foe (Tiger H1)']);

  assert.equal(find(snap, 'Buddy').team, 'ally', 'отряд — своя сторона');
  assert.equal(find(snap, 'Foe').team, 'enemy', 'его жертва — противник');
  assert.equal(find(snap, 'Buddy').inSquad, true);
});

test('друг вне отряда помечается, но команду за него не додумывают', () => {
  const s = new BattleState('Me');
  s.setKnownPlayers({ squad: [], friends: ['Buddy'] });
  const snap = feed(s, ['Buddy (T-34) уничтожил Foe (Tiger H1)']);

  assert.equal(find(snap, 'Buddy').isFriend, true);
  // Друг вполне может играть против меня — записать его в союзники значило бы
  // раскрасить таблицу неправильно.
  assert.equal(find(snap, 'Buddy').team, 'unknown');
});

test('значки в нике не мешают узнать друга', () => {
  const s = new BattleState('Me');
  s.setKnownPlayers({ squad: ['^ILAZ^ DeathVision'], friends: [] });
  const snap = feed(s, ['⋇^ILAZ^ DeathVision (M1A2) уничтожил Foe (Т-80БВМ)']);
  assert.equal(find(snap, '⋇^ILAZ^ DeathVision').team, 'ally');
});

test('команды раскрашиваются в тот же миг, когда я впервые попал в кил-фид', () => {
  // Проверка от жалобы «раскидывает только после обновления состояния».
  // Замер показал обратное, и этот тест держит поведение: одной строки про
  // меня достаточно, чтобы разъехались ВСЕ, кто связан со мной цепочкой
  // убийств и повреждений, — а не только участники этой одной строки.
  const s = new BattleState('Me');
  const snap = feed(s, [
    'A1 (T-80) уничтожил B1 (M1A2)',
    'B1 (M1A2) поджёг A3 (БМПТ)',
    'A1 (T-80) уничтожил B3 (Strv)',
    // Первая и единственная строка про меня.
    'Me (Т-80БВМ) уничтожил B1 (M1A2)',
  ]);

  assert.equal(find(snap, 'Me').team, 'ally');
  assert.equal(find(snap, 'B1').team, 'enemy', 'моя жертва');
  assert.equal(find(snap, 'A1').team, 'ally', 'убивал мою жертву — значит со мной');
  assert.equal(find(snap, 'A3').team, 'ally', 'его жёг мой противник');
  assert.equal(find(snap, 'B3').team, 'enemy', 'его убил мой союзник');
});

test('несвязанная группа остаётся неопознанной — и это не ошибка', () => {
  // Двое дерутся между собой в стороне и ни разу не пересеклись ни со мной,
  // ни с моими. Кто из них на моей стороне, из кил-фида НЕ следует: команд
  // две, и обе половины такой пары равновероятны. Додумывать тут нельзя —
  // ошибка раскрасит таблицу неправильно, а это хуже честного «не знаю».
  const s = new BattleState('Me');
  const snap = feed(s, [
    'Me (Т-80БВМ) уничтожил Foe (M1A2)',
    'C1 (Puma) уничтожил D1 (Bradley)',
  ]);
  assert.equal(find(snap, 'Foe').team, 'enemy');
  assert.equal(find(snap, 'C1').team, 'unknown');
  assert.equal(find(snap, 'D1').team, 'unknown');
  // Но внутри пары известно, что они друг против друга: стороны разные.
  assert.notEqual(find(snap, 'C1').side, find(snap, 'D1').side);
});

test('пользователи программы отмечаются и считаются, но команду не меняют', () => {
  const s = new BattleState('Me');
  const snap0 = feed(s, ['Me (Т-80) уничтожил Foe (M1A2)', 'Mate (ИС-2) уничтожил Foe2 (Leopard)']);
  // Пока не спрашивали — счётчика нет, и это не то же самое, что «никого нет».
  assert.equal(snap0.usersInBattle, 0);

  s.setKnownPlayers({ users: ['Foe', 'Mate'] });
  const snap = s.snapshot();

  assert.equal(find(snap, 'Foe').isUser, true);
  assert.equal(find(snap, 'Mate').isUser, true);
  assert.equal(find(snap, 'Foe2').isUser, false);
  assert.equal(snap.usersInBattle, 2, 'себя в счёт не берём');

  // Главное: аккаунт в программе не говорит о команде ничего. Foe остаётся
  // противником, Mate — неопознанным, ровно как было.
  assert.equal(find(snap, 'Foe').team, 'enemy');
  assert.equal(find(snap, 'Mate').team, 'unknown');
});

test('свои в бою узнаются несмотря на значки игры в нике', () => {
  const s = new BattleState('Me');
  feed(s, ['Me (Т-80) уничтожил ⋇^ILAZ^ DeathVision (M1A2)']);
  // Сервер вернул ник в том написании, в каком его прислали, а в таблице он
  // мог осесть в другом. Свёртка та же, что и везде, — узнаёт.
  s.setKnownPlayers({ users: ['^ILAZ^ DeathVision'] });
  assert.equal(find(s.snapshot(), '⋇^ILAZ^ DeathVision').isUser, true);
});

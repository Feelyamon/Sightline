'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const BASE_HOST = '127.0.0.1';
const BASE_PORT = 8111;
const POLL_MS = 1000;
const TIMEOUT_MS = 1500;
// Сколько неудачных тиков подряд терпим, прежде чем сказать «игра не запущена».
const OFFLINE_AFTER = 3;
// Насколько долгим должен быть перерыв «не в бою», чтобы считать его выходом в
// ангар, а не экраном респавна. Даже если перерыв окажется короче, новый бой
// всё равно опознается по падению времени в кил-фиде.
const IDLE_NEW_BATTLE_MS = 90_000;
// Допуск на неточность времени в журнале: настоящая смена боя даёт откат в
// сотни секунд, поэтому мелкие колебания новым боем не считаем.
const TIME_DROP_TOLERANCE = 15;

// Node 19+ по умолчанию держит keep-alive соединения. Встроенный веб-сервер
// War Thunder переиспользуемый сокет закрывает, и следующий запрос падает с
// ECONNRESET — из-за этого статус мигал «в бою / игра не запущена».
// Каждый запрос идёт по своему соединению.
const agent = new http.Agent({ keepAlive: false, maxSockets: 4 });

/** GET + JSON.parse. Реджектится и по сети, и по кривому телу — вызывающий решает. */
function getJson(pathname, { host = BASE_HOST, port = BASE_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      host,
      port,
      path: pathname,
      timeout: TIMEOUT_MS,
      agent,
      headers: { Connection: 'close' },
    };
    const req = http.get(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} на ${pathname}`));
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Не JSON от ${pathname}: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Таймаут ${pathname}`)));
    req.on('error', reject);
  });
}

/**
 * Опрашивает локальный веб-сервер War Thunder.
 *
 * События:
 *   'status'  ({ status: 'offline'|'idle'|'battle', detail })
 *   'damage'  (entry)        — новая запись кил-фида
 *   'reset'   ()             — начался новый бой
 *   'error'   (Error)        — только неожиданные ошибки, не «игра выключена»
 */
class WtClient extends EventEmitter {
  constructor({ mock = false, mockFile = null, host = BASE_HOST, port = BASE_PORT } = {}) {
    super();
    this.mock = mock;
    // Адрес настраивается только ради тестов с подставным сервером.
    this.host = host;
    this.port = port;
    // По умолчанию проигрываем запись реального боя — на ней видно все статусы.
    this.mockFile = mockFile || path.join(__dirname, '..', '..', 'fixtures', 'hudmsg-live.json');
    this.timer = null;
    this.lastEvt = 0;
    this.lastDmg = 0;
    this.status = 'offline';
    this.inBattle = false;
    this.mockQueue = null;
    this.failures = 0;
    this.mapSignature = null;
    this.started = false;
    this.lastTime = -1;
    this.lastChatId = 0;
    this.idleSince = null;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setStatus(status, detail = '') {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', { status, detail });
  }

  /**
   * Курсор здесь НЕ обнуляется: id в журнале сквозные по всей сессии игры и в
   * новом бою не начинаются заново. Обнуление заставило бы перечитать чужие
   * бои из скользящего окна.
   */
  beginNewBattle() {
    this.lastTime = -1;
    this.lastChatId = 0;
    this.emit('reset');
  }

  /**
   * Одиночная сетевая ошибка — норма: сервер игры иногда рвёт соединение.
   * Статус «игра не запущена» ставим только после нескольких неудач подряд,
   * иначе он мигает на ровном месте.
   */
  noteFailure(detail) {
    this.failures++;
    if (this.failures >= OFFLINE_AFTER) {
      this.inBattle = false;
      this.setStatus('offline', detail);
    }
  }

  async tick() {
    if (this.mock) return this.tickMock();

    // map_info говорит, идёт ли бой, и по нему же опознаётся смена боя.
    let valid = false;
    let signature = null;
    try {
      const info = await getJson('/map_info.json', { host: this.host, port: this.port });
      valid = info?.valid !== false;
      // Отпечаток боя: счётчик генерации карты плюс её геометрия. Только на
      // курсоры hudmsg полагаться нельзя — в новом бою нумерация начинается
      // заново, сервер на старый lastDmg отдаёт пустоту, и приложение
      // продолжало показывать прошлый бой.
      signature = JSON.stringify([
        info?.map_generation ?? null,
        info?.grid_zero ?? null,
        info?.map_max ?? null,
        info?.grid_steps ?? null,
      ]);
      this.failures = 0;
    } catch (e) {
      this.noteFailure('War Thunder не запущен или локальный API недоступен');
      return;
    }

    // valid=false бывает не только в ангаре, но и на экране выбора техники
    // после смерти. Поэтому сам по себе переход «не в бою → в бою» новым боем
    // НЕ считается — иначе таблица обнулялась после каждого респавна.
    // Сбрасываем только после долгого перерыва; короткий — это респавн.
    if (valid) {
      const gap = this.idleSince ? Date.now() - this.idleSince : 0;
      if (gap >= IDLE_NEW_BATTLE_MS) this.beginNewBattle();
      this.idleSince = null;
      this.inBattle = true;
      this.mapSignature = signature;
    } else if (this.inBattle) {
      this.inBattle = false;
      this.idleSince = this.idleSince || Date.now();
    }
    // Исход боя лежит в mission.json: пока идёт бой там "running", а по
    // окончании появляется результат. Точные значения зависят от режима,
    // поэтому строку отдаём как есть, а трактует её battle-result.js.
    try {
      const mission = await getJson('/mission.json', { host: this.host, port: this.port });
      if (mission?.status) this.emit('mission', mission);
    } catch {
      // Не критично: без исхода бой всё равно запишется.
    }

    this.setStatus(valid ? 'battle' : 'idle', valid ? '' : 'В ангаре — ждём начала боя');
    if (!valid) return;

    // Журнал запрашиваем целиком, а не с курсора. Курсорный запрос в новом бою
    // возвращал пустоту (нумерация начинается заново и оказывается ниже
    // курсора), и приложение продолжало показывать прошлый бой. Журнал одного
    // боя — сотни строк, перечитывать его раз в секунду ничего не стоит.
    let hud;
    try {
      hud = await getJson('/hudmsg?lastEvt=0&lastDmg=0', { host: this.host, port: this.port });
      this.failures = 0;
    } catch (e) {
      this.noteFailure(e.message);
      return;
    }

    const damage = Array.isArray(hud?.damage) ? hud.damage : [];
    const events = Array.isArray(hud?.events) ? hud.events : [];

    // Журнал — скользящее окно на НЕСКОЛЬКО боёв сразу, а id сквозные по всей
    // сессии игры и в новом бою не обнуляются. Единственный надёжный признак
    // границы — поле time (секунды с начала боя): внутри боя оно только растёт,
    // а на стыке падает.

    // Первый тик: приложение могло запуститься посреди сессии. Отматываем
    // курсор к началу текущего боя, чтобы не втянуть предыдущие.
    if (!this.started) {
      this.started = true;
      let start = 0;
      for (let i = 1; i < damage.length; i++) {
        if (typeof damage[i]?.time === 'number' && damage[i].time < damage[i - 1].time) start = i;
      }
      const prev = damage[start - 1];
      if (prev && typeof prev.id === 'number') this.lastDmg = prev.id;
    }

    for (const d of damage) {
      if (typeof d?.id !== 'number') continue;
      if (d.id <= this.lastDmg) continue; // уже отдавали
      this.lastDmg = d.id;

      // Время пошло назад — начался следующий бой. Сначала сброс, потом эта
      // запись уходит уже в новое состояние.
      if (typeof d.time === 'number') {
        if (d.time < this.lastTime - TIME_DROP_TOLERANCE) this.beginNewBattle();
        this.lastTime = Math.max(this.lastTime, d.time);
      }
      this.emit('damage', d);
    }
    for (const e of events) {
      if (typeof e?.id === 'number') this.lastEvt = Math.max(this.lastEvt, e.id);
    }

    // Командный чат виден только своей команде, поэтому его отправители —
    // гарантированно союзники. Это второй, независимый от кил-фида источник
    // для определения команд.
    try {
      const chat = await getJson(`/gamechat?lastId=${this.lastChatId}`, {
        host: this.host,
        port: this.port,
      });
      for (const m of Array.isArray(chat) ? chat : []) {
        if (typeof m?.id === 'number') this.lastChatId = Math.max(this.lastChatId, m.id);
        if (m?.sender) this.emit('chat', m);
      }
    } catch {
      // Чат — приятное дополнение, без него всё работает.
    }
  }

  /** Мок-режим: проигрывает записанный бой по несколько строк за тик. */
  tickMock() {
    if (this.mockQueue === null) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.mockFile, 'utf8'));
        this.mockQueue = Array.isArray(raw) ? raw.slice() : (raw.damage || []).slice();
      } catch (e) {
        this.mockQueue = [];
        this.emit('error', new Error(`Не читается мок-файл: ${e.message}`));
      }
      this.beginNewBattle();
    }
    this.setStatus('battle', 'Мок-режим: воспроизведение записанного боя');
    for (let i = 0; i < 3 && this.mockQueue.length; i++) {
      this.emit('damage', this.mockQueue.shift());
    }
  }
}

module.exports = { WtClient, getJson };

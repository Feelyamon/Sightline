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
  constructor({ mock = false, mockFile = null } = {}) {
    super();
    this.mock = mock;
    // По умолчанию проигрываем запись реального боя — на ней видно все статусы.
    this.mockFile = mockFile || path.join(__dirname, '..', '..', 'fixtures', 'hudmsg-live.json');
    this.timer = null;
    this.lastEvt = 0;
    this.lastDmg = 0;
    this.status = 'offline';
    this.inBattle = false;
    this.mockQueue = null;
    this.failures = 0;
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

  beginNewBattle() {
    this.lastEvt = 0;
    this.lastDmg = 0;
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

    // map_info говорит, идёт ли бой; заодно ловим смену боя.
    let valid = false;
    try {
      const info = await getJson('/map_info.json');
      valid = info?.valid !== false;
      this.failures = 0;
    } catch (e) {
      this.noteFailure('War Thunder не запущен или локальный API недоступен');
      return;
    }

    if (valid && !this.inBattle) {
      this.inBattle = true;
      this.beginNewBattle();
    } else if (!valid && this.inBattle) {
      this.inBattle = false;
    }
    this.setStatus(valid ? 'battle' : 'idle', valid ? '' : 'В ангаре — ждём начала боя');
    if (!valid) return;

    let hud;
    try {
      hud = await getJson(`/hudmsg?lastEvt=${this.lastEvt}&lastDmg=${this.lastDmg}`);
      this.failures = 0;
    } catch (e) {
      this.noteFailure(e.message);
      return;
    }

    const damage = Array.isArray(hud?.damage) ? hud.damage : [];
    const events = Array.isArray(hud?.events) ? hud.events : [];

    // Курсор поехал назад — игра начала новый бой между тиками.
    const minId = damage.reduce((m, d) => (typeof d?.id === 'number' ? Math.min(m, d.id) : m), Infinity);
    if (Number.isFinite(minId) && minId < this.lastDmg) {
      this.beginNewBattle();
    }

    for (const d of damage) {
      if (typeof d?.id === 'number') this.lastDmg = Math.max(this.lastDmg, d.id);
      this.emit('damage', d);
    }
    for (const e of events) {
      if (typeof e?.id === 'number') this.lastEvt = Math.max(this.lastEvt, e.id);
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

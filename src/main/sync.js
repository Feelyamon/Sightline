'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Отправка боёв на сервер.
//
// Между «бой записан локально» и «бой уехал» стоит очередь на диске, и это не
// перестраховка: сервер может лежать, интернет — пропасть, а программа —
// закрыться в любой момент. Бой, потерянный из-за того, что в момент его
// окончания не было сети, не восстановить ничем: кил-фид того боя игра больше
// не отдаст.
//
// Чего здесь СОЗНАТЕЛЬНО нет: загрузки накопленной до регистрации истории.
// Иначе любой мог бы нарисовать себе тысячу побед в локальной базе и потом
// «синхронизировать» их. В очередь бой попадает в момент своего окончания и
// только если человек уже вошёл в аккаунт.

const FILE = 'outbox.json';
// Сколько боёв уходит одним запросом. Столько же принимает сервер.
const BATCH = 50;
// Как часто пробуем отправить накопленное.
const FLUSH_MS = 60_000;
// Потолок очереди. Если сервера нет неделю, очередь не должна расти без конца;
// выбрасываем самые старые — свежие бои полезнее старых.
const MAX_QUEUE = 500;

class Sync {
  /**
   * @param {string} userDataDir
   * @param {import('./account').Account} account
   * @param {import('./db').Db} db
   */
  constructor(userDataDir, account, db) {
    this.file = path.join(userDataDir, FILE);
    this.account = account;
    this.db = db;
    /** Позвать, когда отметки доверия изменились: список боёв надо перерисовать. */
    this.onTrustChanged = () => {};
    /** @type {Map<number, object>} локальный id боя → что отправлять */
    this.queue = new Map();
    this.timer = null;
    this.sending = false;
    this.lastError = null;
    this.load();
  }

  // --- Очередь на диске ---------------------------------------------------

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) for (const [id, payload] of raw) this.queue.set(id, payload);
    } catch {
      // Файла нет или он испорчен — начинаем с пустой очереди. Ронять из-за
      // этого программу нельзя: она полезна и без сервера.
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.queue]), 'utf8');
    } catch (e) {
      console.error('не удалось сохранить очередь боёв:', e.message);
    }
  }

  /**
   * Кладёт бой в очередь. Ключ — локальный id: пока бой идёт, программа
   * дописывает ту же запись, и в очереди должна остаться последняя версия, а
   * не пять промежуточных.
   */
  enqueue(localId, payload) {
    if (!this.account.isSignedIn || typeof localId !== 'number') return;
    this.queue.set(localId, payload);
    while (this.queue.size > MAX_QUEUE) {
      // Map хранит порядок вставки, поэтому первый ключ — самый старый.
      this.queue.delete(this.queue.keys().next().value);
    }
    this.save();
  }

  state() {
    return { pending: this.queue.size, error: this.lastError };
  }

  // --- Отправка -----------------------------------------------------------

  async flush() {
    if (this.sending || !this.queue.size || !this.account.isSignedIn) return this.state();
    this.sending = true;
    try {
      // Отправляем пачками, пока очередь не кончится или пока не упрёмся.
      while (this.queue.size) {
        const chunk = [...this.queue].slice(0, BATCH);
        const answer = await this.account.request('/battles', {
          method: 'POST',
          body: chunk.map(([, payload]) => payload),
          auth: true,
        });

        // Ключ боя считает сервер — по составу. Запоминаем его рядом с
        // локальной записью: без него потом нельзя спросить, чем кончилась
        // сверка. Порядок ответов совпадает с порядком отправленного.
        (answer?.results || []).forEach((r, i) => {
          const localId = chunk[i]?.[0];
          if (r?.battle_key && typeof localId === 'number') {
            this.db.setBattleKey(localId, r.battle_key);
          }
        });

        // Из очереди убираем только после ответа сервера. Ответ потерялся —
        // отправим ещё раз: повтор сервер узнаёт по ключу боя и не задваивает.
        for (const [id] of chunk) this.queue.delete(id);
        this.save();
        this.lastError = null;
      }
      await this.refreshTrust();
    } catch (e) {
      this.lastError = e.message;
      // Сеть пропала или сервер отказал — очередь остаётся, попробуем позже.
      // Кроме одного случая: если сборка устарела, повторять бессмысленно —
      // сервер будет отказывать, пока человек не обновится.
      if (e.status === 426) this.stop();
    } finally {
      this.sending = false;
    }
    return this.state();
  }

  /**
   * Спрашивает, чем кончилась сверка присланных боёв.
   *
   * Спрашиваем, а не ждём сообщения от сервера: свидетель может прислать свою
   * запись через час после боя, держать ради этого соединение открытым
   * незачем. Подтверждённые бои не переспрашиваем — подтверждение не
   * отзывается.
   */
  async refreshTrust() {
    if (!this.account.isSignedIn) return 0;
    const keys = this.db.battleKeysToRefresh();
    if (!keys.length) return 0;
    try {
      const rows = await this.account.request('/battles/trust', {
        method: 'POST',
        body: { keys },
        auth: true,
      });
      const changed = this.db.applyTrust(rows || []);
      if (changed) this.onTrustChanged();
      return changed;
    } catch {
      // Сервера нет — отметки останутся прежними. Ничего страшного: они и так
      // меняются редко, а показывать вместо них ошибку не за что.
      return 0;
    }
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.flush();
    // Даже если очередь пуста, сверка могла измениться с прошлого запуска.
    this.refreshTrust();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Готовит бой к отправке.
 *
 * Никаких агрегатов: только то, что программа видела в кил-фиде. Винрейт,
 * КДА за период и «всего боёв» сервер считает сам — если агрегат можно
 * прислать, его однажды пришлют накрученным.
 *
 * @param {object} snapshot - снимок боя из BattleState
 * @param {object} opts - { startedAt, endedAt, result, cancelReason }
 */
function battlePayload(snapshot, opts) {
  const me = snapshot.players.find((p) => p.isSelf);
  const startedAt = opts.startedAt || Date.now();
  const endedAt = opts.endedAt || Date.now();

  return {
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    // Сдвиг НА МОМЕНТ БОЯ, а не «пояс профиля»: перевод часов и переезд
    // меняют сдвиг, и прошлые бои от этого съезжать не должны.
    // getTimezoneOffset даёт минуты в обратную сторону, отсюда минус.
    tz_offset: -new Date(startedAt).getTimezoneOffset(),
    duration_sec: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
    my_kills: me?.kills || 0,
    my_deaths: me?.deaths || 0,
    my_assists: me?.assists || 0,
    result: opts.result || 'unknown',
    cancelled: !!opts.cancelReason,
    cancel_reason: opts.cancelReason || null,
    players: snapshot.players.map((p) => ({
      nick: p.nick,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      left_battle: p.status === 'left',
      vehicles: (p.sorties || [])
        .filter((s) => s.vehicle)
        .map((s) => ({ vehicle: s.vehicle, kills: s.kills || 0, destroyed: !!s.destroyed })),
    })),
  };
}

module.exports = { Sync, battlePayload };

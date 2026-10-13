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
// Чего здесь СОЗНАТЕЛЬНО нет: загрузки накопленной до входа истории.
// Иначе любой мог бы нарисовать себе тысячу побед в локальной базе и потом
// «синхронизировать» их. Правила, которые это обеспечивают:
//
//   · бой, записанный без входа, — только локальный, навсегда. Решает момент
//     НАЧАЛА записи: бой, начатый гостем и законченный после входа, всё равно
//     гостевой (см. recording() ниже);
//   · вход в аккаунт очередь не разбирает, а обнуляет: всё, что лежало в ней
//     до этого входа, к новой сессии не относится;
//   · выход тоже обнуляет очередь: следующим войти может другой человек, и
//     чужие бои уехали бы под его именем;
//   · бои уходят по одному: один бой — один запрос, не больше одного запроса
//     за раз. Свежий бой отправляется сразу по окончании, накопившиеся без
//     сети — по одному в минуту. Пачкой в пятьдесят боёв одномоментно
//     приходит только накрутка, и сервер не должен видеть от честной
//     программы того же, что от поддельной.
//
// С 1.0.4 бои бывают ещё и пришедшими с сервера (история аккаунта, см.
// history-pull.js) и восстановленными из резервной копии (restore.js). Ни те,
// ни другие сюда не попадают: очередь пополняет только запись боя на этой
// машине, а enqueue вдобавок спрашивает у базы, можно ли отправлять именно эту
// запись (Db.uploadAllowed).
//
// До 1.0.2 очередь была массивом [id, бой] без отметки сессии и после входа
// отправлялась пачками по 50. Такая очередь при запуске выбрасывается: чья
// это сессия, по ней уже не узнать.

const FILE = 'outbox.json';
// Формат файла очереди. Старый формат (голый массив) не читается намеренно.
const FORMAT = 2;
// Сколько боёв уходит одним запросом. Сервер принимает и больше, но см. выше.
const PER_REQUEST = 1;
// Как часто пробуем отправить накопленное. Заодно это и темп разбора очереди:
// один бой за попытку.
const FLUSH_MS = 60_000;
// Потолок очереди. Если сервера нет неделю, очередь не должна расти без конца;
// выбрасываем самые старые — свежие бои полезнее старых. При темпе «бой в
// минуту» сотня разбирается за пару часов работы программы.
const MAX_QUEUE = 100;

/** Случайная метка сессии. Не секрет — только граница «до/после входа». */
const newSessionId = () => require('node:crypto').randomBytes(8).toString('hex');

/**
 * Можно ли отправить бой, записанный в такой сессии.
 *
 * Всё правило — в этой чистой функции, ради тестов. Бой отправляется, только
 * если запись началась под входом и с тех пор не было ни выхода, ни нового
 * входа (метка сессии та же).
 *
 * @param {{session: string|null}} recording - что было на начале боя
 * @param {{session: string|null, signedIn: boolean}} now - что сейчас
 */
function canUpload(recording, now) {
  return !!(recording?.session && now?.signedIn && now.session === recording.session);
}

/** Отказ, который повтором не исправить: 4xx, кроме 401/408/426/429. */
function isPermanentRejection(status) {
  return Number.isInteger(status) && status >= 400 && status < 500
    && ![401, 408, 426, 429].includes(status);
}

class Sync {
  /**
   * @param {string} userDataDir
   * @param {import('./account').Account} account
   * @param {import('./db').Db} db
   * @param {object} [opts]
   * @param {Function} [opts.setTimer] - подменяется в тестах
   * @param {Function} [opts.clearTimer]
   */
  constructor(userDataDir, account, db, { setTimer = setInterval, clearTimer = clearInterval } = {}) {
    this.file = path.join(userDataDir, FILE);
    this.account = account;
    this.db = db;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** Позвать, когда отметки доверия изменились: список боёв надо перерисовать. */
    this.onTrustChanged = () => {};
    /** @type {Map<number, {payload: object, session: string}>} локальный id → бой */
    this.queue = new Map();
    // Метка текущей сессии входа. null — входа нет.
    this.session = null;
    this.timer = null;
    this.sending = false;
    this.lastError = null;
    this.load();
  }

  // --- Сессия -------------------------------------------------------------

  /**
   * Запомнить, в какой сессии началась запись боя. Зовётся на начале боя;
   * результат потом отдаётся в enqueue и isGuest.
   */
  recording() {
    return { session: this.account.isSignedIn ? this.session : null };
  }

  /** Бой из этой записи остаётся только на этой машине. */
  isGuest(recording) {
    return !canUpload(recording, { session: this.session, signedIn: this.account.isSignedIn });
  }

  /**
   * Человек только что вошёл. Новая сессия, пустая очередь: всё, что было до
   * входа, на сервер не поедет — ни гостевые бои, ни остатки прошлой сессии.
   */
  beginSession() {
    if (!this.account.isSignedIn) return;
    this.session = newSessionId();
    this.queue.clear();
    this.save();
  }

  /** Человек вышел (сам, со всех устройств, или сервер закрыл сессию). */
  endSession() {
    this.session = null;
    this.queue.clear();
    this.save();
  }

  // --- Очередь на диске ---------------------------------------------------

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // Файла нет или он испорчен — начинаем с пустой очереди. Ронять из-за
      // этого программу нельзя: она полезна и без сервера.
    }
    // Сессия переживает перезапуск программы, если человек остался в
    // аккаунте: бой, не уехавший вчера из-за сети, уедет сегодня.
    if (raw?.format === FORMAT && this.account.isSignedIn && typeof raw.session === 'string') {
      this.session = raw.session;
      for (const item of Array.isArray(raw.items) ? raw.items : []) {
        if (typeof item?.id === 'number' && item.session === this.session && item.payload) {
          this.queue.set(item.id, { payload: item.payload, session: item.session });
        }
      }
      return;
    }
    // Вход сохранён, а метки нет (первый запуск после обновления или файл
    // потерян) — заводим новую. Очередь при этом пустая, см. шапку файла.
    this.session = this.account.isSignedIn ? newSessionId() : null;
    if (raw !== null) this.save();
  }

  save() {
    try {
      const items = [...this.queue].map(([id, item]) => ({ id, ...item }));
      fs.writeFileSync(
        this.file,
        JSON.stringify({ format: FORMAT, session: this.session, items }),
        'utf8'
      );
    } catch (e) {
      console.error('не удалось сохранить очередь боёв:', e.message);
    }
  }

  /**
   * Кладёт бой в очередь и сразу пробует отправить.
   *
   * Ключ — локальный id. Один бой программа может записать несколько раз
   * (выход в ангар, потом начало следующего боя), и при перезаписи у строки
   * в базе меняется id. Поэтому прежние записи того же боя (то же время
   * начала) из очереди убираются: иначе один бой ушёл бы дважды.
   *
   * @returns {boolean} принят ли бой в очередь
   */
  enqueue(localId, payload, recording) {
    if (typeof localId !== 'number' || !payload) return false;
    if (!canUpload(recording, { session: this.session, signedIn: this.account.isSignedIn })) {
      return false;
    }
    // Вторая проверка — по самой записи в базе: бой, пришедший с сервера или
    // восстановленный из копии, не уходит никогда, кто бы его ни подал сюда.
    if (typeof this.db.uploadAllowed === 'function' && !this.db.uploadAllowed(localId)) {
      return false;
    }
    for (const [id, item] of this.queue) {
      if (item.payload?.started_at === payload.started_at) this.queue.delete(id);
    }
    this.queue.set(localId, { payload, session: this.session });
    while (this.queue.size > MAX_QUEUE) {
      // Map хранит порядок вставки, поэтому первый ключ — самый старый.
      this.queue.delete(this.queue.keys().next().value);
    }
    this.save();
    // Свежий бой уходит сразу, а не через минуту. Если перед ним в очереди
    // что-то есть, уйдёт оно, а этот — следующим тиком: по одному.
    this.flush();
    return true;
  }

  state() {
    return { pending: this.queue.size, error: this.lastError };
  }

  // --- Отправка -----------------------------------------------------------

  /** Один запрос, один бой. Остальное — следующими тиками. */
  async flush() {
    if (this.sending || !this.queue.size || !this.account.isSignedIn || !this.session) {
      return this.state();
    }
    this.sending = true;
    // Что именно ушло этим запросом — для окончательного отказа ниже. Не
    // пересчитываем в catch: за время запроса в очередь мог встать новый бой,
    // который ещё никуда не отправлялся.
    let sentIds = [];
    try {
      const session = this.session;
      const chunk = [...this.queue]
        .filter(([, item]) => item.session === session)
        .slice(0, PER_REQUEST);
      if (!chunk.length) return this.state();
      sentIds = chunk.map(([id]) => id);
      const answer = await this.account.request('/battles', {
        method: 'POST',
        body: chunk.map(([, item]) => item.payload),
        auth: true,
      });

      // Пока шёл запрос, человек мог выйти или войти заново. Очередь тогда уже
      // обнулена, и отметки в базу не пишем: это не та сессия.
      if (this.session !== session) return this.state();

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
      await this.refreshTrust();
    } catch (e) {
      this.lastError = e.message;
      // Сеть пропала или сервер временно отказал — очередь остаётся, попробуем
      // позже. Если сборка устарела, повторять бессмысленно — сервер будет
      // отказывать, пока человек не обновится.
      if (e.status === 426) this.stop();
      // Окончательный отказ (4xx, кроме «войдите заново», «не дождались»,
      // «обновитесь» и «слишком часто») — этот бой сервер не примет никогда.
      // Оставь его в очереди — и он навсегда встанет первым и не пропустит
      // за собой ни одного следующего. Убираем отправленные, остальные пойдут.
      else if (isPermanentRejection(e.status)) {
        for (const id of sentIds) this.queue.delete(id);
        this.save();
      }
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
    this.timer = this.setTimer(() => this.flush(), FLUSH_MS);
    this.flush();
    // Даже если очередь пуста, сверка могла измениться с прошлого запуска.
    this.refreshTrust();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
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

module.exports = {
  isPermanentRejection, Sync, battlePayload, canUpload, PER_REQUEST, FLUSH_MS, MAX_QUEUE };

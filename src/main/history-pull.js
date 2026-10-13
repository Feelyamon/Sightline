'use strict';

// История боёв аккаунта — с сервера в локальную базу.
//
// Зачем. До 1.0.4 история жила только в battles.db на этом компьютере: после
// переустановки или на новом компьютере список был пуст, хотя бои аккаунта
// лежат на сервере. Теперь после входа (и по кнопке «Обновить с сервера» во
// вкладке «Бои», и при запуске, если вход сохранён) программа забирает их.
//
// Как:
//   · GET /v1/battles/mine страницами, от новых к старым, по одному запросу
//     на страницу и с паузой между страницами — сервер не должен видеть от
//     программы пачку запросов разом;
//   · остановка, как только страница целиком состоит из уже известных боёв:
//     дальше идёт то, что уже было подтянуто раньше (или записано здесь);
//   · бой, которого здесь нет, пишется с origin='server', номером аккаунта и
//     отметкой доверия сервера. Обратно на сервер он не уходит НИКОГДА —
//     очередь отправки пополняет только запись боя на этой машине, а
//     Db.uploadAllowed отказывает всему, что записано не здесь;
//   · без входа не делается ничего. Выход посреди листания обрывает его, и
//     уже полученная страница не пишется: она могла бы лечь под чужим входом.
//
// Чья история на экране после смены аккаунта — см. Db.setViewer: бои другого
// аккаунта не удаляются, а прячутся до его возвращения.

const PAGE_SIZE = 50;
// Пауза между страницами. Вся история — до 500 боёв, то есть до десяти
// страниц: полминуты на первый раз и один запрос во все следующие.
const PAUSE_MS = 2000;
// Страховка от бесконечного листания, если сервер вдруг начнёт отдавать один
// и тот же курсор: 500 боёв на сервере — это 10 страниц по 50.
const MAX_PAGES = 15;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Остановиться ли после этой страницы. Чистая функция ради тестов.
 * @param {{battles: Array, next_before: string|null}} page - ответ сервера
 * @param {{known: number, invalid: number}} merged - что сделала с ней база
 */
function stopAfter(page, merged) {
  const n = Array.isArray(page?.battles) ? page.battles.length : 0;
  if (!n) return 'end';
  // «Только уже известные»: битые записи (invalid) новыми не считаются.
  if (merged.known + merged.invalid >= n) return 'caught-up';
  if (!page.next_before) return 'end';
  return null;
}

class HistoryPull {
  /**
   * @param {import('./account').Account} account
   * @param {import('./db').Db} db
   * @param {object} [opts]
   * @param {(ms: number) => Promise<void>} [opts.sleep] - подменяется в тестах
   * @param {number} [opts.pauseMs]
   * @param {number} [opts.pageSize]
   * @param {number} [opts.maxPages]
   */
  constructor(account, db, { sleep = sleepFor, pauseMs = PAUSE_MS, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
    this.account = account;
    this.db = db;
    this.sleep = sleep;
    this.pauseMs = pauseMs;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    /** Позвать, когда в базе появились бои или сменилась видимость. */
    this.onChanged = () => {};
    // Номер «поколения»: выход и новый вход его поднимают, и листание,
    // начатое при прежнем входе, видит это после каждого ответа.
    this.generation = 0;
    this.running = null;
    this.last = null;
  }

  /**
   * Человек только что вошёл. Показываем его историю сразу, если номер
   * аккаунта уже известен по прошлым входам; иначе прячем истории всех
   * аккаунтов, пока сервер не назовёт номер (первая же страница).
   */
  signedIn() {
    this.generation += 1;
    const login = this.account.state().login;
    const changed = this.db.setViewer(this.db.ownerForLogin(login));
    if (changed) this.onChanged();
  }

  /**
   * Человек вышел. Листание обрывается; что уже пришло — остаётся: это его
   * история на его компьютере. Видимость не меняется — см. Db.setViewer.
   */
  signedOut() {
    this.generation += 1;
  }

  /** Подтянуть историю. Второй вызов во время первого получает его же итог. */
  pull() {
    if (!this.account.isSignedIn) return Promise.resolve({ skipped: 'signed-out' });
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async run() {
    const generation = this.generation;
    const login = this.account.state().login;
    const total = { pages: 0, inserted: 0, known: 0, invalid: 0, stoppedBy: null };
    const stale = () =>
      generation !== this.generation || !this.account.isSignedIn || this.account.state().login !== login;

    let before = null;
    try {
      while (total.pages < this.maxPages) {
        if (total.pages > 0) await this.sleep(this.pauseMs);
        if (stale()) {
          total.stoppedBy = 'signed-out';
          break;
        }
        const query = `?limit=${this.pageSize}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
        const page = await this.account.request(`/battles/mine${query}`, { auth: true });
        // Пока шёл запрос, человек мог выйти или войти другим — тогда этот
        // ответ уже не про того, кто сейчас за программой.
        if (stale()) {
          total.stoppedBy = 'signed-out';
          break;
        }
        total.pages += 1;

        const ownerId = Number(page?.account_id);
        if (!Number.isInteger(ownerId)) throw new Error('сервер не назвал аккаунт');
        if (total.pages === 1) {
          this.db.rememberLogin(login, ownerId);
          if (this.db.viewer() !== ownerId && this.db.setViewer(ownerId)) this.onChanged();
        }

        const merged = this.db.mergeServerBattles(page.battles || [], ownerId);
        total.inserted += merged.inserted;
        total.known += merged.known;
        total.invalid += merged.invalid;
        if (merged.inserted) this.onChanged();

        const stop = stopAfter(page, merged);
        if (stop) {
          total.stoppedBy = stop;
          break;
        }
        before = page.next_before;
      }
      if (!total.stoppedBy) total.stoppedBy = 'max-pages';
      this.last = { ...total, at: Date.now(), error: null };
      return this.last;
    } catch (e) {
      // Сети нет, сервер старый (нет такого метода) или ответил не то — ничего
      // страшного: локальная история на месте, подтянем в следующий раз.
      this.last = { ...total, at: Date.now(), error: e.message };
      throw e;
    }
  }
}

module.exports = { HistoryPull, stopAfter, PAGE_SIZE, PAUSE_MS, MAX_PAGES };

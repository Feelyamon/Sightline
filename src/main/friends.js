'use strict';

// Друзья, их состояние и отряд в программе.
//
// Зачем это нужно — не про социальность. Друг в бою даёт вторую точку отсчёта
// для графа команд: кил-фид у всех одинаковый, различается только якорь, и
// каждый клиент знает лишь то, в какой команде он сам. Человек, про которого
// заранее известно, что он на моей стороне, достраивает картину сразу — не
// дожидаясь, пока цепочка убийств дотянется до меня.
//
// Отряд в ПРОГРАММЕ и отряд в ИГРЕ — разные вещи, и путать их нельзя. Игра
// состав отряда наружу не отдаёт вообще, пригласить в игровой отряд программа
// не может. Отряд здесь — это список, который человек собирает сам, и он же
// берёт на себя ответственность за то, что этот список соответствует
// действительности.

// Как часто сообщаем о себе. Тридцать секунд — компромисс: чаще незачем
// (кружок у друга не обязан обновляться мгновенно), реже — и «не в сети»
// начнёт зажигаться у тех, кто на месте.
const PING_MS = 30_000;
// Как часто перечитываем список друзей, пока открыто окно. Полминуты — тот же
// порядок; realtime тут не нужен, а держать соединение ради статусов дорого.
const REFRESH_MS = 30_000;
// Пока в воздухе висит приглашение, пингуем чаще: обычные полминуты означали бы,
// что окно у второго игрока всплывает спустя полминуты после нажатия, и он
// успевает решить, что ничего не пришло. Ускорение живёт минуту и само гаснет —
// держать частый опрос постоянно ради события, которое случается раз в вечер,
// незачем.
const FAST_PING_MS = 3_000;
const FAST_PING_WINDOW_MS = 60_000;

class Friends {
  /**
   * @param {import('./account').Account} account
   * @param {import('./settings').Settings} settings
   */
  constructor(account, settings) {
    this.account = account;
    this.settings = settings;
    /** @type {{friends: any[], incoming: any[], outgoing: any[], limit: number}} */
    this.data = { friends: [], incoming: [], outgoing: [], limit: 100 };
    this.timer = null;
    this.pingTimer = null;
    this.lastError = null;
    /** Приглашения в отряд, пришедшие мне. Живут только в памяти. */
    this.invites = [];
    /** До какого момента опрашиваем часто. */
    this.fastUntil = 0;
    this.fastTimer = null;
    /** @type {() => object} */
    this.snapshot = () => ({ status: 'hangar', kills: 0, deaths: 0, assists: 0 });
    /** @type {(payload: object) => void} */
    this.onChange = () => {};
    /** Позвать, когда список приглашений изменился. */
    this.onInvites = () => {};
  }

  /** Логины тех, кого человек считает своим отрядом в этой сессии игры. */
  get squad() {
    const raw = this.settings.get('squad');
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Игровые ники отряда. Именно они попадают в разбор боя как заведомо свои.
   *
   * Друг без заявленного игрового ника сюда не попадает: узнать его в кил-фиде
   * не по чему, и записывать в союзники наугад нельзя — ошибка здесь красит
   * всю таблицу неправильно.
   */
  squadNicks() {
    const inSquad = new Set(this.squad.map((l) => l.toLowerCase()));
    return this.data.friends
      .filter((f) => inSquad.has(String(f.login).toLowerCase()) && f.game_nick)
      .map((f) => f.game_nick);
  }

  /** Игровые ники всех друзей — для зелёной отметки в таблице боя. */
  friendNicks() {
    return this.data.friends.filter((f) => f.game_nick).map((f) => f.game_nick);
  }

  state() {
    return {
      ...this.data,
      invites: this.invites,
      squad: this.squad,
      error: this.lastError,
      signedIn: this.account.isSignedIn,
    };
  }

  // --- Работа с сервером --------------------------------------------------

  async refresh() {
    if (!this.account.isSignedIn) {
      this.data = { friends: [], incoming: [], outgoing: [], limit: 100 };
      this.lastError = null;
      this.onChange(this.state());
      return this.state();
    }
    try {
      this.data = await this.account.request('/friends', { auth: true });
      this.lastError = null;
    } catch (e) {
      // Сервер недоступен — показываем то, что знали, и говорим об этом.
      // Стирать список из-за пропавшей сети хуже, чем показать его устаревшим.
      this.lastError = e.message;
    }
    this.onChange(this.state());
    return this.state();
  }

  search(query) {
    return this.account.request(`/friends/search?q=${encodeURIComponent(query)}`, { auth: true });
  }

  async act(route, login) {
    await this.account.request(`/friends/${route}`, {
      method: 'POST',
      body: { login },
      auth: true,
    });
    return this.refresh();
  }

  /**
   * Сообщает серверу, где человек сейчас. «Не в сети» не отправляется никогда:
   * это не состояние, а тишина. Сообщение о выключении теряется всегда —
   * выключили свет, убили процесс, оборвалась сеть, — и полагаться на него
   * значит показывать друзьям в сети тех, кого нет.
   *
   * @param {{status: string, kills?: number, deaths?: number, assists?: number}} presence
   */
  async ping(presence) {
    if (!this.account.isSignedIn) return;
    if (presence.status !== 'battle' && presence.status !== 'hangar') return;
    try {
      const answer = await this.account.request('/presence', {
        method: 'POST',
        body: presence,
        auth: true,
      });
      this.takeInvites(Array.isArray(answer?.invites) ? answer.invites : []);
    } catch {
      // Пинг — не то, ради чего стоит беспокоить человека сообщением об
      // ошибке. Не дошёл — друзья увидят «не в сети», и это честно.
    }
  }

  /**
   * Приглашения из ответа сервера.
   *
   * Сообщаем наверх только когда набор изменился: пинг приходит раз в
   * несколько секунд, и дёргать окно на каждом значило бы пересобирать его
   * под пальцами у человека, который как раз тянется к кнопке.
   */
  takeInvites(list) {
    const было = this.invites.map((i) => i.id).join(',');
    const стало = list.map((i) => i.id).join(',');
    this.invites = list;
    if (было !== стало) {
      // Пока приглашение висит, держим частый опрос: ответ второго игрока
      // должен доехать до пригласившего примерно тогда же, когда он его дал.
      if (list.length) this.hurry();
      this.onInvites(list);
      this.onChange(this.state());
    }
  }

  /** Перейти на частый опрос на ближайшую минуту. */
  hurry() {
    this.fastUntil = Date.now() + FAST_PING_WINDOW_MS;
    if (this.fastTimer) return;
    this.fastTimer = setInterval(() => {
      if (Date.now() > this.fastUntil) {
        clearInterval(this.fastTimer);
        this.fastTimer = null;
        return;
      }
      this.ping(this.snapshot());
    }, FAST_PING_MS);
  }

  // --- Приглашения в отряд ------------------------------------------------

  /**
   * Позвать друга. Возвращает то, что сказал сервер: сколько держать кнопку
   * серой и сколько живёт приглашение. Оба числа приходят с сервера, а не
   * зашиты здесь, — подобрать их можно будет, не выпуская новую сборку.
   */
  async invite(login) {
    const answer = await this.account.request('/squad/invite', {
      method: 'POST',
      body: { login },
      auth: true,
    });
    // Ответ второго игрока ждём частым опросом: минуту, ровно пока живёт
    // приглашение.
    this.hurry();
    return answer;
  }

  /**
   * Принять приглашение. Отряд взаимный: приняли — значит и позвавший
   * оказывается в моём отряде, иначе «мы вместе» знал бы только один из двоих.
   */
  async accept(id) {
    const answer = await this.account.request('/squad/accept', {
      method: 'POST',
      body: { id },
      auth: true,
    });
    this.invites = this.invites.filter((i) => i.id !== id);
    await this.refresh();
    if (answer?.login) {
      try {
        this.addToSquad(answer.login);
      } catch {
        // Мест нет или он уже там — приглашение всё равно принято. Ронять
        // из-за этого согласие нельзя: человек уже нажал «Принять».
      }
    }
    this.onChange(this.state());
    return this.state();
  }

  async decline(id) {
    await this.account.request('/squad/decline', { method: 'POST', body: { id }, auth: true });
    this.invites = this.invites.filter((i) => i.id !== id);
    this.onChange(this.state());
    return this.state();
  }

  /**
   * @param {() => ({status: string, kills: number, deaths: number, assists: number})} snapshot
   */
  start(snapshot) {
    this.stop();
    this.snapshot = snapshot;
    this.pingTimer = setInterval(() => this.ping(snapshot()), PING_MS);
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.refresh();
    this.ping(snapshot());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.fastTimer) clearInterval(this.fastTimer);
    this.timer = null;
    this.pingTimer = null;
    this.fastTimer = null;
  }

  // --- Отряд --------------------------------------------------------------

  /**
   * Три места рядом со своим — как просил владелец. Проверяем здесь, а не в
   * интерфейсе: интерфейс переписывается за пять минут.
   */
  static MAX_SQUAD = 3;

  addToSquad(login) {
    const squad = this.squad;
    if (squad.some((l) => l.toLowerCase() === String(login).toLowerCase())) return this.squad;
    if (squad.length >= Friends.MAX_SQUAD) throw new Error('в отряде больше нет мест');
    if (!this.data.friends.some((f) => f.login === login)) {
      throw new Error('в отряд можно позвать только друга');
    }
    this.settings.set('squad', [...squad, login]);
    return this.squad;
  }

  removeFromSquad(login) {
    this.settings.set(
      'squad',
      this.squad.filter((l) => l.toLowerCase() !== String(login).toLowerCase())
    );
    return this.squad;
  }
}

module.exports = { Friends };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { safeStorage } = require('electron');

// Аккаунт: обращения к серверу и хранение токена.
//
// Токен лежит зашифрованным средствами Windows (DPAPI через safeStorage):
// расшифровать его сможет только та же учётная запись Windows на той же
// машине. Обычный файл с токеном забирается любой программой, запущенной
// от имени пользователя, — а токен даёт полный доступ к аккаунту.

const TOKEN_FILE = 'account.dat';

// Версия приложения уходит в каждый запрос. Сервер по ней решает, разговаривать
// ли с этой сборкой вообще: старая программа не ломается громко, она молча
// присылает не то и молча теряет данные, — поэтому её останавливают, а не чинят
// на ходу. Совпадать с package.json обязано; читаем оттуда, чтобы не разъехалось.
const APP_VERSION = require('../../package.json').version;
const VERSION_HEADER = 'X-Sightline-Version';

/**
 * Разбирает «0.3.0» в [0, 3, 0]. Хвост после третьего числа («-beta») на
 * совместимость не влияет и отбрасывается — ровно как на сервере.
 * @returns {number[]|null}
 */
function parseVersion(raw) {
  const core = String(raw || '').trim().split(/[-+]/)[0];
  if (!core) return null;
  const parts = core.split('.');
  if (parts.length > 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some(Number.isNaN)) return null;
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** Обычное сравнение по частям: −1, 0, 1. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

class Account {
  /**
   * @param {string} userDataDir
   * @param {object} [opts]
   * @param {string} [opts.baseUrl] - адрес сервера
   */
  constructor(userDataDir, { baseUrl = require('./config').api } = {}) {
    this.file = path.join(userDataDir, TOKEN_FILE);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.session = null; // { token, login, role, lang, expiresAt }
    // Что сервер думает о нашей версии. null — ещё не спрашивали.
    // { ok, appVersion, minClient, latestClient, downloadUrl, updateAvailable }
    this.version = null;
    this.load();
  }

  get isSignedIn() {
    return !!this.session?.token;
  }

  get isAdmin() {
    return this.session?.role === 'admin';
  }

  /** Состояние для интерфейса. Токен наружу не отдаём никогда. */
  state() {
    return {
      signedIn: this.isSignedIn,
      login: this.session?.login || null,
      role: this.session?.role || null,
      isAdmin: this.isAdmin,
      expiresAt: this.session?.expiresAt || null,
      version: this.version,
    };
  }

  // --- Хранение ----------------------------------------------------------

  load() {
    try {
      const raw = fs.readFileSync(this.file);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
      this.session = JSON.parse(json);
    } catch {
      // Файла нет, он испорчен или зашифрован на другой машине — все три
      // случая означают одно: входа нет. Падать тут незачем.
      this.session = null;
    }
  }

  save() {
    try {
      if (!this.session) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      const json = JSON.stringify(this.session);
      const data = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json)
        : Buffer.from(json, 'utf8');
      fs.writeFileSync(this.file, data, { mode: 0o600 });
    } catch (e) {
      // Не смогли сохранить — человек останется в системе до перезапуска.
      // Это неприятно, но лучше, чем уронить приложение на ровном месте.
      console.error('не удалось сохранить сессию:', e.message);
    }
  }

  // --- Обращения к серверу ------------------------------------------------

  /**
   * @param {string} route
   * @param {object} [opts]
   * @param {string} [opts.method]
   * @param {object} [opts.body]
   * @param {boolean} [opts.auth] - приложить токен
   */
  /**
   * @param {string} route
   * @param {object} [opts]
   * @param {string} [opts.method]
   * @param {object} [opts.body] - уедет как JSON
   * @param {Buffer} [opts.raw] - уедет как есть; тогда нужен contentType
   * @param {string} [opts.contentType]
   * @param {boolean} [opts.auth] - приложить токен
   */
  async request(route, { method = 'GET', body, raw, contentType, auth = false } = {}) {
    const headers = {
      'Content-Type': raw ? contentType || 'application/octet-stream' : 'application/json',
      [VERSION_HEADER]: APP_VERSION,
    };
    if (auth) {
      if (!this.isSignedIn) throw new Error('нужен вход в аккаунт');
      headers.Authorization = `Bearer ${this.session.token}`;
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers,
        body: raw || (body ? JSON.stringify(body) : undefined),
        // Сервер может лежать, а интернет — пропасть. Без таймаута запрос
        // висел бы до победного, и интерфейс ждал бы вместе с ним.
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      // Разные причины — одно следствие: сервера сейчас нет. Показывать
      // человеку «fetch failed» бессмысленно.
      const reason = e.name === 'TimeoutError' ? 'сервер не отвечает' : 'нет связи с сервером';
      const err = new Error(reason);
      err.offline = true;
      throw err;
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Сервер ответил не JSON — обычно это страница ошибки от nginx.
      throw new Error(`сервер вернул неожиданный ответ (${response.status})`);
    }

    if (!response.ok) {
      // Сервер отказал по версии. Запоминаем это сразу: узнать о том, что
      // программа устарела, можно на любом запросе, а не только на проверке
      // версии при старте — например, если минимум подняли, пока окно висело
      // открытым.
      if (response.status === 426) {
        this.version = {
          ok: false,
          appVersion: APP_VERSION,
          minClient: data?.min_client || null,
          latestClient: data?.latest_client || null,
          downloadUrl: data?.download_url || null,
          updateAvailable: true,
        };
      }
      // Токен протух или отозван — состояние «вошёл» больше не соответствует
      // действительности, и держать его нельзя: иначе интерфейс будет
      // показывать вход, которого нет.
      //
      // Но 401 приходит и в другом случае: пароль, присланный В ТЕЛЕ запроса,
      // не подошёл — смена пароля, повторное подтверждение перед опасным
      // действием в админке. Там с сессией всё в порядке, и выкидывать человека
      // из аккаунта за опечатку в поле нельзя. Разводим по коду ошибки:
      // «unauthorized» — про токен, «bad_credentials» — про то, что он ввёл.
      if (response.status === 401 && data?.error !== 'bad_credentials') this.signOutLocally();
      const err = new Error(data?.message || `ошибка сервера (${response.status})`);
      err.code = data?.error;
      err.status = response.status;
      // Через сколько секунд можно повторить — отдельным полем, а не разбором
      // текста: формулировку однажды поправят, и разбор молча перестанет
      // работать. Окно показывает по нему обратный отсчёт вместо глухого
      // «попробуйте позже».
      if (typeof data?.retry_after === 'number') err.retryAfter = data.retry_after;
      throw err;
    }

    return data;
  }

  /**
   * Спрашивает сервер, годится ли эта сборка.
   *
   * Метод открыт и не закрыт проверкой версии — иначе устаревшая программа не
   * смогла бы даже узнать, что она устарела.
   *
   * Сервер недоступен — это НЕ повод считать версию плохой. Локальная часть
   * программы (разбор кил-фида, история боёв, графики) работает без сети
   * вообще, и выключать её из-за того, что интернет отвалился, было бы
   * издевательством. Пока ответа нет, аккаунт просто недоступен.
   */
  async checkVersion() {
    try {
      const data = await this.request('/version');
      const min = parseVersion(data?.min_client);
      const latest = parseVersion(data?.latest_client);
      const mine = parseVersion(APP_VERSION);
      this.version = {
        ok: !min || !mine || compareVersions(mine, min) >= 0,
        appVersion: APP_VERSION,
        minClient: data?.min_client || null,
        latestClient: data?.latest_client || null,
        downloadUrl: data?.download_url || null,
        updateAvailable: !!(latest && mine && compareVersions(mine, latest) < 0),
      };
    } catch (e) {
      // 426 уже записан в request(); остальное — «сервера сейчас нет».
      if (this.version?.ok === false) return this.version;
      this.version = null;
    }
    return this.version;
  }

  /**
   * Берёт у сервера задачу и считает к ней ответ.
   *
   * Смысл — не в том, чтобы отличить человека от машины (это невозможно), а в
   * том, чтобы регистрация стоила времени процессора. Для одного человека это
   * несколько секунд один раз в жизни; для того, кто заводит аккаунты пачками,
   * — вся его пачка, умноженная на те же секунды.
   *
   * @param {(tried: number) => void} [onProgress]
   * @returns {Promise<{challenge: string, nonce: string}>}
   */
  async solveChallenge(onProgress) {
    const task = await this.request('/auth/challenge');
    const worker = new Worker(path.join(__dirname, 'pow-worker.js'), {
      workerData: { challenge: task.challenge, difficulty: task.difficulty },
    });

    try {
      return await new Promise((resolve, reject) => {
        worker.on('message', (m) => {
          if (m.done) resolve({ challenge: task.challenge, nonce: m.nonce });
          else if (onProgress) onProgress(m.tried);
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          // Штатный выход после ответа промис уже разрешил, и этот reject
          // ничего не сделает. А вот убитый поток иначе повесил бы окно
          // навсегда — ждать было бы нечего.
          if (code !== 0) reject(new Error('проверка от ботов не завершилась'));
        });
      });
    } finally {
      await worker.terminate();
    }
  }

  /**
   * Обновляет роль и язык из аккаунта.
   *
   * Роль сохраняется в сессии при входе и сама по себе не меняется. Значит,
   * человек, которому выдали права администратора, увидит их только после
   * перезахода — и будет справедливо уверен, что права не выдали. Спрашиваем
   * при запуске: один запрос, зато состояние соответствует действительности.
   */
  async refreshMe() {
    if (!this.isSignedIn) return this.state();
    try {
      const me = await this.request('/auth/me', { auth: true });
      this.session = { ...this.session, role: me.role, login: me.login, lang: me.lang };
      this.save();
    } catch {
      // Сервера нет — остаёмся с тем, что знали. Это не повод выкидывать
      // человека из аккаунта.
    }
    return this.state();
  }

  async register({ login, password, lang, acceptTerms }, onProgress) {
    // Задачу решаем до отправки формы: сервер откажет в регистрации без неё,
    // и узнать об этом после ввода пароля было бы обидно.
    const proof = await this.solveChallenge(onProgress);
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: {
        login,
        password,
        lang,
        accept_terms: !!acceptTerms,
        challenge: proof.challenge,
        nonce: proof.nonce,
      },
    });
    this.applySession(data);
    // Код восстановления возвращается ровно один раз и нигде не сохраняется:
    // сохранить его — задача человека, а наше дело показать и не потерять
    // раньше времени.
    return { ...this.state(), recoveryCode: data.recovery_code };
  }

  async signIn({ login, password }) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: { login, password },
    });
    this.applySession(data);
    return this.state();
  }

  async signOut() {
    // Сначала сообщаем серверу, потом забываем локально: если сделать
    // наоборот, при обрыве связи сессия останется живой на сервере, а
    // закрыть её будет уже нечем.
    try {
      await this.request('/auth/logout', { method: 'POST', auth: true });
    } catch {
      // Сервер недоступен — выходим всё равно. Человек нажал «выйти», и
      // отказать ему из-за отсутствия сети было бы странно.
    }
    this.signOutLocally();
    return this.state();
  }

  signOutLocally() {
    this.session = null;
    this.save();
  }

  /**
   * Смена пароля из настроек.
   *
   * Сервер на этот запрос делает три вещи сразу: меняет пароль, выдаёт новый
   * код восстановления взамен старого и закрывает ВСЕ сессии аккаунта, включая
   * нашу. Взамен закрытой он тут же выдаёт новый токен — его надо сохранить,
   * иначе человек, сменивший пароль на своей же машине, будет выброшен из
   * аккаунта следующим запросом и решит, что что-то сломалось.
   *
   * Ответ приходит без логина, роли и языка — только токен и срок. Поэтому
   * сессия обновляется, а не переписывается целиком: applySession здесь
   * стёрла бы роль, и админ перестал бы видеть свою вкладку до перезахода.
   */
  async changePassword({ oldPassword, newPassword }) {
    const data = await this.request('/auth/password', {
      method: 'POST',
      body: { old_password: oldPassword, new_password: newPassword },
      auth: true,
    });
    this.session = { ...this.session, token: data.token, expiresAt: data.expires_at };
    this.save();
    // Код восстановления, как и при регистрации, показывается один раз и
    // нигде не сохраняется: на сервере лежит только его хэш.
    return { ...this.state(), recoveryCode: data.recovery_code };
  }

  /**
   * Выход со всех устройств.
   *
   * Наша собственная сессия закрывается вместе с остальными, и это не
   * недоработка, а весь смысл кнопки: человек нажимает её, когда не знает,
   * у кого ещё открыт его аккаунт, — и «везде, кроме здесь» такой уверенности
   * не даёт. Поэтому после успешного ответа выходим и локально.
   *
   * Если сервер недоступен, выходить локально НЕЛЬЗЯ: обычный «Выйти» так
   * делает потому, что закрывает одну сессию на этой машине, а здесь чужие
   * сессии остались бы живыми, и тихий выход у себя выглядел бы как
   * выполненная просьба. Ошибку показываем.
   */
  /**
   * Настройки в учётной записи: прислать свои, забрать итог слияния.
   *
   * Один запрос вместо двух намеренно: между «отправить» и «получить»
   * оставалось бы окно, в котором две машины успевают разойтись.
   */
  async syncSettings(items) {
    return this.request('/settings', { method: 'POST', body: { items }, auth: true });
  }

  async logoutAll() {
    const data = await this.request('/auth/logout-all', { method: 'POST', auth: true });
    this.signOutLocally();
    return { ...this.state(), closed: data?.closed ?? null };
  }

  applySession(data) {
    this.session = {
      token: data.token,
      login: data.login,
      role: data.role,
      lang: data.lang,
      expiresAt: data.expires_at,
    };
    this.save();
  }
}

module.exports = { Account, parseVersion, compareVersions, APP_VERSION };

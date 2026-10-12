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

/**
 * Отказы 401, которые говорят о введённом в форму, а не о токене сессии.
 * На них человека из аккаунта не выкидываем.
 */
const INPUT_ERRORS = new Set(['bad_credentials', 'totp_required', 'bad_totp']);

/**
 * Код из приложения или резервный код — как его отправить.
 *
 * Шесть цифр приложение показывает группами («123 456»), и люди так и вводят.
 * Пробелы из цифр убираем; резервный код уходит как набран (без краевых
 * пробелов) — какой у него вид, решает сервис учёток.
 */
function normalizeTotpCode(raw) {
  const s = String(raw || '').trim();
  if (/^[\d\s]+$/.test(s)) return s.replace(/\s/g, '');
  return s;
}

/**
 * Модули QR-кода для адреса otpauth:// — строки из «0» и «1».
 *
 * Рисуется в окне холстом, а считается здесь: библиотека — обычный модуль
 * Node (qrcode-generator, версия закреплена точно), окну же разрешены только
 * свои скрипты. Секрет при этом никуда не уходит — ни в сеть, ни в чужой
 * сервис картинок.
 */
function qrMatrix(text) {
  const qrcode = require('qrcode-generator');
  // Байтовый режим по умолчанию режет символы до одного байта — логин
  // кириллицей в подписи превратился бы в мусор. Нужен UTF-8.
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    let row = '';
    for (let c = 0; c < n; c++) row += qr.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
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
    // Незаконченный вход: пароль принят, ждём второй фактор.
    // { kind: 'totp' | 'setup', token, login, recoveryCode? }. Токен шага
    // живёт только здесь, в памяти главного процесса: окну он не нужен, а
    // всё, что уходит в окно, видно любому его скрипту.
    this.pending = null;
    // Что сервер думает о нашей версии. null — ещё не спрашивали.
    // { ok, appVersion, minClient, latestClient, downloadUrl, updateAvailable,
    //   latestNotes }
    this.version = null;
    /**
     * Позвать, когда стало известно что-то о связи с сервером.
     *
     * Здесь единственное место, где это вообще известно: все обращения идут
     * через request(). Собирать состояние снаружи значило бы гадать по
     * ошибкам, которые до окна доходят не все.
     */
    this.onServerState = () => {};
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
      this.onServerState({ ok: false, message: reason });
      throw err;
    }

    // Ответ получен — сервер на связи, каким бы ни был код. Отказ по существу
    // (неверный пароль, нет прав) к связи отношения не имеет.
    this.onServerState({ ok: true });

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
      //
      // То же со вторым фактором: `totp_required` — это «пароль верный, нужен
      // код», `bad_totp` — опечатка в коде. Ни то ни другое не про токен.
      if (response.status === 401 && !INPUT_ERRORS.has(data?.error)) this.signOutLocally();
      const err = new Error(data?.message || `ошибка сервера (${response.status})`);
      err.code = data?.error;
      err.status = response.status;
      // Тело отказа целиком — для тех, кто ждёт в нём не только текст:
      // `totp_token` и `setup_token` приходят именно отказом входа.
      err.body = data;
      // Ошибки сервера (5xx) — это про связь: отвечает, но не работает.
      // Ошибки запроса (4xx) — про то, что мы попросили, и в строку состояния
      // им не место: там они висели бы как «сервер сломан» после каждой
      // опечатки в пароле.
      if (response.status >= 500) this.onServerState({ ok: false, message: err.message });
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
        // Что человек получит, обновившись. Приходит с сервера, потому что
        // старая сборка не может знать, что появилось после неё. Пусто —
        // значит сказать нечего, и обещать мы ничего не будем.
        latestNotes: String(data?.latest_notes || '').trim(),
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
    this.pending = null;
    let data;
    try {
      data = await this.request('/auth/login', {
        method: 'POST',
        body: { login, password },
      });
    } catch (e) {
      const step = this.takeStep(e, login);
      if (step) return step;
      throw e;
    }
    this.applySession(data);
    return this.state();
  }

  // --- Второй фактор -------------------------------------------------------
  //
  // Пароль верный, но сессии ещё нет. Сервер отвечает отказом с токеном шага:
  //   401 totp_required {totp_token}        — нужен код из приложения;
  //   403 totp_setup_required {setup_token} — роли второй фактор обязателен,
  //                                           а он не настроен.
  // Для человека это не ошибка, а следующий экран, поэтому наружу уходит не
  // исключением, а ответом { step }.

  /** Отказ входа → шаг второго фактора, если это он. Иначе null. */
  takeStep(e, login) {
    const body = e?.body || {};
    const recoveryCode = body.recovery_code || undefined;
    if (e?.code === 'totp_required' && body.totp_token) {
      this.pending = { kind: 'totp', token: body.totp_token, login, recoveryCode };
      return { ...this.state(), step: 'totp' };
    }
    if (e?.code === 'totp_setup_required' && body.setup_token) {
      this.pending = { kind: 'setup', token: body.setup_token, login, recoveryCode };
      return { ...this.state(), step: 'totp_setup' };
    }
    return null;
  }

  pendingOf(kind) {
    if (this.pending?.kind !== kind) {
      const err = new Error('вход начат заново — введите логин и пароль');
      err.code = 'no_pending_step';
      throw err;
    }
    return this.pending;
  }

  /** Второй шаг входа: шесть цифр или резервный код. */
  async signInTotp({ code }) {
    const pending = this.pendingOf('totp');
    const data = await this.request('/auth/login/totp', {
      method: 'POST',
      body: { totp_token: pending.token, code: normalizeTotpCode(code) },
    });
    this.pending = null;
    this.applySession(data, pending.login);
    return { ...this.state(), recoveryCode: pending.recoveryCode };
  }

  /** Обязательная настройка: секрет и адрес для приложения, плюс QR. */
  async totpSetupForced() {
    const pending = this.pendingOf('setup');
    const data = await this.request('/auth/totp/setup-forced', {
      method: 'POST',
      body: { setup_token: pending.token },
    });
    return {
      secret: data?.secret || '',
      otpauthUri: data?.otpauth_uri || '',
      qr: data?.otpauth_uri ? qrMatrix(data.otpauth_uri) : null,
    };
  }

  /**
   * Подтвердить настройку кодом. Сервер включает второй фактор, отдаёт
   * резервные коды — ОДИН раз — и сессию, как при входе.
   */
  async totpConfirmForced({ code }) {
    const pending = this.pendingOf('setup');
    const data = await this.request('/auth/totp/confirm-forced', {
      method: 'POST',
      body: { setup_token: pending.token, code: normalizeTotpCode(code) },
    });
    this.pending = null;
    this.applySession(data, pending.login);
    return {
      ...this.state(),
      backupCodes: Array.isArray(data?.backup_codes) ? data.backup_codes.map(String) : [],
      recoveryCode: pending.recoveryCode,
    };
  }

  /** Человек вернулся к форме входа — шаг больше не нужен. */
  cancelPending() {
    this.pending = null;
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

  /**
   * Задать пароль после того, как администратор объявил прежний негодным.
   *
   * Сессию выдаёт сервер сразу же: человек только что доказал, что аккаунт
   * его, кодом восстановления, — заставлять его после этого ещё и входить
   * значило бы спросить пароль, который он ввёл секунду назад.
   */
  async forcedPassword({ login, recoveryCode, newPassword }) {
    this.pending = null;
    let data;
    try {
      data = await this.request('/auth/forced-password', {
        method: 'POST',
        body: { login, recovery_code: recoveryCode, new_password: newPassword },
      });
    } catch (e) {
      // Восстановление второй фактор не снимает: после него тот же шаг кода,
      // что и при входе (docs/totp-spec.md на сайте). Новый код
      // восстановления, если сервис приложил его к отказу, донесём до окна
      // после второго шага.
      const step = this.takeStep(e, login);
      if (step) return { recoveryCode: null, step: step.step, state: step };
      throw e;
    }
    this.session = {
      token: data.token,
      login,
      role: 'user',
      lang: null,
      expiresAt: data.expires_at,
    };
    this.save();
    return { recoveryCode: data.recovery_code, state: this.state() };
  }

  async logoutAll() {
    const data = await this.request('/auth/logout-all', { method: 'POST', auth: true });
    this.signOutLocally();
    return { ...this.state(), closed: data?.closed ?? null };
  }

  applySession(data, login) {
    this.session = {
      token: data.token,
      login: data.login || login || null,
      role: data.role,
      lang: data.lang,
      expiresAt: data.expires_at,
    };
    this.save();
  }
}

module.exports = {
  Account,
  parseVersion,
  compareVersions,
  normalizeTotpCode,
  qrMatrix,
  APP_VERSION,
};

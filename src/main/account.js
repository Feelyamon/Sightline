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
  constructor(userDataDir, { baseUrl = 'https://sightline.feelyamon.ru/v1' } = {}) {
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
  async request(route, { method = 'GET', body, auth = false } = {}) {
    const headers = { 'Content-Type': 'application/json', [VERSION_HEADER]: APP_VERSION };
    if (auth) {
      if (!this.isSignedIn) throw new Error('нужен вход в аккаунт');
      headers.Authorization = `Bearer ${this.session.token}`;
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
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
      if (response.status === 401) this.signOutLocally();
      const err = new Error(data?.message || `ошибка сервера (${response.status})`);
      err.code = data?.error;
      err.status = response.status;
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

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { protocol, net } = require('electron');

// Аватарки друзей: скачивание, кэш на диске и своя схема адресов для окна.
//
// Почему не показывать их прямо по http-адресу с сервера. Во-первых, политика
// безопасности окна запрещает загружать что-либо со стороны, и открывать её
// ради картинок — значит открывать её для всего. Во-вторых, каждый показ
// списка друзей ходил бы в сеть, а список показывается часто. В-третьих, без
// сети окно осталось бы с пустыми квадратами.
//
// Поэтому файл скачивается один раз, ложится в userData и отдаётся окну по
// адресу sightline-avatar://<имя>. Имя файла на сервере случайное и меняется
// при каждой загрузке новой картинки — значит, кэш не может устареть, и
// проверять его свежесть не нужно.

const SCHEME = 'sightline-avatar';
const HOST = require('./config').site;
// Больше мегабайта аватарка быть не может — столько принимает сервер. Предел
// нужен на случай, если по адресу окажется не то, что мы ждём.
const MAX_BYTES = 2 * 1024 * 1024;

class Avatars {
  constructor(userDataDir) {
    this.dir = path.join(userDataDir, 'avatars');
    /** @type {Map<string, Promise<void>>} — что уже качается, чтобы не качать дважды. */
    this.pending = new Map();
  }

  /**
   * Схему надо объявить ДО готовности приложения, иначе окно её не увидит.
   * Отдельный статический шаг: сам объект создаётся уже после app.whenReady().
   */
  static registerScheme() {
    protocol.registerSchemesAsPrivileged([
      // secure — чтобы страница со своей политикой безопасности считала эти
      // адреса такими же надёжными, как свои файлы.
      { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
    ]);
  }

  /** Адрес для тега <img>. Пустое имя — значит аватарки нет, покажем силуэт. */
  static url(name) {
    return name ? `${SCHEME}://${name}` : null;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  /**
   * Имя приходит с сервера, и доверять ему нельзя: «../../settings.json»
   * превратился бы в чтение чужих файлов и запись куда попало.
   */
  static safeName(name) {
    return typeof name === 'string' && /^[a-f0-9]{32}\.png$/.test(name);
  }

  /** Ставит обработчик адресов sightline-avatar://. */
  install() {
    fs.mkdirSync(this.dir, { recursive: true });
    protocol.handle(SCHEME, async (request) => {
      const name = decodeURIComponent(new URL(request.url).hostname);
      if (!Avatars.safeName(name)) return new Response('', { status: 404 });
      try {
        await this.ensure(name);
        return new Response(fs.readFileSync(this.file(name)), {
          headers: { 'Content-Type': 'image/png' },
        });
      } catch {
        // Нет сети или файла — окно покажет силуэт. Это лучше, чем сломанная
        // картинка, и уж точно лучше, чем ошибка на весь список друзей.
        return new Response('', { status: 404 });
      }
    });
  }

  /** Скачивает файл, если его ещё нет. Повторные вызовы ждут первый. */
  ensure(name) {
    if (fs.existsSync(this.file(name))) return Promise.resolve();
    let job = this.pending.get(name);
    if (job) return job;

    job = this.download(name).finally(() => this.pending.delete(name));
    this.pending.set(name, job);
    return job;
  }

  async download(name) {
    // net.fetch, а не обычный fetch: он ходит через сетевой слой Chromium и
    // подчиняется настройкам прокси системы, как и всё остальное окно.
    const response = await net.fetch(`${HOST}/avatars/${name}`);
    if (!response.ok) throw new Error(`аватарка не отдалась (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('аватарка неожиданно большая');

    fs.mkdirSync(this.dir, { recursive: true });
    // Пишем через временное имя: оборванная закачка не должна оставить в кэше
    // половину файла, которая потом будет считаться готовой.
    const tmp = `${this.file(name)}.part`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this.file(name));
  }
}

module.exports = { Avatars, AVATAR_SCHEME: SCHEME };

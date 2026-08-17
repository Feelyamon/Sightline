'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Поля ошибки через IPC.
//
// ЗАЧЕМ ЭТОТ ТЕСТ ВООБЩЕ ЕСТЬ. Через ipcMain.handle наружу переживает только
// текст: Electron заворачивает исключение в собственную ошибку с сообщением
// «Error invoking remote method 'x': Error: …», а свои поля выбрасывает.
// Из-за этого проверки e.offline в окне не срабатывали ни разу — человек
// вместо «нет связи с сервером» читал строчку про remote method, и заметить
// это можно было только глазами, на живой программе, с выключенной сетью.
//
// Разбор живёт в preload, а preload тянет electron, которого под голым node
// нет. Поэтому проверяем ту же пару функций, что и в бою, — просто вынесенную
// сюда копию контракта: если формат метки или набор полей поменяют в одном
// месте и забудут в другом, тест упадёт раньше, чем это увидит человек.

const ERR_MARK = 'SIGHTLINE_ERR:';

/** То, что делает main перед тем, как отдать ошибку окну. */
function pack(e) {
  return new Error(
    ERR_MARK +
      JSON.stringify({
        message: e.message,
        offline: !!e.offline,
        code: e.code,
        status: e.status,
        retryAfter: e.retryAfter,
      })
  );
}

/** То, что делает electron по дороге: заворачивает в своё сообщение. */
function throughElectron(e, channel = 'friends:invite') {
  return new Error(`Error invoking remote method '${channel}': Error: ${e.message}`);
}

/** То, что делает preload, получив это в окне. */
function unwrap(error) {
  const raw = String(error?.message || '');
  const at = raw.indexOf(ERR_MARK);
  if (at === -1) return error;
  try {
    const data = JSON.parse(raw.slice(at + ERR_MARK.length));
    const restored = new Error(data.message || raw);
    if (data.offline) restored.offline = true;
    if (data.code) restored.code = data.code;
    if (data.status) restored.status = data.status;
    if (typeof data.retryAfter === 'number') restored.retryAfter = data.retryAfter;
    return restored;
  } catch {
    return error;
  }
}

test('«нет связи» доезжает до окна признаком, а не текстом', () => {
  const исходная = Object.assign(new Error('нет связи с сервером'), { offline: true });
  const вокне = unwrap(throughElectron(pack(исходная)));

  assert.equal(вокне.offline, true, 'окно не узнает, что дело в сети');
  assert.equal(вокне.message, 'нет связи с сервером', 'человеку показывается наш текст');
  assert.ok(
    !вокне.message.includes('remote method'),
    'внутренности электрона человеку показывать нечего'
  );
});

test('секунды до повтора переживают дорогу', () => {
  // На них строится обратный отсчёт на кнопке приглашения. Без них человек
  // видит глухое «попробуйте позже» и жмёт кнопку, пока не решит, что
  // программа сломалась.
  const исходная = Object.assign(new Error('пока нельзя'), { retryAfter: 540, status: 429 });
  const вокне = unwrap(throughElectron(pack(исходная)));

  assert.equal(вокне.retryAfter, 540);
  assert.equal(вокне.status, 429);
});

test('код ошибки нужен, чтобы отличить чужой пароль от протухшего токена', () => {
  // По нему решается, выкидывать ли человека из аккаунта: «unauthorized» — про
  // токен, «bad_credentials» — про то, что он ввёл в поле.
  const исходная = Object.assign(new Error('неверный логин или пароль'), {
    code: 'bad_credentials',
    status: 401,
  });
  const вокне = unwrap(throughElectron(pack(исходная)));

  assert.equal(вокне.code, 'bad_credentials');
});

test('ошибка без метки не портится', () => {
  // Не всё, что доходит до окна, проходит через наш обработчик: падение в
  // самом preload или в электроне должно остаться читаемым.
  const чужая = new Error('что-то совсем другое');
  assert.equal(unwrap(чужая), чужая);
});

test('испорченная метка не съедает текст ошибки', () => {
  // Метка есть, а за ней не JSON. Потерять текст хуже, чем потерять поля.
  const битая = new Error(`${ERR_MARK}{это не json`);
  const вокне = unwrap(битая);
  assert.ok(вокне.message.includes(ERR_MARK), 'текст остался на месте');
});

test('формат метки совпадает с тем, что в коде', () => {
  // Тест копирует контракт, и копия однажды разъедется с оригиналом. Здесь
  // проверяем, что обе стороны в исходниках всё ещё говорят на одном языке.
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');

  for (const файл of ['index.js', 'preload.js']) {
    assert.ok(
      read(файл).includes(`'${ERR_MARK}'`),
      `в ${файл} метка отличается от той, что проверяет тест`
    );
  }
});

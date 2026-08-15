'use strict';

const { createHash } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');

// Считает доказательство работы для регистрации.
//
// Отдельный поток, а не главный: работа занимает секунды, а главный поток
// Electron рисует окно. Считать там значило бы заморозить интерфейс ровно на
// то время, пока человек ждёт ответа, — и он справедливо решил бы, что
// программа зависла.

const { challenge, difficulty } = workerData;

/** Сколько нулевых битов в начале. Считаем так же, как сервер. */
function leadingZeroBits(digest) {
  let bits = 0;
  for (const byte of digest) {
    bits += Math.clz32(byte) - 24; // clz32 считает по 32 битам, у нас байт
    if (byte !== 0) break;
  }
  return bits;
}

// О прогрессе сообщаем не на каждом хэше: сообщение между потоками стоит
// заметно дороже одного sha256, и отчёт съел бы больше, чем сама работа.
const REPORT_EVERY = 50_000;

for (let nonce = 0; ; nonce++) {
  const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(digest) >= difficulty) {
    parentPort.postMessage({ done: true, nonce: String(nonce) });
    break;
  }
  if (nonce % REPORT_EVERY === 0) parentPort.postMessage({ done: false, tried: nonce });
}

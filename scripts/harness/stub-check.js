'use strict';

// Проверка синтаксиса заглушки стенда.
//
// Сама stub.js под node не выполняется: она обращается к window и document,
// которых тут нет. Поэтому её не запускают, а только разбирают — этого
// достаточно, чтобы поймать сломанную кавычку или лишнюю скобку до того, как
// они превратятся в пустое окно браузера без единого объяснения.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, 'stub.js');
try {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
} catch (e) {
  console.error(`Стенд не собран: в stub.js синтаксическая ошибка.\n${e.message}`);
  process.exit(1);
}

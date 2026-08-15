'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// account.js тянет electron ради safeStorage, а под голым node его нет.
// Разбор версий от электрона не зависит, поэтому подменяем модуль заглушкой:
// иначе проверять пришлось бы копией функции, а копия однажды разъедется с
// оригиналом — и тест начнёт подтверждать не то, что работает у людей.
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stubs/electron.js');
  return realResolve.call(this, request, ...rest);
};

const { parseVersion, compareVersions, APP_VERSION } = require('../src/main/account');

test('версия разбирается так же, как на сервере', () => {
  assert.deepEqual(parseVersion('0.3.0'), [0, 3, 0]);
  assert.deepEqual(parseVersion(' 1.2 '), [1, 2, 0]);
  assert.deepEqual(parseVersion('0.3.0-beta.1'), [0, 3, 0]);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('1.2.3.4'), null);
  assert.equal(parseVersion('не версия'), null);
});

test('сравнение идёт по числам, а не по строкам', () => {
  // Строковое сравнение поставило бы 0.9.9 выше 0.10.0 — и обновление
  // перестало бы требоваться ровно тогда, когда оно нужнее всего.
  assert.equal(compareVersions([0, 10, 0], [0, 9, 9]), 1);
  assert.equal(compareVersions([0, 3, 0], [0, 3, 0]), 0);
  assert.equal(compareVersions([0, 2, 9], [0, 3, 0]), -1);
});

test('в заголовок уходит версия из package.json', () => {
  assert.equal(APP_VERSION, require('../package.json').version);
  assert.ok(parseVersion(APP_VERSION), 'версия приложения должна разбираться');
});

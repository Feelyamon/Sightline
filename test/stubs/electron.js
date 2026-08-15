'use strict';

// Заглушка electron для тестов под голым node. Отдаёт ровно то, что модули
// main действительно используют, и ничего сверх: заглушка, которая умеет
// больше настоящего API, однажды скроет собой настоящую ошибку.
module.exports = {
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  },
};

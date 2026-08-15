// Проверка встроенного в Node модуля SQLite внутри Electron.
// Он избавляет от нативных зависимостей: ничего не компилируется, ничего не
// надо пересобирать под ABI Electron, и в собранный .exe он попадает сам.
// Запуск: npx electron scripts/sqlite-probe.js
const { app } = require('electron');

app.whenReady().then(() => {
  console.log('NODE', process.versions.node, 'ELECTRON', process.versions.electron);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a INTEGER, b TEXT)');
    db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'Т-80БВМ');
    const row = db.prepare('SELECT * FROM t').get();
    console.log('SQLITE OK', JSON.stringify(row));
    db.close();
  } catch (e) {
    console.log('SQLITE FAIL:', e.message);
  }
  app.quit();
});

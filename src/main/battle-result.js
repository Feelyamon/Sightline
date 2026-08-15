'use strict';

// Исход боя приходит строкой в mission.json. Пока бой идёт — "running";
// по окончании игра пишет результат, и его формулировка зависит от режима и
// языка клиента. Поэтому список открытый: незнакомое значение честно
// превращается в 'unknown', а не угадывается.

const WIN_PATTERNS = [/^success/i, /victory/i, /\bwin\b/i, /побед/i, /выигр/i];
const LOSS_PATTERNS = [/^fail/i, /defeat/i, /\blose|lost\b/i, /поражен/i, /проигр/i];
const RUNNING_PATTERNS = [/^running$/i, /in_progress/i];

/**
 * @param {string} status - поле status из mission.json
 * @returns {'win'|'loss'|'running'|'unknown'}
 */
function classifyResult(status) {
  const s = String(status || '').trim();
  if (!s) return 'unknown';
  if (RUNNING_PATTERNS.some((re) => re.test(s))) return 'running';
  if (WIN_PATTERNS.some((re) => re.test(s))) return 'win';
  if (LOSS_PATTERNS.some((re) => re.test(s))) return 'loss';
  return 'unknown';
}

const RESULT_LABEL = {
  win: 'победа',
  loss: 'поражение',
  running: 'идёт',
  unknown: 'неизвестно',
};

module.exports = { classifyResult, RESULT_LABEL };

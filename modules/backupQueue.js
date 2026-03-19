// Simple in-memory promise queue used for tests and fallback
let concurrency = 1;
const pending = [];
let active = 0;

function runNext() {
  if (active >= concurrency) return;
  const item = pending.shift();
  if (!item) return;
  active++;
  Promise.resolve()
    .then(() => item.task())
    .then(res => {
      active--;
      item.resolve(res);
      runNext();
    })
    .catch(err => {
      active--;
      item.reject(err);
      runNext();
    });
}

function setConcurrency(value = 1) {
  const n = Number(value);
  concurrency = Number.isInteger(n) && n > 0 ? n : 1;
  runNext();
}

async function queueBackup(file, handler) {
  return new Promise((resolve, reject) => {
    pending.push({ task: () => handler(file), resolve, reject });
    runNext();
  });
}

module.exports = { queueBackup, setConcurrency };

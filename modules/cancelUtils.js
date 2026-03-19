const controllers = new Map();

function createCancelToken(id = 'default') {
  const controller = new AbortController();
  controllers.set(id, controller);
  return controller.signal;
}

function cancelIngest(id = 'default') {
  const controller = controllers.get(id);
  if (controller) controller.abort();
}

function cancelJob(id = 'default') {
  cancelIngest(id);
}

function isCanceled(id = 'default') {
  const controller = controllers.get(id);
  return controller ? controller.signal.aborted : false;
}

function resetCancelFlag(id = 'default') {
  controllers.delete(id);
}

module.exports = {
  createCancelToken,
  cancelJob,
  cancelIngest,
  isCanceled,
  resetCancelFlag
};

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { createCancelToken, cancelIngest, resetCancelFlag } = require('./cancelUtils');

function normalizeError(err) {
  const fallbackMessage = 'Unknown error';

  if (err instanceof Error) {
    const normalized = {
      message: err.message || fallbackMessage,
      stack: typeof err.stack === 'string' ? err.stack : undefined,
      code: err.code != null ? String(err.code) : undefined,
      name: err.name || 'Error',
      details: undefined
    };

    if (Array.isArray(err.validationErrors)) {
      normalized.details = {
        validationErrors: err.validationErrors.map(item => String(item))
      };
    }

    return normalized;
  }

  if (Array.isArray(err)) {
    const lines = err.map(item => String(item)).filter(Boolean);
    return {
      message: lines[0] || fallbackMessage,
      stack: undefined,
      code: undefined,
      name: 'Error',
      details: lines.length ? { validationErrors: lines } : undefined
    };
  }

  if (err && typeof err === 'object') {
    const message =
      typeof err.message === 'string' && err.message.trim()
        ? err.message.trim()
        : fallbackMessage;
    const validationErrors = Array.isArray(err.validationErrors)
      ? err.validationErrors.map(item => String(item)).filter(Boolean)
      : undefined;

    return {
      message,
      stack: typeof err.stack === 'string' ? err.stack : undefined,
      code: err.code != null ? String(err.code) : undefined,
      name:
        typeof err.name === 'string' && err.name.trim()
          ? err.name.trim()
          : 'Error',
      details: validationErrors?.length ? { validationErrors } : undefined
    };
  }

  const message = String(err || fallbackMessage);
  return {
    message,
    stack: undefined,
    code: undefined,
    name: 'Error',
    details: undefined
  };
}

class QueueManager extends EventEmitter {
  constructor(jobContracts = {}, options = {}) {
    super();
    const {
      maxConcurrency = 1,
      panelConcurrency = {},
      exclusivePanels = {}
    } = options;

    this.jobContracts = {};
    this.setJobContracts(jobContracts);
    this.maxConcurrency = maxConcurrency;
    this.pending = [];
    this.inProgress = new Map();
    this.completed = new Map();
    this.failed = new Map();
    this.paused = false;
    this.panelConcurrency = { ...panelConcurrency };
    this.panelCounts = {};
    this.exclusivePanels = { ...exclusivePanels };
    this.exclusiveCounts = {};
    this.standardInProgress = 0;
  }

  setJobContracts(jobContracts = {}) {
    this.jobContracts = {};
    for (const [panel, contract] of Object.entries(jobContracts)) {
      if (!contract || typeof contract.run !== 'function') {
        throw new Error(`Job contract for panel "${panel}" must include a run() function.`);
      }
      this.jobContracts[panel] = {
        run: contract.run,
        cancel: typeof contract.cancel === 'function' ? contract.cancel : undefined,
        validate: typeof contract.validate === 'function' ? contract.validate : undefined
      };
    }
  }

  getContract(panel) {
    return this.jobContracts[panel];
  }

  addJob(job) {
    const newJob = { ...job };
    if (!newJob.id) newJob.id = uuidv4();
    newJob.status = 'pending';
    newJob.statusMap = {
      copied: false,
      backedUp: false,
      checksummed: false,
      cached: false
    };
    newJob.expectedCopyBytes = newJob.expectedCopyBytes || 0;
    newJob.expectedBackupBytes = newJob.expectedBackupBytes || 0;
    newJob.copiedBytes = 0;
    newJob.backedUpBytes = 0;
    newJob.fileSizeMap = newJob.fileSizeMap || {};
    newJob.retries = newJob.retries || 0;
    newJob.addedAt = Date.now();
    this.pending.push(newJob);
    this.emit('job-added', newJob);
    this._next();
    return newJob.id;
  }

  startQueue() {
    this.paused = false;
    this._next();
  }

  pauseQueue() {
    this.paused = true;
  }

  retryJob(id) {
    const job = this.failed.get(id);
    if (!job) return;
    job.status = 'pending';
    job.retries += 1;
    this.failed.delete(id);
    this.pending.push(job);
    this.emit('job-retry', job);
    this._next();
  }

  cancelJob(id) {
    if (this.inProgress.has(id)) {
      const job = this.inProgress.get(id);
      job.cancelRequested = true;
      job.status = 'cancelling';
      this.emit('job-cancelling', job);
      cancelIngest(id);
      const contract = this.jobContracts[job.panel];
      const cancel = contract?.cancel;
      if (typeof cancel === 'function') cancel(job.id);
    } else {
      const cancelledPendingJobs = this.pending.filter(job => job.id === id);
      if (cancelledPendingJobs.length) {
        this.pending = this.pending.filter(job => job.id !== id);
        for (const job of cancelledPendingJobs) {
          job.cancelRequested = true;
          job.status = 'cancelled';
          job.endedAt = Date.now();
          this.failed.set(job.id, job);
          this.emit('job-cancelled', job);
        }
      }
    }
    this._next();
  }

  drainAll() {
    this.pending = [];

    const inProgressIds = Array.from(this.inProgress.keys());
    for (const id of inProgressIds) {
      this.cancelJob(id);
    }

    this.panelCounts = {};
    this.exclusiveCounts = {};
    this.standardInProgress = 0;
  }

  _processJob(job) {
    job.statusMap = {
      copied: false,
      backedUp: false,
      checksummed: false,
      cached: false
    };
    job.status = 'processing';
    const signal = createCancelToken(job.id);
    job.signal = signal;
    this.inProgress.set(job.id, job);
    const panel = job.panel;
    this.panelCounts[panel] = (this.panelCounts[panel] || 0) + 1;
    if (this.exclusivePanels[panel]) {
      this.exclusiveCounts[panel] = (this.exclusiveCounts[panel] || 0) + 1;
    } else {
      this.standardInProgress++;
    }
    this.emit('job-start', job);
    const contract = this.jobContracts[job.panel];
    if (!contract || typeof contract.run !== 'function') {
      this.failJob(job.id, new Error(`No handler for ${job.panel}`));
      return;
    }
    const cfg = { ...job.config, jobId: job.id, signal };
    const execution = async () => {
      if (contract.validate) {
        const validationResult = await Promise.resolve(contract.validate(cfg));
        let errors = [];
        if (Array.isArray(validationResult)) {
          errors = validationResult.filter(Boolean);
        } else if (typeof validationResult === 'string') {
          errors = [validationResult];
        } else if (
          validationResult &&
          typeof validationResult === 'object' &&
          Array.isArray(validationResult.errors)
        ) {
          errors = validationResult.errors.filter(Boolean);
        }

        if (errors.length) {
          const err = new Error(errors.join('\n'));
          err.validationErrors = errors;
          throw err;
        }
      }

      return contract.run(cfg);
    };

    Promise.resolve()
      .then(() => execution())
      .then(result => {
        this.completeJob(job.id, result);
      })
      .catch(err => {
        this.failJob(job.id, err);
      });
  }

  completeJob(id, result) {
    if (result && result.success === false) {
      // Preserve the full result object for debugging/UI, but avoid blasting IPC with huge log arrays.
      const job = this.inProgress.get(id);
      if (job) {
        let safeResult = result;
        try {
          JSON.stringify(result);
        } catch (err) {
          console.error('❌ Cannot serialize failed result:', err.message);
          safeResult = {
            success: false,
            cancelled: !!result?.cancelled,
            summary: String(result?.logText || result?.error || 'Job failed')
          };
        }

        if (safeResult && typeof safeResult === 'object') {
          safeResult = { ...safeResult };
          if ('log' in safeResult) safeResult.log = undefined;
        }

        job.result = safeResult;

        // If the job reports it was cancelled, treat it as a cancellation even if cancelRequested
        // wasn't set (defensive: some modules return { cancelled: true } on abort).
        if (safeResult && typeof safeResult === 'object' && safeResult.cancelled === true) {
          job.cancelRequested = true;
        }
      }

      const errMsg =
        (result && typeof result === 'object' && result.error) ||
        (Array.isArray(result?.log) ? result.log[0] : null) ||
        (typeof result?.logText === 'string' && result.logText.trim()
          ? result.logText.split('\n')[0]
          : null) ||
        'Job failed';

      this.failJob(id, errMsg instanceof Error ? errMsg : new Error(String(errMsg)));
      return;
    }
    const job = this.inProgress.get(id);
    try {
      JSON.stringify(result);
    } catch (err) {
      console.error('❌ Cannot serialize result:', err.message);
      result = {
        success: !!result?.success,
        summary: String(result?.logText || result?.error || 'Job complete')
      };
    }
    if (!job) return;
    job.result = result;
    this.inProgress.delete(id);
    if (job.panel) {
      this.panelCounts[job.panel] = Math.max(
        (this.panelCounts[job.panel] || 1) - 1,
        0
      );
      if (this.exclusivePanels[job.panel]) {
        this.exclusiveCounts[job.panel] = Math.max(
          (this.exclusiveCounts[job.panel] || 1) - 1,
          0
        );
      } else {
        this.standardInProgress = Math.max(this.standardInProgress - 1, 0);
      }
    }
    resetCancelFlag(id);
    if (job.cancelRequested) {
      job.status = 'cancelled';
      this.failed.set(id, job);
      this.emit('job-cancelled', job);
    } else {
      job.status = 'completed';
      this.completed.set(id, job);
      this.emit('job-complete', job);
    }
    this._next();
  }

  failJob(id, err) {
    const job = this.inProgress.get(id);
    if (!job) return;
    job.error = normalizeError(err);
    this.inProgress.delete(id);
    if (job.panel) {
      this.panelCounts[job.panel] = Math.max(
        (this.panelCounts[job.panel] || 1) - 1,
        0
      );
      if (this.exclusivePanels[job.panel]) {
        this.exclusiveCounts[job.panel] = Math.max(
          (this.exclusiveCounts[job.panel] || 1) - 1,
          0
        );
      } else {
        this.standardInProgress = Math.max(this.standardInProgress - 1, 0);
      }
    }
    resetCancelFlag(id);
    if (job.cancelRequested) {
      job.status = 'cancelled';
    } else {
      job.status = 'failed';
    }
    this.failed.set(id, job);
    this.emit(job.cancelRequested ? 'job-cancelled' : 'job-failed', job);
    this._next();
  }

  _next() {
    if (this.paused) return;
    while (this.pending.length) {
      const index = this.pending.findIndex(job => {
        const limit = this.panelConcurrency[job.panel];
        const count = this.panelCounts[job.panel] || 0;
        if (limit != null && count >= limit) return false;
        if (this.exclusivePanels[job.panel]) {
          const exLimit = this.exclusivePanels[job.panel];
          const exCount = this.exclusiveCounts[job.panel] || 0;
          return exCount < exLimit;
        }
        return this.standardInProgress < this.maxConcurrency;
      });
      if (index === -1) break;
      const [job] = this.pending.splice(index, 1);
      this._processJob(job);
    }
  }
}

module.exports = QueueManager;

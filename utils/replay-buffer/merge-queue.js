class MergeQueue {
  constructor(opts) {
    const options = opts || {};
    this.worker = typeof options.worker === 'function' ? options.worker : null;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.queue = [];
    this.running = false;
  }

  _log(eventName, detail) {
    if (!this.logger) return;
    try {
      this.logger(eventName, detail || {});
    } catch (e) {}
  }

  enqueue(task) {
    this.queue.push(task);
    this.process();
  }

  process() {
    if (this.running) return;
    if (!this.queue.length) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running = true;
    this._log('merge_queue_task_start', { id: task.id || '' });
    Promise.resolve()
      .then(() => {
        if (!this.worker) return null;
        return this.worker(task);
      })
      .catch((err) => {
        this._log('merge_queue_task_fail', {
          id: task.id || '',
          errMsg: err && err.message ? err.message : String(err || '')
        });
      })
      .finally(() => {
        this.running = false;
        setTimeout(() => this.process(), 0);
      });
  }

  clear() {
    this.queue = [];
    this.running = false;
  }
}

module.exports = {
  MergeQueue
};

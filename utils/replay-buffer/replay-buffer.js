const { ChunkManager } = require('./chunk-manager.js');

class ReplayBuffer {
  constructor(opts) {
    this.chunkManager = new ChunkManager(opts || {});
  }

  addChunk(meta) {
    return this.chunkManager.addChunk(meta);
  }

  getChunks() {
    return this.chunkManager.getChunks();
  }

  snapshotWindow(startTime, endTime) {
    return this.chunkManager.snapshotWindow(startTime, endTime);
  }

  retainByPaths(paths) {
    this.chunkManager.retainByPaths(paths);
  }

  releaseByPaths(paths) {
    this.chunkManager.releaseByPaths(paths);
  }

  clear() {
    this.chunkManager.clear();
  }
}

function createReplayBuffer(opts) {
  return new ReplayBuffer(opts || {});
}

module.exports = {
  ReplayBuffer,
  createReplayBuffer
};

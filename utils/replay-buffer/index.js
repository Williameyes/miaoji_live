const { createReplayBuffer, ReplayBuffer } = require('./replay-buffer.js');
const { ChunkManager } = require('./chunk-manager.js');
const { HighlightManager } = require('./highlight-manager.js');
const { MergeQueue } = require('./merge-queue.js');
const { RecorderCore, RECORDER_STATE } = require('./recorder-core.js');
const fsReady = require('./fs-ready.js');

module.exports = {
  createReplayBuffer,
  ReplayBuffer,
  ChunkManager,
  HighlightManager,
  MergeQueue,
  RecorderCore,
  RECORDER_STATE,
  fsReady
};

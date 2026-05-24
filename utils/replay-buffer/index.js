const { createReplayBuffer, ReplayBuffer } = require('./replay-buffer.js');
const { ChunkManager } = require('./chunk-manager.js');
const { HighlightManager } = require('./highlight-manager.js');
const { MergeQueue } = require('./merge-queue.js');
const { RecorderCore, RECORDER_STATE } = require('./recorder-core.js');
const fsReady = require('./fs-ready.js');
const { PingPongRecorder } = require('./ping-pong-recorder.js');
const { createPreviewRecordPipeline } = require('./preview-record-pipeline.js');
const mediaContainerTrim = require('./media-container-trim.js');
const { formatWxErr } = require('./wx-err.js');

module.exports = {
  createReplayBuffer,
  ReplayBuffer,
  ChunkManager,
  HighlightManager,
  MergeQueue,
  RecorderCore,
  RECORDER_STATE,
  fsReady,
  PingPongRecorder,
  createPreviewRecordPipeline,
  mediaContainerTrim,
  formatWxErr
};

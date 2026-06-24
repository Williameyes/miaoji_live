/**
 * 将 pages/live/live.js 按功能域拆分为 constants / layout / behaviors，不改变实现。
 * 用法：node scripts/partition-live-page.js
 */
const fs = require('fs');
const path = require('path');

const LIVE_DIR = path.join(__dirname, '../pages/live');
const SRC = path.join(LIVE_DIR, 'live.js');
const BACKUP = path.join(LIVE_DIR, 'live.js.bak');

/** @type {Record<string, string[]>} */
const BEHAVIOR_GROUPS = {
  'live-state-behavior': [
    'lastSetZoomTime', 'suppressScoreTap', 'pingPongChunkDurationMs', 'pingPongStaggerMs', 'pingPongVideoBitsPerSecondKbps',
    'pingPongRecordFps', 'pingPongRollingMaxFiles', 'pingPongHighlightFlushMinIntervalMs',
    'segmentDurationMs', 'highlightPlaybackWindowMs', 'highlightLeadMs', 'highlightTailMs',
    'recordCooldownAfterStopMs', 'minRecordMsBeforeHighlightStop', 'segmentStopTimer',
    'rollingWatchdogTimer', 'segmentWatchdogTimer', 'segmentCounter', 'pendingHighlight',
    '_highlightSaveAwaitingResume', '_highlightPipelineDoneFinalize', '_highlightPipelineDoneResume',
    '_highlightSaveSessionId', '_highlightResumeGuardTimer', '_highlightSaveHardTimeoutTimer',
    '_highlightDeferredStopTimer', '_highlightSaveProgressTimer', '_replayDeferredItem',
    '_replayDeferredMaterializeItem', '_replayMaterializeWaitTimer', '_highlightRequestLock',
    '_enhanceModeSwitchGuardUntil', '_pendingEnhanceModeAfterRecover', '_pendingEnhanceModeAfterCameraRebuild',
    '_enhanceZeroFrameRecoverTimer', 'rollingSegments', 'segmentBuffer', 'rollingActive',
    'rollingSessionId', 'lastHighlightRequestAt', 'lastHighlightSignature', 'lastSegmentAt',
    'lastRecordStartAt', 'startRecordFailStreak', 'rollingBufferMax', 'replayBufferWindowMs',
    'rollingFsBusy', '_rollingPersistInFlight', '_postUserLocalPersistCooldownMs',
    'replayIntroDurationMs', 'replayOutroDurationMs', 'highlightMissStreak', 'highlightCopyFailStreak',
    'segmentPersistFailStreak', 'highlightMaterializeQueue', '_highlightMaterializeUrgentOnHide',
    'highlightMaterializeRunning', 'storageWatermarkLevel', 'highlightsMaxCount',
    'highlightsEmergencyMinKeepCount', 'segmentStartFailStormCycles', '_startOneSegmentInFlight',
    '_segmentStartRetryTimer', '_segmentStartRecoveringFromIsRecording',
    '_segmentStartRecoveringFromOperateFail', '_rollingTempMissingStreak',
    '_rollingTempTerminalFailStreak', '_tempMissingHardRecoverCycles', '_lastSuccessfulChunkAt',
    '_lastSegmentOperateFailAt', '_segmentWatchdogRecovering', '_lastSegmentWatchdogRecoverAt',
    'lastZoomVal', 'isPinching', 'isMultiTouch', 'pinchStartDistance', 'pinchStartZoom'
  ],
  'live-match-behavior': [
    'resolveMatchIdForHighlightStorage', 'syncMatchConfigFromPageSources', 'applyMatchSwitchConfig',
    'formatExpireForDisplay', 'normalizeMatchConfig', 'buildSportUiPatch', 'refreshSportUiMeta',
    'onPeriodLongPress', 'onPeriodTap', 'onScoreTap', 'applyScoreChange', 'applyBadmintonScoreChange',
    'toggleServingTeamManually', 'onBackTap', 'onScoreLongPress', 'onScoreTouchEnd',
    'flashPeriod', 'persistConfig', 'getDisplayTeamNameCharCount', 'computeTeamGroupWidthPx',
    'updateTeamGroupWidth'
  ],
  'live-scoreboard-behavior': [
    '_estimateProScoreboardWidthPx', '_estimateProScoreboardHeightPx', '_estimateProMatchNameBarWidthPx',
    '_estimateProMatchNameBarHeightPx', '_computeProMatchNameDefaultInStage',
    '_computeProScoreboardTopRightInStage', '_commitProScoreboardMovablePosition',
    '_syncProScoreboardCornerLayout', '_refineProScoreboardLayoutFromDom', '_initProScoreboardMovableLayout',
    'onProScoreboardPositionChange', '_commitProMatchNameMovablePosition', '_syncProMatchNameLayout',
    '_refineProMatchNameLayoutFromDom', '_initProMatchNameMovableLayout', 'onProMatchNamePositionChange'
  ],
  'live-entitlement-behavior': [
    'buildVipGateStateFromCheckStatus', 'refreshLiveEntitlementAndResume', 'onVipGateRetryTap',
    'onVipGateSwitchMine', 'onVipGateCatchMove', 'noopCatchMove', 'stopVipGateInnerBubble',
    'markNeedManualRelaunch', '_ensureLiveCameraReady', '_liveCoreOnShowAfterEntitlement'
  ],
  'live-health-behavior': [
    'initHealthLogs', 'mirrorHealthToAudit', 'appendHealthLog', 'scheduleHealthLogFlush',
    'getLiveRollingDiagSnapshot', 'scheduleRemoteHealthLogUpload', 'buildDiagnosticLogHeaders',
    'flushRemoteHealthLogsNow', '_prepareLiveAuditExportFile', '_dismissAuditExportShare',
    '_showAuditExportReadyModal', '_shareLiveAuditFileNow', 'onPrepareLiveAuditExport',
    'onTapShareLiveAuditFile'
  ],
  'live-highlight-lock-behavior': [
    'beginHighlightSaving', 'endHighlightSaving', 'stopHighlightSaveProgressAnim',
    'startHighlightSaveProgressAnim', 'clearHighlightSavePipelineState', 'maybeReleaseHighlightSaveLock',
    'scheduleHighlightResumeUnlockFallback', 'abortHighlightAfterStopIfNeeded',
    'resolveHighlightCreatedAt', 'activateFileQuotaCircuitBreaker'
  ],
  'live-camera-behavior': [
    'onCameraInit', '_schedulePreviewRecordStartAfterCameraInit', 'getPreviewRecordWarmupMs',
    'isLiveForegroundRecordingRecoverPending', 'getPreviewRecordMinHighlightMs', 'getPreviewRecordHighlightGate',
    '_scheduleRollingKickoffWatchdog', '_maybeBootEnhanceRender', '_teardownEnhanceRender',
    'armNativeEnhanceModeRestoreAfterCameraRebuild', '_updateLiveStageLayout',
    '_applyPendingEnhanceModeAfterRecover', '_vkErrorToHuman', 'setEnhanceMode',
    '_deferTeardownEnhanceForPipeline', 'onCameraStop', 'onCameraError', 'triggerCameraFaultRecovery',
    'remountCameraComponent', '_remountCameraComponentImpl', 'rebuildCameraComponent',
    '_rebuildCameraComponentImpl', 'getAdaptiveRecordCooldownExtraMs', 'getIosParallelRollingStopExtraMs',
    'getSegmentStopToStartDelayMs', 'getEffectiveSegmentDurationMs', 'getIsRecordingConflictExtraStartDelayMs',
    'scheduleAfterStopRecord', 'scheduleAfterForcedStopReady', 'clearSegmentStartRetryTimer',
    'scheduleStartOneSegmentRetry', 'tryStartRollingWhenCameraReady', '_tryStartRollingWhenCameraReadyImpl',
    'updateZoom', 'syncNativeEnhanceZoomCompensation', 'detectCameraCapabilities',
    '_probeAndroidUltraWideZoom', 'getDeviceDefaultPreviewZoom', 'rebuildCameraViewModeStops',
    'resetViewModeToNormal', 'applyViewMode', 'touchPointsMap', 'onTouchStart', 'onTouchMove', 'onTouchEnd',
    'onCameraSettingsFabTap', 'onCameraViewModeTap', 'onCameraFocusControlTap', 'getDistance',
    'pageXYToCameraNorm', 'invokeSetTargetFocus', 'detectExposureHardwareSupport', 'applyExposureFromNorm',
    '_flushExposureNormToData', 'silentRefocusGeometricCenter', 'maybeSchedulePostZoomSilentFocus',
    'applyPreGameFocusAtPage', 'wakeLiveAeControls', 'onAeFocusBracketTap', 'scheduleAeLiveHide',
    'clearAeLiveHideTimer', 'onAeSunTouchStart', 'onAeSunTouchMove', 'onAeSunTouchEnd',
    'hexToRgba', 'getContrastColor', 'onEnhanceModePick', 'stopEnhanceToolbarBubble',
    'startEnhanceFpsPolling', 'stopEnhanceFpsPolling', 'onWebGLContextFatal', '_destructiveCameraRemount',
    '_armPostRemountEncodingProbe', '_runPostRemountEncodingProbe', '_scheduleHollowPipelineRestart',
    '_restartPreviewPipelineForHollow', '_armFramePulseMonitor'
  ],
  'live-recording-behavior': [
    'updatePipelineHealth', 'startHealthMonitor', 'stopHealthMonitor', 'startSegmentWatchdog',
    'stopSegmentWatchdog', 'getSegmentWatchdogTimeoutMs', 'checkSegmentHeartbeat',
    '_recoverAfterHighlightFlushMiss', 'requestPreviewRecordWatchdogRecover',
    'requestSegmentWatchdogRollingRecover', 'startRecoveryProgressAnim', 'stopRecoveryProgressAnim',
    'finalizeRecoveryAsFailed', 'hardRecoverLivePipeline', '_hardRecoverLivePipelineImpl',
    'onRecoveryFabTap', 'onRecoveryFabLongPress', 'onRecoveryFabTouchStart', 'onRecoveryFabTouchEnd',
    'clearRecoveryFabAck', 'emitRecoverySuccessFeedback', 'vibrate', 'vibrateHighlightSaved',
    'getHighlightDir', 'getRollingDir', 'ensureHighlightDir', 'ensureRollingDir', 'clearStaleRollingFiles',
    'persistRollingSegmentFromTemp', 'purgeAllRollingMp4', 'pruneRollingMp4ForQuota',
    'pruneSandboxOrphanMediaForQuota',
    '_collectRollingPathKeepSet', '_unlinkRollingMp4ExceptKeep', '_trimRollingMp4ToMaxCount',
    'pruneRollingDirOrphans',
    'startRollingRecording', '_ensurePreviewRecordPipeline', '_startRollingRecordingImpl',
    'startOneSegment', '_startOneSegmentImpl', 'stopOneSegment', '_stopOneSegmentImpl',
    'stopRollingRecording', '_stopRollingRecordingImpl', 'onSegmentRecorded', '_onSegmentRecordedLegacy',
    'recoverRollingPipelineForHighlight', 'maybeHardRecoverForTempMissingStorm',
    '_clearStaleReplayBufferForTimelineGap', '_scheduleRollingRestartAfterMatchSwitch',
    '_restartRollingAfterMatchSwitchImpl', '_resetRollingPipelineForMatchSwitch',
    'retainRollingSegmentsByPaths', 'releaseRollingSegmentsByPaths', '_releaseMaterializedRollingSources'
  ],
  'live-highlight-behavior': [
    '_logHighlightTrimDiagnostic', 'canMaterializeHighlightNow', '_collectHighlightExportPaths',
    '_collectHighlightPlaybackPaths', '_collectManifestReplayPlan', '_collectIndexedReplayPlan',
    '_isReplaySuspectFakeTrim', '_normalizeMaterializedReplaySeek', '_resolveRollingReplaySeek',
    '_resolveHighlightReplaySource', '_isHighlightPathPlayable', '_isHighlightSourceHollow',
    '_isRollingSegmentQualityHealthy', '_handleDegradedRollingSegment', '_needsAndroidMaterializedReplay',
    '_getHighlightClipFromStorage', '_clearReplayMaterializeWait', '_maybeStartDeferredMaterializeReplay',
    '_deferReplayUntilMaterialized', '_isHighlightItemPlayable', '_rejectHighlightReplayMissingFiles',
    '_kickHighlightMaterializeOnHide', 'pruneHighlightStorageForMatch', 'getTotalHighlightClipCount',
    'pruneOldestHighlightClipsFromStorage', 'pruneHighlightClipsWithInvalidFiles', 'evaluateStorageWatermark',
    'pruneIosSegmentBufferUserLocals', 'isMiniProgramFileQuotaExceeded', 'trimRollingSegmentBufferForQuota',
    'freeRollingFileStorageAggressive', 'buildIndexedHighlightItem', 'enqueueHighlightMaterializeTask',
    'processHighlightMaterializeQueue', 'onHighlightClick', '_tryGenerateHighlight', '_generateHighlight',
    '_validateHighlightChunkCoverage', '_abortHighlightForInsufficientBuffer', '_saveHighlight',
    'requestHighlightCapture', 'finalizeHighlight', 'formatTime', 'getHighlightList',
    'onBackgroundLongPress', 'materializeHighlightTask', '_retryMaterializeTask', '_persistTempLikeFile',
    '_materializeCopyOneSegment', '_applyHighlightClipUpdate'
  ],
  'live-storage-behavior': [
    'maybeToastFileStoragePressureFromGlobal', 'probeLiveSandboxStorage', '_syncCacheStorageLampData',
    '_onStorageSevereLockReleased', '_showLightHint', '_getOneOldestPrunableClipForCacheLamp',
    '_exportOneClipToAlbumForCacheLamp', 'onCacheStorageLampTap', 'maybeNotifyLiveStoragePressure',
    'startLiveSandboxStorageWatch', 'stopLiveSandboxStorageWatch', 'onStoragePressureModalDismiss',
    'onStoragePressureModalConfirm'
  ],
  'live-drawer-behavior': [
    'onShareAppMessage', 'onGuideToDyFrame', 'dismissGuide', '_refreshCameraAfterGuideDismiss',
    'openDrawerMode1', 'closeAllDrawers', 'closeDrawer', 'stopDrawerBubbling', 'stopLeftDrawerBubbling',
    'onDrawerBackdropMove', 'onPromoLoadTap', 'onPromoLoadInput', 'onPromoAdsPanelBackdropTap',
    'onPromoLoadConfirm', 'onClearPromoAdsTap', '_getPromoAdTargetHeightPx', '_getPromoMovableAreaSize',
    '_computePromoAdDisplaySize', '_snapPromoAdToEdge', '_schedulePromoAdEdgeSnap', '_computePromoAdScaledSize',
    '_applyPromoAdBaseSize', '_commitPromoAdScale', 'onPromoAdImageLoad', 'onPromoAdPositionChange',
    'onPromoAdTouchStart', 'onPromoAdTouchMove', 'onPromoAdTouchEnd', 'loadMatchList', 'openColorModal',
    'closeColorModal', 'onDownloadHighlightsToAlbumAndClearCache', 'stopColorModalBubbling',
    'onSelectModalTeam', 'onSwitchMatchFromModal', 'onChangeTeamColor', 'onSwitchMatch',
    'refreshDrawerHighlights', 'onDrawerImageError', 'onDrawerSelect', 'onDeleteHighlight',
    'doDeleteHighlight', '_saveHighlightToAlbumAndClean', '_enforceHighlightStorageLimit'
  ],
  'live-replay-behavior': [
    'pauseRollingForReplay', 'resumeRollingAfterReplay', 'startReplay', 'startReplayContinue',
    '_releaseReplayIntroMask', '_activeReplayVideoId', 'finishReplayToLive', 'onReplaySlotEnded',
    '_maybePrimeHiddenChainSlot', '_onReplaySlotTimeUpdate', 'onReplayVideoATimeUpdate',
    'onReplayVideoBTimeUpdate', '_enforceReplayHighlightWindow', 'onReplayVideoAEnded',
    'onReplayVideoBEnded', 'onReplayEnded', 'onReplayInterruptTap', '_applyPlaybackRateToSlot',
    '_maybeVkSeekOnPlay', 'onReplayVideoAPlay', 'onReplayVideoBPlay', 'onReplayVideoPlay',
    '_handleReplayLoadedMeta', 'onReplayVideoASeeked', 'onReplayVideoBSeeked', '_onReplaySlotSeeked',
    'onReplayVideoALoadedMeta', 'onReplayVideoBLoadedMeta', 'onReplayVideoLoadedMeta',
    'getReplayRotateDegForDevice', 'onReplaySpeedChange', 'onReplayClose', 'onReplayResetView',
    'onReplayViewChange', 'onReplayViewScale', 'onReplayPinchCaptureStart', 'onReplayPinchCaptureMove',
    'onReplayMovableTouchEnd', 'onReplayMovableTouchCancel', '_cancelReplayZoomAnim',
    '_clearReplayPinchSnapTimer', '_resetReplayTransformCache', '_touchReplayMergeCache',
    '_replayUpdatePinchFocal', '_getReplayViewportPx', '_easeOutCubic', '_nextReplayDiscreteScale',
    '_replayNearestDiscreteLevel', '_replayDiscreteLevelIndex', '_replayPickPinchSnapScale',
    '_finishReplayPinchSnap', '_clampReplayPan', '_replayApplyDoubleTapZoom', '_runReplayZoomAnim',
    '_runReplayPanZoomAnim'
  ],
  'live-lifecycle-behavior': [
    'onLoad', 'onShow', 'onHide', 'onUnload', 'onReady', '_initLiveCoreState', '_initCameraState',
    '_initLiveWsState', '_initLiveUiSettings'
  ]
};

const KEY_TO_GROUP = {};
Object.keys(BEHAVIOR_GROUPS).forEach((group) => {
  BEHAVIOR_GROUPS[group].forEach((key) => {
    KEY_TO_GROUP[key] = group;
  });
});

/**
 * @param {string} src
 */
function parsePageObject(src) {
  const pageStart = src.indexOf('Page({');
  if (pageStart < 0) throw new Error('Page({ not found');
  const preamble = src.slice(0, pageStart).trimEnd();
  let i = pageStart + 'Page({'.length;
  const keys = [];
  let dataBlock = '';

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.slice(i, i + 3) === '});') break;
    /** 跳过键之间的 JSDoc / 块注释 */
    if (src.slice(i, i + 3) === '/**') {
      const end = src.indexOf('*/', i + 3);
      if (end < 0) throw new Error('Unclosed block comment at ' + i);
      i = end + 2;
      continue;
    }
    if (src.slice(i, i + 2) === '/*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unclosed block comment at ' + i);
      i = end + 2;
      continue;
    }
    if (src.slice(i, i + 2) === '//') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }

    const keyMatch = src.slice(i).match(/^([a-zA-Z_@][a-zA-Z0-9_]*)\s*:\s*/);
    if (!keyMatch) throw new Error('Cannot parse key at index ' + i + ': ' + JSON.stringify(src.slice(i, i + 40)));
    const name = keyMatch[1];
    i += keyMatch[0].length;

    if (name === 'data') {
      const start = i;
      let depth = 0;
      let inStr = false;
      let strCh = '';
      for (; i < src.length; i++) {
        const ch = src[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === strCh) inStr = false;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === ',') i++;
      dataBlock = '  data: ' + src.slice(start, i).replace(/^\s*/, '').replace(/,\s*$/, '');
      continue;
    }

    const start = i;
    if (src.slice(i, i + 8) === 'function') {
      let depth = 0;
      let inStr = false;
      let strCh = '';
      for (; i < src.length; i++) {
        const ch = src[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === strCh) inStr = false;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
    } else {
      let depth = 0;
      let inStr = false;
      let strCh = '';
      for (; i < src.length; i++) {
        const ch = src[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === strCh) inStr = false;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) break;
      }
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === ',') i++;

    const raw = src.slice(start, i).replace(/,\s*$/, '');
    keys.push({ name, text: '    ' + name + ': ' + raw, isFunction: raw.trimStart().startsWith('function') });
  }

  return { preamble, keys, dataBlock };
}

/**
 * @param {string} preamble
 */
function splitPreamble(preamble) {
  const marker = '/** 推广 Logo 初始展示高度占屏幕高度比例';
  const layoutMarker = 'function formatCameraZoomLabel';
  const importsEnd = preamble.indexOf(marker);
  if (importsEnd < 0) throw new Error('constants marker not found');
  const importsBlock = preamble.slice(0, importsEnd).trimEnd();
  const rest = preamble.slice(importsEnd);
  const layoutStart = rest.indexOf(layoutMarker);
  if (layoutStart < 0) throw new Error('layout marker not found');
  const constantsBlock = rest.slice(0, layoutStart).trimEnd();
  const layoutBlock = rest.slice(layoutStart).trimEnd();
  return { importsBlock, constantsBlock, layoutBlock };
}

/**
 * @param {string} constantsBlock
 * @returns {string[]}
 */
function collectConstExports(constantsBlock) {
  const names = [];
  const constRe = /^const\s+([A-Z_][A-Z0-9_]*)\s*=/gm;
  let m;
  while ((m = constRe.exec(constantsBlock))) names.push(m[1]);
  if (constantsBlock.includes('function resolveCurrentUserOpenId')) names.push('resolveCurrentUserOpenId');
  if (constantsBlock.includes('const CameraViewMode')) names.push('CameraViewMode');
  return [...new Set(names)];
}

/**
 * @param {string[]} names
 * @returns {string}
 */
/**
 * @param {string[]} names
 * @param {string} relDir '' 或 '../'
 */
function buildConstDestructuring(names, relDir) {
  if (!names.length) return '';
  return 'const {\n  ' + names.join(',\n  ') + '\n} = require(\'' + relDir + 'live-constants.js\');\n';
}

/**
 * 从 live.js 顶部 import 段剥离仅入口需要的 behavior require。
 * @param {string} importsBlock
 */
function splitImportsBlock(importsBlock) {
  const lines = importsBlock.split('\n');
  const core = [];
  const pageOnly = [];
  lines.forEach((line) => {
    if (/footballClockBehavior|liveWsBehavior/.test(line)) pageOnly.push(line);
    else core.push(line);
  });
  return { coreImports: core.join('\n').trimEnd(), pageOnlyImports: pageOnly.join('\n').trimEnd() };
}

/**
 * @param {string} constNames
 * @param {string} relDir 行为模块用 '../'，live.js 入口用 './'
 * @returns {string}
 */
function buildSharedPreamble(constNames, relDir) {
  const helpersPath = relDir === './' ? './behaviors/live-helpers.js' : './live-helpers.js';
  return `const LIVE_SHARED = require('${relDir}live-shared-imports.js');
const {
  app,
  get,
  getToken,
  post,
  STORAGE_USER_INFO_KEY,
  API_PATH_CLIENT_DIAGNOSTIC_LOG,
  parseExpireAtToMs,
  storageEst,
  clipsStorage,
  replayBufferMod,
  LIVE_AUDIT,
  checkSyncLabWhitelist,
  liveWsClientMod,
  loadPromoAds,
  SHARE_IMAGE_URL
} = LIVE_SHARED;

const LIVE_LAYOUT = require('${relDir}live-layout.js');
const liveHelpers = require('${helpersPath}');
${buildConstDestructuring(constNames, relDir)}
const {
  formatCameraZoomLabel,
  isLiveHostIos,
  getDefaultPreviewZoomForMax,
  computeLiveStage16x9SizePx,
  computeLiveStage16x9RectPx,
  buildCornerFabStylesInLetterboxPx
} = LIVE_LAYOUT;
const {
  formatWxsMainText,
  FOOTBALL_HALF2_START_SEC,
  FOOTBALL_EXTRA_START_SEC,
  DEFAULT_FOOTBALL_STATE,
  normalizeFootballState,
  migrateLegacyFootballPeriod,
  getFootballHalfLabelParts,
  getFootballHalfLabel,
  SPORT_BASKETBALL,
  SPORT_FOOTBALL,
  SPORT_BADMINTON,
  normalizeSportType,
  DEFAULT_BADMINTON_STATE,
  checkBadmintonSetWin,
  buildBadmintonSetHistoryDisplay,
  computeClockDisplayFromBundle
} = liveHelpers;`;
}

/**
 * @param {string} groupName
 * @param {Array<{ name: string, text: string }>} entries
 * @param {string} sharedPreamble
 */
function buildBehaviorFile(groupName, entries, sharedPreamble) {
  const body = entries.map((e) => e.text).join(',\n');
  return `/**
 * Live 页 · ${groupName.replace('live-', '').replace(/-/g, ' ')} 域
 * 由 scripts/partition-live-page.js 生成，逻辑与拆分前 live.js 一致。
 */
${sharedPreamble}

module.exports = Behavior({
  methods: {
${body}
  }
});
`;
}

/**
 * @param {Array<{ name: string, text: string }>} entries
 * @param {string} sharedPreamble
 */
function buildStateBehaviorFile(entries, sharedPreamble) {
  const body = entries.map((e) => e.text.replace(/^    /, '  ')).join(',\n');
  return `/**
 * Live 页 · 实例状态字段（非 data）
 * 由 scripts/partition-live-page.js 生成，逻辑与拆分前 live.js 一致。
 */
${sharedPreamble}

module.exports = Behavior({
${body}
});
`;
}

/**
 * @param {string} name
 */
function toCamel(name) {
  return name.replace(/^live-/, 'live').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  if (!fs.existsSync(BACKUP)) {
    fs.copyFileSync(SRC, BACKUP);
    console.log('Backup -> live.js.bak');
  }

  const { preamble, keys, dataBlock } = parsePageObject(src);
  const { importsBlock, constantsBlock, layoutBlock } = splitPreamble(preamble);
  const { coreImports, pageOnlyImports } = splitImportsBlock(importsBlock);
  const constNames = collectConstExports(constantsBlock);
  const sharedPreamble = buildSharedPreamble(constNames, '../');

  fs.writeFileSync(path.join(LIVE_DIR, 'live-shared-imports.js'), `/**
 * Live 页共享依赖（utils / services / audit）
 * 供 live.js 与各 behavior 模块复用，避免路径重复与 require 膨胀。
 */
${coreImports}

module.exports = {
  app,
  get,
  getToken,
  post,
  STORAGE_USER_INFO_KEY,
  API_PATH_CLIENT_DIAGNOSTIC_LOG,
  parseExpireAtToMs,
  storageEst,
  clipsStorage,
  replayBufferMod,
  LIVE_AUDIT,
  checkSyncLabWhitelist,
  liveWsClientMod,
  loadPromoAds,
  SHARE_IMAGE_URL
};
`);
  console.log('Wrote live-shared-imports.js');

  fs.writeFileSync(path.join(LIVE_DIR, 'live-constants.js'), `/**
 * Live 页常量（计时、回放、相机、存储等阈值）
 */
${constantsBlock}

module.exports = {
  ${constNames.join(',\n  ')}
};
`);

  fs.writeFileSync(path.join(LIVE_DIR, 'live-layout.js'), `/**
 * Live 页布局与相机预览纯函数
 */
${layoutBlock}

module.exports = {
  formatCameraZoomLabel,
  isLiveHostIos,
  getDefaultPreviewZoomForMax,
  computeLiveStage16x9SizePx,
  computeLiveStage16x9RectPx,
  buildCornerFabStylesInLetterboxPx
};
`);

  const grouped = {};
  const unassigned = [];
  keys.forEach((k) => {
    if (k.name === 'behaviors') return;
    const g = KEY_TO_GROUP[k.name];
    if (!g) {
      unassigned.push(k);
      return;
    }
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(k);
  });

  if (unassigned.length) {
    console.warn('Unassigned keys:', unassigned.map((k) => k.name).join(', '));
    throw new Error('Some Page keys are not mapped to a behavior group');
  }

  const behaviorNames = Object.keys(BEHAVIOR_GROUPS);
  behaviorNames.forEach((groupName) => {
    const entries = grouped[groupName] || [];
    if (!entries.length) return;
    const isState = groupName === 'live-state-behavior';
    const content = isState
      ? buildStateBehaviorFile(entries, sharedPreamble)
      : buildBehaviorFile(groupName, entries, sharedPreamble);
    fs.writeFileSync(path.join(LIVE_DIR, 'behaviors', groupName + '.js'), content);
    console.log('Wrote behaviors/' + groupName + '.js (' + entries.length + ' keys)');
  });

  const behaviorRequires = behaviorNames
    .filter((g) => grouped[g] && grouped[g].length)
    .map((g) => `const ${toCamel(g)} = require('./behaviors/${g}.js');`)
    .join('\n');

  const behaviorList = behaviorNames
    .filter((g) => grouped[g] && grouped[g].length)
    .map((g) => toCamel(g))
    .join(', ');

  const liveEntryPreamble = buildSharedPreamble(constNames, './');

  const newLiveJs = `${liveEntryPreamble}
${pageOnlyImports}
${behaviorRequires}

/**
 * Live 直播页入口（薄壳）
 * ─────────────────────────────────────────────────────────
 * 按功能域拆分至 pages/live/behaviors/，开发时只需阅读相关模块：
 *   live-match-behavior        记分 / 场次配置
 *   live-scoreboard-behavior   足球/羽毛球浮层记分牌
 *   live-entitlement-behavior  权益 / VIP 门禁
 *   live-health-behavior       健康日志 / 审计导出
 *   live-highlight-lock-behavior 高光保存事务锁
 *   live-camera-behavior       相机 / 曝光 / 变焦
 *   live-recording-behavior    滚动录制 / 看门狗 / 恢复
 *   live-highlight-behavior    高光生成 / 固化 / 存储
 *   live-storage-behavior      存储水位 / 缓存灯
 *   live-drawer-behavior       抽屉 / 推广 / 场次切换 UI
 *   live-replay-behavior       回放 / 缩放 / 双槽播放
 *   live-lifecycle-behavior    生命周期 onLoad/onShow/...
 *   live-state-behavior        实例状态字段（非 data）
 * 常量：live-constants.js | 布局纯函数：live-layout.js | 运动工具：behaviors/live-helpers.js
 */
Page({
  behaviors: [footballClockBehavior, liveWsBehavior, ${behaviorList}],
${dataBlock}
});
`;

  fs.writeFileSync(SRC, newLiveJs);
  console.log('Wrote live.js (' + newLiveJs.split('\n').length + ' lines)');
}

main();

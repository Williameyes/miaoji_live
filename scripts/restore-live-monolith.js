/**
 * 恢复 live.js 单文件，并注入 @region 分区标记 + @ai-live-index 速查表。
 * 删除拆分产生的 behavior / 辅助模块（保留既有 footballClock / liveWs / live-helpers）。
 */
const fs = require('fs');
const path = require('path');

const LIVE_DIR = path.join(__dirname, '../pages/live');
const BACKUP = path.join(LIVE_DIR, 'live.js.bak');
const LIVE_FILE = path.join(LIVE_DIR, 'live.js');

/** @type {Array<{ region: string, anchor: string, desc: string, symptoms: string }>} */
const REGIONS = [
  {
    region: 'LIVE_CONSTANTS',
    anchor: '/** 推广 Logo 初始展示高度',
    desc: '阈值常量、运动类型、布局纯函数',
    symptoms: '改超时/阈值/回放档位/足球计时常量'
  },
  {
    region: 'LIVE_DATA',
    anchor: 'Page({',
    desc: 'Page data 初始状态',
    symptoms: '改 UI 默认值、data 字段、wxml 绑定初值'
  },
  {
    region: 'LIVE_MATCH',
    anchor: 'resolveMatchIdForHighlightStorage: function',
    desc: '场次配置、记分、节次',
    symptoms: '记分/syncMatchConfig/换场次/队名宽度'
  },
  {
    region: 'LIVE_SCOREBOARD',
    anchor: '_estimateProScoreboardWidthPx: function',
    desc: '足球/羽毛球浮层记分牌与赛名条',
    symptoms: '记分牌拖动/赛名浮层/角球布局'
  },
  {
    region: 'LIVE_ENTITLEMENT',
    anchor: 'buildVipGateStateFromCheckStatus: function',
    desc: 'VIP 权益、直播门禁、camera 准入',
    symptoms: 'VIP 门/权益/liveStreamAllowed/黑屏门禁'
  },
  {
    region: 'LIVE_HEALTH',
    anchor: 'initHealthLogs: function',
    desc: '健康日志、审计导出',
    symptoms: 'audit/appendHealthLog/诊断上传'
  },
  {
    region: 'LIVE_HIGHLIGHT_LOCK',
    anchor: 'beginHighlightSaving: function',
    desc: '高光保存事务锁与进度动画',
    symptoms: 'isSavingHighlight/保存锁/进度环'
  },
  {
    region: 'LIVE_CAMERA',
    anchor: 'onCameraInit: function',
    desc: '相机、16:9 布局、曝光对焦、变焦机位',
    symptoms: '相机黑屏/横屏/布局/变焦/曝光/对焦/AE'
  },
  {
    region: 'LIVE_RECORDING',
    anchor: 'updatePipelineHealth: function',
    desc: '滚动录制、看门狗、硬恢复、乒乓缓冲',
    symptoms: '录制/REC 灯/segment/ping-pong/hardRecover'
  },
  {
    region: 'LIVE_HIGHLIGHT',
    anchor: '_logHighlightTrimDiagnostic: function',
    desc: '高光生成、裁剪、固化、存储淘汰',
    symptoms: '保存高光/trim/materialize/高光列表'
  },
  {
    region: 'LIVE_STORAGE',
    anchor: 'maybeToastFileStoragePressureFromGlobal: function',
    desc: '存储水位、缓存灯、空间弹窗',
    symptoms: '存储/severe/缓存灯/空间不足'
  },
  {
    region: 'LIVE_DRAWER',
    anchor: 'onShareAppMessage: function',
    desc: '抽屉、推广 Logo、场次切换 UI',
    symptoms: '抽屉/推广/换场/颜色浮层'
  },
  {
    region: 'LIVE_REPLAY',
    anchor: 'pauseRollingForReplay: function',
    desc: '回放、双槽播放、捏合缩放',
    symptoms: '回放/倍速/replay 缩放/intro-outro'
  },
  {
    region: 'LIVE_LIFECYCLE',
    anchor: 'onLoad: function',
    desc: 'onLoad/onShow/onHide/onReady/onUnload、初始化',
    symptoms: '生命周期/横屏 setPageOrientation/进页初始化'
  }
];

/**
 * @param {string} src
 */
function buildAiIndex(src) {
  const rows = REGIONS.map((r) => {
    const idx = src.indexOf(r.anchor);
    const line = idx >= 0 ? src.slice(0, idx).split('\n').length : '?';
    return ` * | ${r.symptoms} | @region ${r.region} | L~${line} | ${r.desc} |`;
  });
  return `/**
 * @ai-live-index Live 页单文件分区速查（AI 开发必读）
 * ─────────────────────────────────────────────────────────
 * 本页约 1.3 万行，请勿通读。按用户症状在下表找到 @region，再 Grep 搜「@region XXX」跳到分区。
 *
 * | 症状/需求关键词 | 分区标记 | 约行号 | 说明 |
${rows.join('\n')}
 *
 * 辅助文件（非 live.js）：behaviors/live-helpers.js、footballClockBehavior.js、liveWsBehavior.js
 */
`;
}

/**
 * @param {string} src
 */
function injectRegionMarkers(src) {
  let out = src;
  const sorted = [...REGIONS].sort((a, b) => out.indexOf(b.anchor) - out.indexOf(a.anchor));
  sorted.forEach((r) => {
    const idx = out.indexOf(r.anchor);
    if (idx < 0) {
      console.warn('Anchor not found:', r.region, r.anchor.slice(0, 40));
      return;
    }
    const marker = `/** @region ${r.region} — ${r.desc} */\n`;
    if (out.slice(Math.max(0, idx - 80), idx).includes('@region ' + r.region)) return;
    out = out.slice(0, idx) + marker + out.slice(idx);
  });
  return out;
}

function main() {
  if (!fs.existsSync(BACKUP)) {
    throw new Error('Missing live.js.bak — cannot restore monolith');
  }
  let src = fs.readFileSync(BACKUP, 'utf8');
  const shareIdx = src.indexOf('const SHARE_IMAGE_URL');
  if (shareIdx < 0) throw new Error('Cannot find insert point');
  const insertAt = src.indexOf('\n', shareIdx) + 1;
  const indexBlock = buildAiIndex(src) + '\n';
  src = src.slice(0, insertAt) + indexBlock + injectRegionMarkers(src.slice(insertAt));
  fs.writeFileSync(LIVE_FILE, src);
  console.log('Restored live.js monolith with @ai-live-index +', REGIONS.length, 'regions');
  console.log('Lines:', src.split('\n').length);

  const toDelete = [
    'live-constants.js',
    'live-layout.js',
    'live-shared-imports.js',
    'behaviors/live-camera-behavior.js',
    'behaviors/live-scoreboard-behavior.js',
    'behaviors/live-replay-behavior.js',
    'behaviors/live-entitlement-behavior.js',
    'behaviors/live-match-behavior.js',
    'behaviors/live-storage-behavior.js',
    'behaviors/live-highlight-lock-behavior.js',
    'behaviors/live-recording-behavior.js',
    'behaviors/live-drawer-behavior.js',
    'behaviors/live-lifecycle-behavior.js',
    'behaviors/live-highlight-behavior.js',
    'behaviors/live-health-behavior.js'
  ];
  toDelete.forEach((rel) => {
    const p = path.join(LIVE_DIR, rel);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('Removed', rel);
    }
  });
}

main();

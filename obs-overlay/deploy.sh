#!/bin/bash

echo "=== 开始部署高光记分 OBS 网页 Overlay (等比紧凑专业排版，绝不拉伸变形) ==="

sudo mkdir -p /var/www/gaoguang-obs-overlay
sudo chown -R ubuntu:ubuntu /var/www/gaoguang-obs-overlay

cat << 'EOF' > /var/www/gaoguang-obs-overlay/index.html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>高光记分 - OBS 专业直播记分牌</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <!-- 网页端/OBS 实时连接状态标识栏 (右上角极简提示) -->
  <div class="ws-status-banner" id="ws-status-banner">
    <span class="status-dot"></span>
    <span class="status-text" id="ws-status-text">⏳ 正在连接中控台...</span>
  </div>

  <!-- 左侧灵动岛专业电视转播级「LIVE 现场直播」纵向遮罩角标 (专为遮盖 iPhone 横屏左侧中部的灵动岛及绿点设计，支持等比缩放与拖动) -->
  <div class="dynamic-island-badge" id="dynamic-island-badge" title="可拖动调整位置，滚轮可等比缩放大小">
    <div class="live-top-pill">
      <span class="live-pulse-dot"></span>
      <span class="live-en-text">LIVE</span>
    </div>
    <div class="live-v-divider"></div>
    <div class="live-vertical-title" id="live-title">
      <span>现</span>
      <span>场</span>
      <span>直</span>
      <span>播</span>
    </div>
  </div>

  <!-- 16:9 全高清广播级自适应转播记分牌 (居中底部，比例清晰大气) -->
  <div class="obs-container" id="obs-container">
    <div class="broadcast-scoreboard-wrapper" id="scoreboard-wrapper">
      <div class="broadcast-scoreboard" id="scoreboard">
        <!-- 顶部比赛名称 (精致半透深色胶囊) -->
        <div class="match-title-row">
          <span class="match-title-text" id="match-title">常规赛</span>
        </div>

        <!-- 核心水平一体化转播记分条 (广播级黄金比例，自适应高清字号) -->
        <div class="score-ribbon-bar">
          <!-- 主队板块 (左侧圆角 + 纯色背景 + 队名靠左 + 分数靠中，文字根据队服颜色自动高对比变色) -->
          <div class="team-ribbon team-ribbon--home" id="home-ribbon" style="background-color: #E64340;">
            <span class="team-name team-name--home" id="home-name">主队</span>
            <span class="team-score team-score--home" id="home-score">0</span>
          </div>

          <!-- 中间节次立体胶囊 (与小程序 live 页 100% 一致：上红中蓝下深蓝立体渐变) -->
          <div class="period-capsule-wrap">
            <div class="period-capsule" id="period-capsule">
              <span class="period-label" id="period-badge">第 1 节</span>
            </div>
          </div>

          <!-- 客队板块 (右侧圆角 + 纯色背景 + 分数靠中 + 队名靠右，文字根据队服颜色自动高对比变色) -->
          <div class="team-ribbon team-ribbon--away" id="away-ribbon" style="background-color: #10AEFF;">
            <span class="team-score team-score--away" id="away-score">0</span>
            <span class="team-name team-name--away" id="away-name">客队</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="./overlay.js"></script>
</body>
</html>
EOF

cat << 'EOF' > /var/www/gaoguang-obs-overlay/style.css
* {
  box-sizing: border-box;
  user-select: none;
}

body, html {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background-color: transparent !important;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

/* ──────────────────────────────────────────────
   顶部状态提示微胶囊 (仅连接中/断开时短暂浮现)
────────────────────────────────────────────── */
.ws-status-banner {
  position: absolute;
  top: 12px;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 600;
  color: #FFFFFF;
  background: rgba(255, 149, 0, 0.9);
  backdrop-filter: blur(8px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  transition: opacity 0.6s ease, transform 0.3s ease;
  z-index: 9999;
  pointer-events: none;
}

.ws-status-banner.connected {
  background: rgba(52, 199, 89, 0.92);
}

.ws-status-banner.error {
  background: rgba(255, 59, 48, 0.92);
}

.ws-status-banner.fade-out {
  opacity: 0;
  pointer-events: none;
  transform: translateY(-6px);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: #FFFFFF;
  display: inline-block;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
  100% { opacity: 1; transform: scale(1); }
}

/* ──────────────────────────────────────────────
   左侧灵动岛专业电视转播级「LIVE 现场直播」纵向遮罩角标
   专为遮盖 iPhone 横屏时左侧中部的灵动岛黑胶囊及指示绿点
   采用与记分牌节次一致的经典转播皇室蓝渐变 (#3B82F6 -> #2563EB -> #1D4ED8)
   始终保持等比精致排版，杜绝字距被拉开变形
────────────────────────────────────────────── */
.dynamic-island-badge {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 36px;
  height: 136px;
  padding: 8px 3px;
  background: linear-gradient(180deg, #3B82F6 0%, #2563EB 50%, #1D4ED8 100%);
  border-top: 1.5px solid rgba(255, 255, 255, 0.7);
  border-right: 1.2px solid rgba(255, 255, 255, 0.5);
  border-bottom: 1.2px solid rgba(255, 255, 255, 0.3);
  border-left: none;
  border-radius: 0 18px 18px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.55), 0 0 14px rgba(37, 99, 235, 0.45), inset 0 1.2px 0 rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(12px);
  transition: transform 0.2s ease, opacity 0.3s ease;
  user-select: none;
  cursor: grab;
  box-sizing: border-box;
}

.dynamic-island-badge:active {
  cursor: grabbing;
}

/* 顶部 LIVE 胶囊与呼吸发光点 */
.live-top-pill {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  flex-shrink: 0;
}

.live-pulse-dot {
  position: relative;
  width: 7px;
  height: 7px;
  background-color: #FFFFFF;
  border-radius: 50%;
  box-shadow: 0 0 8px #FFFFFF, 0 0 14px rgba(96, 165, 250, 0.9);
  flex-shrink: 0;
}

.live-pulse-dot::after {
  content: '';
  position: absolute;
  top: -3.5px;
  left: -3.5px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.5);
  animation: livePulseWave 1.8s infinite cubic-bezier(0.25, 0.8, 0.25, 1);
}

@keyframes livePulseWave {
  0% { transform: scale(0.5); opacity: 1; }
  100% { transform: scale(2.5); opacity: 0; }
}

.live-en-text {
  font-family: 'DIN Alternate', 'Impact', 'SF Pro Display', -apple-system, sans-serif;
  font-size: 11px;
  font-weight: 900;
  color: #FFFFFF;
  letter-spacing: 0.8px;
  line-height: 1;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

.live-v-divider {
  width: 18px;
  height: 1.2px;
  background: rgba(255, 255, 255, 0.45);
  border-radius: 1px;
  margin: 1px 0 2px;
  flex-shrink: 0;
}

/* 纵向现场直播标题 (固定 4.5px 紧凑间距，杜绝拉伸稀疏) */
.live-vertical-title {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4.5px;
  flex-shrink: 0;
}

.live-vertical-title span {
  font-size: 11.5px;
  font-weight: 800;
  color: #FFFFFF;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  line-height: 1.1;
  letter-spacing: 0.2px;
}

/* 隐藏右下角拉手图标，防止直播画面出现多余白角 */
.island-resize-handle {
  display: none !important;
}

/* 独立灵动岛遮罩组件模式 (可在 OBS 中作为小窗口图层，用鼠标在画布上 100% 随意拖动和任意缩放拉伸) */
body.mode-island-only .obs-container,
body.mode-live-only .obs-container,
body.mode-island-only .ws-status-banner,
body.mode-live-only .ws-status-banner {
  display: none !important;
}

body.mode-island-only .dynamic-island-badge,
body.mode-live-only .dynamic-island-badge {
  position: fixed !important;
  left: 50% !important;
  top: 50% !important;
  transform: translate(-50%, -50%) !important;
  margin: 0 !important;
  border-radius: 18px !important;
  border-left: 1.2px solid rgba(255, 255, 255, 0.5) !important;
  width: 36px !important;
  height: 136px !important;
}

/* ──────────────────────────────────────────────
   16:9 全高清全屏容器 (自适应 1920x1080 / 1280x720 满屏覆盖)
────────────────────────────────────────────── */
.obs-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: flex-end; /* 16:9 底部居中 */
  padding-bottom: clamp(20px, 3.2vh, 44px);
  box-sizing: border-box;
}

/* 可选：顶部居中布局模式 (通过 URL 参数 ?pos=top 开启) */
.obs-container.pos-top {
  align-items: flex-start;
  padding-top: clamp(20px, 3.2vh, 44px);
  padding-bottom: 0;
}

.broadcast-scoreboard-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ──────────────────────────────────────────────
   转播记分牌整体 (1080P 广播级黄金比例，自适应大字号)
────────────────────────────────────────────── */
.broadcast-scoreboard {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: clamp(580px, 42vw, 840px); /* 1080P 广播级适中大气宽度 (~720px) */
  filter: drop-shadow(0 4px 18px rgba(0, 0, 0, 0.75));
  z-index: 100;
  transition: transform 0.2s ease;
}

/* 顶部比赛标题 (精致深色微透胶囊) */
.match-title-row {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 6px;
  width: 100%;
}

.match-title-text {
  color: #FFFFFF;
  font-size: clamp(14px, 1.35vw, 18px);
  font-weight: 800;
  line-height: 1.2;
  padding: 3px 16px;
  background: rgba(15, 23, 42, 0.82);
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
  letter-spacing: 0.6px;
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 核心一体化记分横条 */
.score-ribbon-bar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border-radius: 8px;
  overflow: visible;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.6);
}

/* 主/客队色带块 */
.team-ribbon {
  flex: 1 1 0;
  height: clamp(48px, 4.6vw, 60px);
  display: flex;
  align-items: center;
  padding: 0 clamp(12px, 1.5vw, 22px);
  box-sizing: border-box;
  position: relative;
  transition: background-color 0.3s ease;
  box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, 0.4), inset 0 -1.5px 0 rgba(0, 0, 0, 0.25);
}

.team-ribbon--home {
  border-radius: 8px 0 0 8px;
  justify-content: space-between;
}

.team-ribbon--away {
  border-radius: 0 8px 8px 0;
  justify-content: space-between;
}

/* 队伍名称 (矢量高清，自动高对比度) */
.team-name {
  font-size: clamp(16px, 1.65vw, 23px);
  font-weight: 800;
  color: #FFFFFF;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.4px;
  transition: color 0.3s ease, text-shadow 0.3s ease;
}

/* 比分数字 (DIN 等宽数字、赛事级大字号、自动高对比度) */
.team-score {
  font-family: 'DIN Alternate', 'Impact', 'Chakra Petch', 'SF Pro Display', -apple-system, BlinkMacSystemFont, monospace, sans-serif;
  font-size: clamp(30px, 3.1vw, 42px);
  font-weight: 900;
  color: #FFFFFF;
  min-width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
  transition: color 0.3s ease, text-shadow 0.3s ease;
}

/* ──────────────────────────────────────────────
   中间节次立体高光胶囊
   与小程序 live.wxss 100% 一致：上红中蓝下深蓝经典转播渐变
────────────────────────────────────────────── */
.period-capsule-wrap {
  position: relative;
  z-index: 5;
  flex-shrink: 0;
  margin: 0 -3px;
}

.period-capsule {
  height: clamp(56px, 5.4vw, 70px);
  min-width: clamp(86px, 7.8vw, 116px);
  padding: 0 clamp(8px, 1vw, 16px);
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.98) 0%, rgba(59, 130, 246, 0.98) 50%, rgba(29, 78, 216, 0.98) 100%) !important;
  border-top: 1.5px solid rgba(255, 255, 255, 0.65);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6), inset 0 1.2px 0 rgba(255, 255, 255, 0.45);
}

.period-label {
  color: #FFFFFF;
  font-size: clamp(14px, 1.4vw, 19px);
  font-weight: 900;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  letter-spacing: 0.8px;
  white-space: nowrap;
}

/* 比分变动微动画 */
.bump {
  animation: bumpAnim 0.22s ease-out;
}

@keyframes bumpAnim {
  0% { transform: scale(1); }
  50% { transform: scale(1.22); }
  100% { transform: scale(1); }
}
EOF

cat << 'EOF' > /var/www/gaoguang-obs-overlay/overlay.js
(function () {
  'use strict';

  var urlParams = new URLSearchParams(window.location.search);
  var rawRoomId = urlParams.get('roomId') || urlParams.get('room_id') || urlParams.get('matchCode') || urlParams.get('matchId') || '666888';
  var digits = String(rawRoomId).replace(/\D/g, '');
  var roomId = digits.length >= 6 ? digits.slice(0, 6) : (digits + '666888').slice(0, 6);
  var apiBase = 'https://api.mx.server.ndcoo.com';

  var domObsContainer = document.getElementById('obs-container');
  var domScoreboardWrapper = document.getElementById('scoreboard-wrapper');
  var domScoreboard = document.getElementById('scoreboard');
  var domDynamicIslandBadge = document.getElementById('dynamic-island-badge');
  var domLiveTitle = document.getElementById('live-title');

  var domHomeRibbon = document.getElementById('home-ribbon');
  var domHomeName = document.getElementById('home-name');
  var domHomeScore = document.getElementById('home-score');

  var domAwayRibbon = document.getElementById('away-ribbon');
  var domAwayName = document.getElementById('away-name');
  var domAwayScore = document.getElementById('away-score');

  var domMatchTitle = document.getElementById('match-title');
  var domPeriod = document.getElementById('period-badge');

  var statusBanner = document.getElementById('ws-status-banner');
  var statusText = document.getElementById('ws-status-text');

  // 1. 模式参数
  var modeParam = urlParams.get('mode') || '';
  if (modeParam === 'live_only' || modeParam === 'island_only' || urlParams.get('liveOnly') === '1' || urlParams.get('islandOnly') === '1') {
    document.body.classList.add('mode-island-only');
  }

  // 2. 记分牌位置与间距参数 (?pos=top 或 ?pos=bottom，?bottom=40)
  var posParam = urlParams.get('pos') || 'bottom';
  if (domObsContainer && posParam === 'top') {
    domObsContainer.classList.add('pos-top');
  }
  var bottomParam = urlParams.get('bottom');
  if (bottomParam && domObsContainer && posParam !== 'top') {
    domObsContainer.style.paddingBottom = isNaN(bottomParam) ? bottomParam : bottomParam + 'px';
  }

  // 3. 记分牌整体缩放参数 (?scale=1.2 或 ?scale=0.9)
  var scaleParam = parseFloat(urlParams.get('scale'));
  if (!isNaN(scaleParam) && scaleParam > 0.3 && scaleParam < 3.0 && domScoreboard) {
    domScoreboard.style.transform = 'scale(' + scaleParam + ')';
    domScoreboard.style.transformOrigin = (posParam === 'top') ? 'top center' : 'bottom center';
  }

  // 4. 左侧灵动岛专业纵向「LIVE 现场直播」遮罩角标配置
  var hideIsland = urlParams.get('hideIsland') === '1' || urlParams.get('noIsland') === '1' || urlParams.get('live') === '0' || urlParams.get('live') === 'false';
  if (domDynamicIslandBadge && hideIsland) {
    domDynamicIslandBadge.style.display = 'none';
  } else if (domDynamicIslandBadge) {
    // 自定义纵向文案 (?liveText=现场直播 或 ?islandText=高清直播)
    var liveTextParam = urlParams.get('liveText') || urlParams.get('islandText');
    if (domLiveTitle && liveTextParam) {
      domLiveTitle.innerHTML = '';
      for (var i = 0; i < liveTextParam.length; i++) {
        var span = document.createElement('span');
        span.textContent = liveTextParam[i];
        domLiveTitle.appendChild(span);
      }
    }

    // 等比缩放参数 (?liveScale=1.2 或 ?islandScale=1.2) - 严格保持长宽比与字距，绝不拉伸变形
    var islandScale = parseFloat(urlParams.get('liveScale') || urlParams.get('islandScale') || urlParams.get('scaleIsland'));
    if (isNaN(islandScale) || islandScale <= 0.2) islandScale = 1.0;

    // 位置自定义微调 (?liveTop=48% 或 ?liveY=400, ?liveLeft=0)
    var liveTop = urlParams.get('liveTop') || urlParams.get('liveY') || urlParams.get('islandTop');
    var liveLeft = urlParams.get('liveLeft') || urlParams.get('liveX') || urlParams.get('islandLeft');

    function applyIslandTransform() {
      var isTopPercent = (liveTop && String(liveTop).includes('%'));
      if (!liveTop || isTopPercent) {
        var topVal = liveTop || '50%';
        domDynamicIslandBadge.style.top = topVal;
        domDynamicIslandBadge.style.transform = 'translateY(-50%) scale(' + islandScale + ')';
      } else {
        domDynamicIslandBadge.style.top = isNaN(liveTop) ? liveTop : liveTop + 'px';
        domDynamicIslandBadge.style.transform = 'scale(' + islandScale + ')';
      }
      domDynamicIslandBadge.style.transformOrigin = 'left center';
      if (liveLeft !== null) {
        domDynamicIslandBadge.style.left = isNaN(liveLeft) ? liveLeft : liveLeft + 'px';
      }
    }

    applyIslandTransform();

    // 交互式鼠标拖拽与滚轮等比缩放支持 (带本地缓存自动记忆)
    (function enableIslandDragAndResize() {
      var isDragging = false;
      var startX = 0, startY = 0;
      var initLeft = 0, initTop = 0;

      // 读取本地缓存位置与缩放
      try {
        var savedData = localStorage.getItem('obs_island_uniform_state');
        if (savedData && !liveTop && !liveLeft) {
          var p = JSON.parse(savedData);
          if (p.top) liveTop = p.top;
          if (p.left) liveLeft = p.left;
          if (p.scale && !urlParams.get('liveScale')) islandScale = p.scale;
          applyIslandTransform();
        }
      } catch (e) {}

      function saveState() {
        try {
          localStorage.setItem('obs_island_uniform_state', JSON.stringify({
            left: domDynamicIslandBadge.style.left,
            top: domDynamicIslandBadge.style.top,
            scale: islandScale
          }));
        } catch (e) {}
      }

      // 1. 鼠标拖动位置
      domDynamicIslandBadge.addEventListener('mousedown', function (e) {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        var rect = domDynamicIslandBadge.getBoundingClientRect();
        initLeft = rect.left;
        initTop = rect.top;
        domDynamicIslandBadge.style.transform = 'scale(' + islandScale + ')';
        domDynamicIslandBadge.style.transformOrigin = 'left center';
        e.preventDefault();
      });

      // 2. 滚轮自由等比缩放大小 (绝不拉伸变形)
      domDynamicIslandBadge.addEventListener('wheel', function (e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 0.05 : -0.05;
        islandScale = Math.max(0.5, Math.min(2.5, islandScale + delta));
        applyIslandTransform();
        saveState();
      });

      window.addEventListener('mousemove', function (e) {
        if (!isDragging) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        var newLeft = Math.max(0, initLeft + dx);
        var newTop = Math.max(0, initTop + dy);
        liveLeft = newLeft;
        liveTop = newTop;
        domDynamicIslandBadge.style.left = newLeft + 'px';
        domDynamicIslandBadge.style.top = newTop + 'px';
        domDynamicIslandBadge.style.transform = 'scale(' + islandScale + ')';
      });

      window.addEventListener('mouseup', function () {
        if (isDragging) {
          isDragging = false;
          saveState();
        }
      });
    })();
  }

  var currentHomeScore = null;
  var currentAwayScore = null;
  var bannerTimer = null;
  var heartbeatTimer = null;

  var currentHomeColor = '#E64340';
  var currentAwayColor = '#10AEFF';

  // ──────────────────────────────────────────────
  // 1. 队服颜色高对比度文字自适应计算
  // ──────────────────────────────────────────────
  function getContrastTextColor(hexColor) {
    if (!hexColor) return '#FFFFFF';
    var hex = String(hexColor).replace('#', '').trim();
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length !== 6) return '#FFFFFF';
    var r = parseInt(hex.substr(0, 2), 16) || 0;
    var g = parseInt(hex.substr(2, 2), 16) || 0;
    var b = parseInt(hex.substr(4, 2), 16) || 0;
    // YIQ 亮度感知公式
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 155 ? '#0F172A' : '#FFFFFF';
  }

  function applyTeamContrastStyle(nameEl, scoreEl, hexColor) {
    var textColor = getContrastTextColor(hexColor);
    var isDarkText = (textColor === '#0F172A');
    var textShadow = isDarkText ? '0 1px 2px rgba(255, 255, 255, 0.6)' : '0 1px 3px rgba(0, 0, 0, 0.85)';
    if (nameEl) {
      nameEl.style.color = textColor;
      nameEl.style.textShadow = textShadow;
    }
    if (scoreEl) {
      scoreEl.style.color = textColor;
      scoreEl.style.textShadow = textShadow;
    }
  }

  // ──────────────────────────────────────────────
  // 2. 记分牌数据解析与渲染
  // ──────────────────────────────────────────────
  function showStatus(text, state, autoFade) {
    if (!statusBanner || !statusText) return;
    statusText.textContent = text;
    statusBanner.className = 'ws-status-banner ' + (state || '');
    if (bannerTimer) clearTimeout(bannerTimer);
    if (autoFade) {
      bannerTimer = setTimeout(function () {
        statusBanner.classList.add('fade-out');
      }, 3000);
    }
  }

  function bumpAnimation(el) {
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
    setTimeout(function () { el.classList.remove('bump'); }, 200);
  }

  function formatPeriod(p) {
    var num = parseInt(p, 10);
    if (isNaN(num)) num = 1;
    if (num === 0) return '热身';
    if (num === 5) return '加时赛';
    if (num === 6) return '完赛';
    return '第 ' + num + ' 节';
  }

  function updateScore(home, away) {
    if (typeof home === 'number' && !isNaN(home)) {
      var isFirst = (currentHomeScore === null);
      if (home !== currentHomeScore || (domHomeScore && domHomeScore.textContent !== String(home))) {
        currentHomeScore = home;
        if (domHomeScore) {
          domHomeScore.textContent = home;
          if (!isFirst) bumpAnimation(domHomeScore);
        }
      }
    }
    if (typeof away === 'number' && !isNaN(away)) {
      var isFirstAway = (currentAwayScore === null);
      if (away !== currentAwayScore || (domAwayScore && domAwayScore.textContent !== String(away))) {
        currentAwayScore = away;
        if (domAwayScore) {
          domAwayScore.textContent = away;
          if (!isFirstAway) bumpAnimation(domAwayScore);
        }
      }
    }
  }

  // 核心：解码 match_id / session_id 中携带的全量比赛元数据
  function decodeMatchMeta(str) {
    if (!str || typeof str !== 'string') return null;

    if (str.indexOf('META64_') === 0 || str.indexOf('M64_') === 0) {
      try {
        var b64 = str.replace(/^(META64_|M64_)/, '');
        var binaryStr = atob(b64);
        var bytes = new Uint8Array(binaryStr.length);
        for (var i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        var decodedJson = '';
        if (typeof TextDecoder !== 'undefined') {
          decodedJson = new TextDecoder('utf-8').decode(bytes);
        } else {
          decodedJson = decodeURIComponent(escape(binaryStr));
        }
        var obj = JSON.parse(decodedJson);
        return {
          title: obj.t || obj.title || '',
          teamA: obj.a || obj.teamA || '',
          teamB: obj.b || obj.teamB || '',
          colorA: obj.ca ? '#' + obj.ca.replace('#', '') : (obj.colorA || ''),
          colorB: obj.cb ? '#' + obj.cb.replace('#', '') : (obj.colorB || ''),
          matchId: obj.id || obj.matchId || ''
        };
      } catch (e) {
        console.warn('[OBS Overlay] decodeMatchMeta b64 error:', e);
      }
    }

    if (str.indexOf('META_') === 0 || str.indexOf('M_') === 0) {
      try {
        var raw = str.replace(/^(META_|M_)/, '');
        var delimiter = raw.indexOf('~') !== -1 ? '~' : (raw.indexOf('|') !== -1 ? '|' : (raw.split('_').length >= 5 ? '_' : ''));
        if (delimiter) {
          var parts = raw.split(delimiter);
          if (parts.length >= 4) {
            return {
              title: decodeURIComponent(parts[0] || ''),
              teamA: decodeURIComponent(parts[1] || ''),
              teamB: decodeURIComponent(parts[2] || ''),
              colorA: parts[3] ? '#' + parts[3].replace('#', '') : '',
              colorB: parts[4] ? '#' + parts[4].replace('#', '') : '',
              matchId: parts[5] ? decodeURIComponent(parts[5]) : ''
            };
          }
        }
      } catch (e2) {
        console.warn('[OBS Overlay] decodeMatchMeta delimited error:', e2);
      }
    }

    if (str.charAt(0) === '{' && str.charAt(str.length - 1) === '}') {
      try {
        var jsonObj = JSON.parse(str);
        return {
          title: jsonObj.title || jsonObj.t || '',
          teamA: jsonObj.teamA || jsonObj.a || '',
          teamB: jsonObj.teamB || jsonObj.b || '',
          colorA: jsonObj.colorA || (jsonObj.ca ? '#' + jsonObj.ca.replace('#', '') : ''),
          colorB: jsonObj.colorB || (jsonObj.cb ? '#' + jsonObj.cb.replace('#', '') : ''),
          matchId: jsonObj.id || jsonObj.matchId || ''
        };
      } catch (e3) {}
    }

    return null;
  }

  function updateMatchInfo(msg) {
    if (!msg || typeof msg !== 'object') return;

    var d = msg;
    if (msg.payload && typeof msg.payload === 'object') {
      d = Object.assign({}, msg, msg.payload);
    } else if (msg.data && typeof msg.data === 'object') {
      d = Object.assign({}, msg, msg.data);
    }

    var meta = (d.meta && typeof d.meta === 'object') ? d.meta : {};

    var decodedFromMatchId = decodeMatchMeta(d.match_id);
    var decodedFromSessionId = decodeMatchMeta(d.session_id);
    var decoded = decodedFromMatchId || decodedFromSessionId || {};

    // 1. 比赛名称解析
    var title = d.title || d.matchTitle || d.match_title || d.matchName || d.match_name || d.name ||
      meta.title || meta.matchTitle || meta.matchName ||
      decoded.title || '';
    if (title && domMatchTitle) {
      domMatchTitle.textContent = title;
    }

    // 2. 队伍名称解析
    var nameA = d.teamA || d.team_a_name || d.teamAName || d.homeTeam || d.home_team || d.team1 ||
      (d.team_a && typeof d.team_a === 'object' && d.team_a.name) ||
      (d.teamA && typeof d.teamA === 'object' && d.teamA.name) ||
      meta.teamA || meta.team_a_name ||
      decoded.teamA ||
      (typeof d.team_a === 'string' ? d.team_a : '') ||
      '';
    var nameB = d.teamB || d.team_b_name || d.teamBName || d.awayTeam || d.away_team || d.team2 ||
      (d.team_b && typeof d.team_b === 'object' && d.team_b.name) ||
      (d.teamB && typeof d.teamB === 'object' && d.teamB.name) ||
      meta.teamB || meta.team_b_name ||
      decoded.teamB ||
      (typeof d.team_b === 'string' ? d.team_b : '') ||
      '';

    if (nameA && domHomeName) {
      domHomeName.textContent = nameA;
    }
    if (nameB && domAwayName) {
      domAwayName.textContent = nameB;
    }

    // 3. 球衣颜色解析并自动计算文字高对比度
    var colorA = d.colorA || d.color_a || d.color1 || d.homeColor || d.home_color ||
      (d.team_a && typeof d.team_a === 'object' && (d.team_a.bgColor || d.team_a.color)) ||
      (d.teamA && typeof d.teamA === 'object' && (d.teamA.bgColor || d.teamA.color)) ||
      meta.colorA || meta.color_a ||
      decoded.colorA ||
      '';
    var colorB = d.colorB || d.color_b || d.color2 || d.awayColor || d.away_color ||
      (d.team_b && typeof d.team_b === 'object' && (d.team_b.bgColor || d.team_b.color)) ||
      (d.teamB && typeof d.teamB === 'object' && (d.teamB.bgColor || d.teamB.color)) ||
      meta.colorB || meta.color_b ||
      decoded.colorB ||
      '';

    if (colorA) {
      currentHomeColor = colorA.startsWith('#') ? colorA : '#' + colorA;
      if (domHomeRibbon) domHomeRibbon.style.backgroundColor = currentHomeColor;
      applyTeamContrastStyle(domHomeName, domHomeScore, currentHomeColor);
    }
    if (colorB) {
      currentAwayColor = colorB.startsWith('#') ? colorB : '#' + colorB;
      if (domAwayRibbon) domAwayRibbon.style.backgroundColor = currentAwayColor;
      applyTeamContrastStyle(domAwayName, domAwayScore, currentAwayColor);
    }

    // 4. 比分解析
    var scoreA = undefined;
    if (typeof d.a === 'number') {
      scoreA = d.a;
    } else if (d.a !== undefined && d.a !== null && d.a !== '') {
      scoreA = parseInt(d.a, 10);
    } else if (d.team_a && typeof d.team_a === 'object' && typeof d.team_a.score !== 'undefined') {
      scoreA = parseInt(d.team_a.score, 10);
    } else if (typeof d.homeScore !== 'undefined') {
      scoreA = parseInt(d.homeScore, 10);
    }

    var scoreB = undefined;
    if (typeof d.b === 'number') {
      scoreB = d.b;
    } else if (d.b !== undefined && d.b !== null && d.b !== '') {
      scoreB = parseInt(d.b, 10);
    } else if (d.team_b && typeof d.team_b === 'object' && typeof d.team_b.score !== 'undefined') {
      scoreB = parseInt(d.team_b.score, 10);
    } else if (typeof d.awayScore !== 'undefined') {
      scoreB = parseInt(d.awayScore, 10);
    }

    if (scoreA !== undefined || scoreB !== undefined) {
      updateScore(scoreA, scoreB);
    }

    // 5. 节次解析
    var periodVal = (d.p !== undefined) ? d.p : ((d.period !== undefined) ? d.period : meta.period);
    if (periodVal !== undefined && domPeriod) {
      domPeriod.textContent = formatPeriod(periodVal);
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(ws) {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'BROADCAST_HEARTBEAT',
            sys_t: Date.now(),
            roomId: roomId,
            match_id: 'M_' + roomId,
            ping: 1
          }));
        } catch (e) {}
      }
    }, 12000);
  }

  function initWebSocket() {
    stopHeartbeat();
    showStatus('⏳ 正在连接中控台 (房间 ' + roomId + ')...', '', false);

    fetch(apiBase + '/api/get_token?roomId=' + roomId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.token) {
          showStatus('❌ 获取 Token 失败 (房间 ' + roomId + ')', 'error', false);
          setTimeout(initWebSocket, 5000);
          return;
        }

        var wsUrl = 'wss://api.mx.server.ndcoo.com/gaoguang-ws?roomId=' + roomId + '&token=' + encodeURIComponent(data.token);
        var ws = new WebSocket(wsUrl);

        ws.onopen = function () {
          console.log('[OBS Overlay] WebSocket Connected to room', roomId);
          showStatus('🟢 已成功连接中控台 (房间 ' + roomId + ')', 'connected', true);

          ws.send(JSON.stringify({
            type: 'BROADCAST_JOIN',
            roomId: roomId,
            sys_t: Date.now()
          }));

          startHeartbeat(ws);
        };

        ws.onmessage = function (event) {
          try {
            var payload = JSON.parse(event.data);
            console.log('[OBS Overlay] Message:', payload);
            updateMatchInfo(payload);
          } catch (err) {
            console.error('[OBS Overlay] Message Parse Error', err);
          }
        };

        ws.onclose = function () {
          console.warn('[OBS Overlay] WebSocket Closed, reconnecting...');
          stopHeartbeat();
          showStatus('🔴 中控台连接已断开，重新连接中...', 'error', false);
          setTimeout(initWebSocket, 3000);
        };

        ws.onerror = function (err) {
          console.error('[OBS Overlay] WebSocket Error', err);
          stopHeartbeat();
          showStatus('❌ 通信网络错误', 'error', false);
          try { ws.close(); } catch (e) {}
        };
      })
      .catch(function (err) {
        console.error('[OBS Overlay] Token Fetch Fail', err);
        showStatus('❌ 无法连接服务器网关', 'error', false);
        setTimeout(initWebSocket, 5000);
      });
  }

  // 初始默认高对比度应用
  applyTeamContrastStyle(domHomeName, domHomeScore, currentHomeColor);
  applyTeamContrastStyle(domAwayName, domAwayScore, currentAwayColor);

  initWebSocket();
})();
EOF

echo "=== 部署完成！OBS Overlay 已更新为等比紧凑专业排版 ==="

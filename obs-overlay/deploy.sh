#!/bin/bash

echo "=== 开始部署高光记分 OBS 网页 Overlay (16:9 全高清自适应记分牌) ==="

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
  <!-- 网页端/OBS 实时连接状态标识栏 (极简微型提示) -->
  <div class="ws-status-banner" id="ws-status-banner">
    <span class="status-dot"></span>
    <span class="status-text" id="ws-status-text">⏳ 正在连接中控台...</span>
  </div>

  <!-- 16:9 手机横屏紧凑型转播记分牌 (居中底部，比例精致适中) -->
  <div class="obs-container" id="obs-container">
    <div class="broadcast-scoreboard" id="scoreboard">
      <!-- 顶部比赛名称 -->
      <div class="match-title-row">
        <span class="match-title-text" id="match-title">常规赛</span>
      </div>

      <!-- 核心水平一体化转播记分条 (精致手机宽度 350px，高度 32px) -->
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

/* 顶部状态提示微胶囊 */
.ws-status-banner {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  align-items: gap;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  color: #FFFFFF;
  background: rgba(255, 149, 0, 0.88);
  backdrop-filter: blur(8px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  transition: opacity 0.6s ease, transform 0.3s ease;
  z-index: 9999;
  pointer-events: none;
}

.ws-status-banner.connected {
  background: rgba(52, 199, 89, 0.88);
}

.ws-status-banner.error {
  background: rgba(255, 59, 48, 0.88);
}

.ws-status-banner.fade-out {
  opacity: 0;
  pointer-events: none;
  transform: translateY(-6px);
}

.status-dot {
  width: 6px;
  height: 6px;
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
   16:9 全屏容器 (自适应 1920x1080 / 1280x720 满屏覆盖)
────────────────────────────────────────────── */
.obs-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: flex-end; /* 16:9 底部居中 */
  padding-bottom: clamp(10px, 2.2vh, 28px);
  box-sizing: border-box;
}

/* 可选：顶部居中布局模式 (通过 URL 参数 ?pos=top 开启) */
.obs-container.pos-top {
  align-items: flex-start;
  padding-top: clamp(10px, 2.2vh, 28px);
  padding-bottom: 0;
}

/* ──────────────────────────────────────────────
   转播记分牌整体 (根据 16:9 视口自适应黄金比例)
────────────────────────────────────────────── */
.broadcast-scoreboard {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: clamp(340px, 36vw, 480px);
  filter: drop-shadow(0 3px 12px rgba(0, 0, 0, 0.65));
  z-index: 100;
  transition: transform 0.2s ease;
}

/* 顶部比赛标题 */
.match-title-row {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 4px;
  width: 100%;
}

.match-title-text {
  color: #FFFFFF;
  font-size: clamp(11px, 1.1vw, 13px);
  font-weight: 700;
  line-height: 1.2;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 2px 6px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.4px;
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.95;
}

/* 核心一体化记分横条 */
.score-ribbon-bar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border-radius: 6px;
  overflow: visible;
}

/* 主/客队色带块 */
.team-ribbon {
  flex: 1 1 0;
  height: clamp(32px, 3.5vw, 40px);
  display: flex;
  align-items: center;
  padding: 0 clamp(8px, 1.2vw, 14px);
  box-sizing: border-box;
  position: relative;
  transition: background-color 0.3s ease;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.32);
}

.team-ribbon--home {
  border-radius: 6px 0 0 6px;
  justify-content: space-between;
}

.team-ribbon--away {
  border-radius: 0 6px 6px 0;
  justify-content: space-between;
}

/* 队伍名称 (自动高对比度) */
.team-name {
  font-size: clamp(12px, 1.25vw, 15px);
  font-weight: 700;
  color: #FFFFFF;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.2px;
  transition: color 0.3s ease, text-shadow 0.3s ease;
}

/* 比分数字 (等宽数字、专业赛事字体、自动高对比度) */
.team-score {
  font-family: 'DIN Alternate', 'Impact', 'Chakra Petch', 'SF Pro Display', -apple-system, BlinkMacSystemFont, monospace, sans-serif;
  font-size: clamp(19px, 2.1vw, 25px);
  font-weight: 800;
  color: #FFFFFF;
  min-width: 26px;
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
  margin: 0 -2px;
}

.period-capsule {
  height: clamp(38px, 4.2vw, 48px);
  min-width: clamp(56px, 6vw, 76px);
  padding: 0 clamp(6px, 0.8vw, 10px);
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.95) 0%, rgba(59, 130, 246, 0.95) 50%, rgba(29, 78, 216, 0.95) 100%) !important;
  border-top: 1.2px solid rgba(255, 255, 255, 0.55);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

.period-label {
  color: #FFFFFF;
  font-size: clamp(11px, 1.15vw, 13.5px);
  font-weight: 800;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.5px;
  white-space: nowrap;
}

/* 比分变动微动画 */
.bump {
  animation: bumpAnim 0.22s ease-out;
}

@keyframes bumpAnim {
  0% { transform: scale(1); }
  50% { transform: scale(1.3); }
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
  var domScoreboard = document.getElementById('scoreboard');
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

  // 位置参数 (?pos=top 或 ?pos=bottom，默认底部居中)
  var posParam = urlParams.get('pos') || 'bottom';
  if (domObsContainer && posParam === 'top') {
    domObsContainer.classList.add('pos-top');
  }

  // 缩放参数 (?scale=1.1 或 ?scale=0.9)
  var scaleParam = parseFloat(urlParams.get('scale'));
  if (!isNaN(scaleParam) && scaleParam > 0.3 && scaleParam < 3.0 && domScoreboard) {
    domScoreboard.style.transform = 'scale(' + scaleParam + ')';
    domScoreboard.style.transformOrigin = (posParam === 'top') ? 'top center' : 'bottom center';
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

echo "=== OBS Overlay 部署脚本对齐完毕 ==="

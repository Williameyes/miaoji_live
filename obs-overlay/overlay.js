(function () {
  'use strict';

  var urlParams = new URLSearchParams(window.location.search);
  var rawRoomId = urlParams.get('roomId') || urlParams.get('room_id') || urlParams.get('matchCode') || urlParams.get('matchId');
  if (!rawRoomId && window.location.search) {
    var match = window.location.search.match(/(?:roomId|room_id|room)=(\d+)/i);
    if (match) rawRoomId = match[1];
  }
  if (!rawRoomId && window.MIAOXIE_ROOM_ID) {
    rawRoomId = window.MIAOXIE_ROOM_ID;
  }
  if (!rawRoomId) {
    try { rawRoomId = localStorage.getItem('obs_room_id'); } catch (e) {}
  }
  if (!rawRoomId) rawRoomId = '666888';

  var digits = String(rawRoomId).replace(/\D/g, '');
  var roomId = digits.length >= 6 ? digits.slice(0, 6) : (digits + '666888').slice(0, 6);
  try { localStorage.setItem('obs_room_id', roomId); } catch (e) {}
  var apiBase = 'https://api.mx.server.ndcoo.com';

  var domObsContainer = document.getElementById('obs-container');
  var domScoreboardWrapper = document.getElementById('scoreboard-wrapper');
  var domScoreboard = document.getElementById('scoreboard');
  var domDynamicIslandBadge = document.getElementById('dynamic-island-badge');
  var domLiveTitle = document.getElementById('live-title');
  var domResizeHandle = document.getElementById('island-resize-handle');

  var domHomeRibbon = document.getElementById('home-ribbon');
  var domHomeName = document.getElementById('home-name');
  var domHomeScore = document.getElementById('home-score');

  var domAwayRibbon = document.getElementById('away-ribbon');
  var domAwayName = document.getElementById('away-name');
  var domAwayScore = document.getElementById('away-score');

  var domMatchTitle = document.getElementById('match-title');
  var domPeriod = document.getElementById('period-badge');

  var domTimeCropBox = document.getElementById('time-crop-box');
  var domTimeCropCanvas = document.getElementById('time-crop-canvas');
  var timeCropCanvasCtx = domTimeCropCanvas ? domTimeCropCanvas.getContext('2d') : null;

  var statusBanner = document.getElementById('ws-status-banner');
  var statusText = document.getElementById('ws-status-text');

  // 1. 模式参数
  var modeParam = urlParams.get('mode') || '';
  if (modeParam === 'live_only' || urlParams.get('liveOnly') === '1') {
    document.body.classList.add('mode-live-only');
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
    var liveTextParam = urlParams.get('liveText') || urlParams.get('islandText');
    if (domLiveTitle && liveTextParam) {
      domLiveTitle.innerHTML = '';
      for (var i = 0; i < liveTextParam.length; i++) {
        var span = document.createElement('span');
        span.textContent = liveTextParam[i];
        domLiveTitle.appendChild(span);
      }
    }

    var islandScale = parseFloat(urlParams.get('liveScale') || urlParams.get('islandScale') || urlParams.get('scaleIsland'));
    if (isNaN(islandScale) || islandScale <= 0.2) islandScale = 1.0;

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

    (function enableIslandDragAndResize() {
      var isDragging = false;
      var startX = 0, startY = 0;
      var initLeft = 0, initTop = 0;

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

      var domLiveCloseBtn = document.getElementById('live-close-btn');
      if (domLiveCloseBtn && domDynamicIslandBadge) {
        domLiveCloseBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          domDynamicIslandBadge.style.display = 'none';
        });
      }
    })();
  }

  var currentHomeScore = null;
  var currentAwayScore = null;
  var bannerTimer = null;
  var heartbeatTimer = null;

  var currentHomeColor = '#E64340';
  var currentAwayColor = '#10AEFF';

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
          matchId: obj.id || obj.matchId || '',
          timeRoomId: obj.tr || '',
          targetIndex: obj.ci || 0,
          clipIndex: obj.ci ? (obj.ci - 1) : 0,
          act: obj.act || ''
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
          matchId: jsonObj.id || jsonObj.matchId || '',
          timeRoomId: jsonObj.timeRoomId || jsonObj.tr || '',
          targetIndex: jsonObj.ci || jsonObj.targetIndex || 0,
          clipIndex: jsonObj.ci ? (jsonObj.ci - 1) : (jsonObj.clipIndex || 0),
          act: jsonObj.act || ''
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

    // 6. 赛场时间采集设备联动控制与高光回放控制
    var actType = String(d.act || (decoded && decoded.act) || '');
    var targetTimeRoom = (d.timeRoomId || d.time_room_id || (d.time_device && d.time_device.roomId) || (meta && meta.timeRoomId) || (meta && meta.tr) || (decoded && decoded.timeRoomId));
    var isTimeSyncOff = (actType === 'DISCONNECT_TIME_ROOM' || d.timeSyncEnabled === 0 || (d.time_device && d.time_device.enabled === false));
    var isTimeSyncOn = (actType === 'CONNECT_TIME_ROOM' || d.timeSyncEnabled === 1 || d.timeSyncEnabled === true || (d.time_device && d.time_device.enabled === true) || (targetTimeRoom && !isTimeSyncOff));

    if (actType.indexOf('START_HIGHLIGHT_REPLAY') === 0 || d.type === 'START_HIGHLIGHT_REPLAY') {
      var extractedFromAct = 0;
      if (actType.indexOf('START_HIGHLIGHT_REPLAY_') === 0) {
        extractedFromAct = parseInt(actType.replace('START_HIGHLIGHT_REPLAY_', ''), 10) || 0;
      }
      var finalTargetIndex = (extractedFromAct > 0) ? extractedFromAct : (d.targetIndex || (decoded && decoded.targetIndex) || (d.clipIndex !== undefined ? (d.clipIndex + 1) : 1));
      var mergedOptions = Object.assign({}, d, {
        targetIndex: finalTargetIndex,
        clipIndex: finalTargetIndex - 1
      });
      console.log('[OBS Overlay] Received START_HIGHLIGHT_REPLAY -> starting replay with options:', mergedOptions);
      startHighlightReplay(mergedOptions);
    } else if (actType === 'STOP_HIGHLIGHT_REPLAY' || d.type === 'STOP_HIGHLIGHT_REPLAY') {
      console.log('[OBS Overlay] Received STOP_HIGHLIGHT_REPLAY -> stopping replay');
      stopHighlightReplay();
    } else if (actType === 'TRIGGER_SAVE_HIGHLIGHT' || actType === 'SAVE_HIGHLIGHT' || d.type === 'TRIGGER_SAVE_HIGHLIGHT') {
      console.log('[OBS Overlay] Received TRIGGER_SAVE_HIGHLIGHT -> triggering OBS SaveReplayBuffer');
      triggerObsSaveReplayBuffer();
    }

    if (actType === 'CONNECT_TIME_ROOM' && targetTimeRoom) {
      console.log('[OBS Overlay] Received CONNECT_TIME_ROOM -> connecting time device:', targetTimeRoom);
      connectTimeDevice(targetTimeRoom);
    } else if (isTimeSyncOff) {
      console.log('[OBS Overlay] Received DISCONNECT_TIME_ROOM -> disconnecting time device');
      disconnectTimeDevice();
    } else if (targetTimeRoom && isTimeSyncOn) {
      console.log('[OBS Overlay] Snapshot has active time room -> connecting time device:', targetTimeRoom);
      connectTimeDevice(targetTimeRoom);
    }
  }

  // ──────────────────────────────────────────────
  // 2. 主记分 WebSocket 管理 (双向保活心跳 + 僵尸连接主动巡检 Watchdog)
  // ──────────────────────────────────────────────
  var mainWs = null;
  var mainLastRecvAt = Date.now();
  var mainReconnectTimer = null;
  var mainWatchdogTimer = null;
  var mainReconnectAttempt = 0;
  var isMainConnecting = false;

  function stopMainHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startMainHeartbeat(ws) {
    stopMainHeartbeat();
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
    }, 8000);
  }

  function scheduleMainReconnect(delayMs) {
    if (mainReconnectTimer) return;
    var wait = (typeof delayMs === 'number') ? delayMs : Math.min(10000, 1500 * Math.pow(1.5, mainReconnectAttempt));
    mainReconnectAttempt++;
    console.log('[OBS Overlay] Scheduling main reconnect in', wait, 'ms, attempt:', mainReconnectAttempt);
    showStatus('🔴 连接断开，正在自动重连...', 'error', false);
    mainReconnectTimer = setTimeout(function () {
      mainReconnectTimer = null;
      isMainConnecting = false;
      initWebSocket();
    }, wait);
  }

  function startMainWatchdog() {
    if (mainWatchdogTimer) clearInterval(mainWatchdogTimer);
    mainWatchdogTimer = setInterval(function () {
      if (!mainWs || mainWs.readyState === WebSocket.CLOSED || mainWs.readyState === WebSocket.CLOSING) {
        if (!isMainConnecting && !mainReconnectTimer) {
          console.warn('[OBS Overlay][Watchdog] Main WS closed or missing, reconnecting...');
          scheduleMainReconnect(1000);
        }
      }
    }, 4000);
  }

  function fetchTokenWithFallback(targetRoomId) {
    var safeRoomId = String(targetRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (safeRoomId.length !== 6) safeRoomId = '666888';

    var primaryUrl = apiBase + '/api/get_token?roomId=' + safeRoomId;

    return fetch(primaryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (res) {
        if (res.ok) return res.json();
        throw new Error('HTTP ' + res.status);
      })
      .then(function (data) {
        if (data && data.token) return data.token;
        throw new Error('Token missing in response');
      });
  }

  function initWebSocket() {
    if (isMainConnecting) {
      console.log('[OBS Overlay] initWebSocket skipped: already connecting...');
      return;
    }
    isMainConnecting = true;
    stopMainHeartbeat();

    if (mainReconnectTimer) {
      clearTimeout(mainReconnectTimer);
      mainReconnectTimer = null;
    }

    if (mainWs) {
      try {
        mainWs.onopen = null;
        mainWs.onmessage = null;
        mainWs.onclose = null;
        mainWs.onerror = null;
        mainWs.close();
      } catch (e) {}
      mainWs = null;
    }

    showStatus('⏳ 正在连接中控台 (房间 ' + roomId + ')...', '', false);

    fetchTokenWithFallback(roomId)
      .then(function (token) {
        var wsUrl = 'wss://api.mx.server.ndcoo.com/gaoguang-ws?roomId=' + roomId + '&token=' + encodeURIComponent(token);
        var ws = new WebSocket(wsUrl);
        mainWs = ws;

        ws.onopen = function () {
          if (mainWs !== ws) return;
          isMainConnecting = false;
          mainReconnectAttempt = 0;
          mainLastRecvAt = Date.now();
          console.log('[OBS Overlay] Scoreboard WebSocket Connected to room', roomId);
          showStatus('🟢 已成功连接中控台 (房间 ' + roomId + ')', 'connected', true);

          ws.send(JSON.stringify({
            type: 'BROADCAST_JOIN',
            roomId: roomId,
            sys_t: Date.now()
          }));

          startMainHeartbeat(ws);
        };

        ws.onmessage = function (event) {
          if (mainWs !== ws) return;
          mainLastRecvAt = Date.now();
          try {
            var payload = JSON.parse(event.data);
            updateMatchInfo(payload);
          } catch (err) {
            console.error('[OBS Overlay] Message Parse Error', err);
          }
        };

        ws.onclose = function () {
          if (mainWs !== ws) return;
          isMainConnecting = false;
          stopMainHeartbeat();
          mainWs = null;
          console.warn('[OBS Overlay] Main WebSocket Closed, auto reconnecting...');
          scheduleMainReconnect();
        };

        ws.onerror = function (err) {
          if (mainWs !== ws) return;
          isMainConnecting = false;
          stopMainHeartbeat();
          try { ws.close(); } catch (e) {}
          mainWs = null;
          console.error('[OBS Overlay] Main WebSocket Error', err);
          scheduleMainReconnect();
        };
      })
      .catch(function (err) {
        console.error('[OBS Overlay] All token fetch attempts failed:', err);
        isMainConnecting = false;
        scheduleMainReconnect(3000);
      });
  }

  // ──────────────────────────────────────────────
  // 3. 动态时间采集设备连接与切图渲染管理 (支持后台永久自动重连与切图看门狗)
  // ──────────────────────────────────────────────
  var timeWs = null;
  var currentTimeRoomId = '';
  var timeWsHeartbeatTimer = null;
  var timeFrameWatchdogTimer = null;
  var timeDeviceWatchdogTimer = null;
  var timeReconnectTimer = null;
  var timeLastRecvAt = Date.now();
  var isTimeConnecting = false;
  var timeImageObj = new Image();
  var lastTimeCropSeq = 0;

  function clearTimeCrop() {
    if (timeFrameWatchdogTimer) {
      clearTimeout(timeFrameWatchdogTimer);
      timeFrameWatchdogTimer = null;
    }
    if (domTimeCropBox) {
      domTimeCropBox.classList.add('crop-time-box--hidden');
    }
    if (timeCropCanvasCtx && domTimeCropCanvas) {
      try {
        timeCropCanvasCtx.clearRect(0, 0, domTimeCropCanvas.width, domTimeCropCanvas.height);
      } catch (eClear) {}
    }
  }

  function renderTimeCropFrame(payload) {
    if (!payload) return;
    var imgStr = payload.time_img || payload.img || payload.image || (payload.data && (payload.data.time_img || payload.data.img));
    if (!imgStr || payload.act === 'CLEAR') {
      clearTimeCrop();
      return;
    }

    var seq = typeof payload.seq === 'number' ? payload.seq : 0;
    if (lastTimeCropSeq && seq > 0 && seq < lastTimeCropSeq) {
      return;
    }
    if (seq > 0) {
      lastTimeCropSeq = seq;
    }

    timeLastRecvAt = Date.now();

    // 4.5 秒内无新帧自动隐藏黑晶容器
    if (timeFrameWatchdogTimer) clearTimeout(timeFrameWatchdogTimer);
    timeFrameWatchdogTimer = setTimeout(function () {
      clearTimeCrop();
    }, 4500);

    var src = String(imgStr);
    if (src.indexOf('data:image') !== 0) {
      src = 'data:image/png;base64,' + src;
    }

    timeImageObj.onload = function () {
      if (!domTimeCropCanvas || !timeCropCanvasCtx) return;

      // 1. 优先提取采集端发来的原始 ROI 几何宽高比
      var explicitAspect = 0;
      if (payload && typeof payload === 'object') {
        if (typeof payload.aspect === 'number' && payload.aspect > 0) {
          explicitAspect = payload.aspect;
        } else if (typeof payload.img_w === 'number' && typeof payload.img_h === 'number' && payload.img_h > 0) {
          explicitAspect = payload.img_w / payload.img_h;
        }
      }

      var naturalW = timeImageObj.naturalWidth || timeImageObj.width || 0;
      var naturalH = timeImageObj.naturalHeight || timeImageObj.height || 0;
      var aspect = explicitAspect;
      if (!aspect || aspect <= 0) {
        if (naturalW > 0 && naturalH > 0) {
          aspect = naturalW / naturalH;
        } else {
          aspect = 2.8;
        }
      }

      // 2. 先显示容器，以便获取真实的渲染高宽 (避免 display:none 导致 clientHeight=0)
      if (domTimeCropBox) {
        domTimeCropBox.classList.remove('crop-time-box--hidden');
      }

      // 3. 读取容器由 CSS clamp 确定的实际物理高度 (与主记分条精准齐平)
      var rectH = domTimeCropBox ? domTimeCropBox.getBoundingClientRect().height : 0;
      var containerH = (rectH > 20) ? rectH : 50;

      var padY = 6;  // 上下内边距各 3px (合计 6px)
      var padX = 12; // 左右内边距各 6px (合计 12px)
      var innerH = Math.max(20, Math.round(containerH - padY));

      // 4. 严格按照切图真实宽高比计算画布内容净宽度与外层容器总宽度 (绝对 1:1 零变形)
      var renderW = Math.round(innerH * aspect);
      var targetBoxWidth = renderW + padX;

      if (domTimeCropBox) {
        domTimeCropBox.style.width = targetBoxWidth + 'px';
      }

      // 5. 高清 DPR 像素倍增 (Retina / 4K / 1080P) + 像素级抗模糊 (与 live.wxml 完全一致)
      var dpr = window.devicePixelRatio || 2;
      var canvasPixelW = Math.round(renderW * dpr);
      var canvasPixelH = Math.round(innerH * dpr);

      if (domTimeCropCanvas.width !== canvasPixelW || domTimeCropCanvas.height !== canvasPixelH) {
        domTimeCropCanvas.width = canvasPixelW;
        domTimeCropCanvas.height = canvasPixelH;
      }

      timeCropCanvasCtx.setTransform(1, 0, 0, 1, 0, 0);
      timeCropCanvasCtx.scale(dpr, dpr);
      timeCropCanvasCtx.imageSmoothingEnabled = false;

      timeCropCanvasCtx.clearRect(0, 0, renderW, innerH);
      timeCropCanvasCtx.drawImage(timeImageObj, 0, 0, renderW, innerH);
    };
    timeImageObj.src = src;
  }

  function stopTimeHeartbeat() {
    if (timeWsHeartbeatTimer) {
      clearInterval(timeWsHeartbeatTimer);
      timeWsHeartbeatTimer = null;
    }
  }

  function startTimeHeartbeat(ws, targetRoomId) {
    stopTimeHeartbeat();
    timeWsHeartbeatTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'BROADCAST_HEARTBEAT',
            sys_t: Date.now(),
            roomId: targetRoomId,
            match_id: 'M_' + targetRoomId,
            ping: 1
          }));
        } catch (e) {}
      }
    }, 8000);
  }

  function scheduleTimeReconnect(targetRoomId, delayMs) {
    if (!targetRoomId || targetRoomId !== currentTimeRoomId) return;
    if (timeReconnectTimer) return;
    var wait = delayMs || 2500;
    console.log('[OBS Overlay] Scheduling time device reconnect in', wait, 'ms for room', targetRoomId);
    timeReconnectTimer = setTimeout(function () {
      timeReconnectTimer = null;
      if (currentTimeRoomId === targetRoomId) {
        connectTimeDevice(targetRoomId, true);
      }
    }, wait);
  }

  function startTimeDeviceWatchdog() {
    if (timeDeviceWatchdogTimer) clearInterval(timeDeviceWatchdogTimer);
    timeDeviceWatchdogTimer = setInterval(function () {
      if (!currentTimeRoomId) return;
      var now = Date.now();
      if (!timeWs || timeWs.readyState === WebSocket.CLOSED || timeWs.readyState === WebSocket.CLOSING) {
        if (!isTimeConnecting && !timeReconnectTimer) {
          console.warn('[OBS Overlay][TimeWatchdog] Time WS down, auto reconnecting...');
          scheduleTimeReconnect(currentTimeRoomId, 500);
        }
        return;
      }
      if (timeWs.readyState === WebSocket.OPEN) {
        if (now - timeLastRecvAt > 20000) {
          console.warn('[OBS Overlay][TimeWatchdog] Time WS silence (>20s), proactive reconnecting...');
          try {
            timeWs.onopen = null;
            timeWs.onmessage = null;
            timeWs.onclose = null;
            timeWs.onerror = null;
            timeWs.close();
          } catch (e) {}
          timeWs = null;
          scheduleTimeReconnect(currentTimeRoomId, 500);
        }
      }
    }, 4000);
  }

  function disconnectTimeDevice() {
    stopTimeHeartbeat();
    currentTimeRoomId = '';
    if (timeReconnectTimer) {
      clearTimeout(timeReconnectTimer);
      timeReconnectTimer = null;
    }
    if (timeWs) {
      try {
        timeWs.onopen = null;
        timeWs.onmessage = null;
        timeWs.onclose = null;
        timeWs.onerror = null;
        timeWs.close();
      } catch (e) {}
      timeWs = null;
    }
    clearTimeCrop();
    console.log('[OBS Overlay] Time Device Disconnected, container cleared and closed');
  }

  function connectTimeDevice(targetRoomId, isSilentRetry) {
    var safeTargetId = String(targetRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (!safeTargetId || safeTargetId.length !== 6) {
      console.warn('[OBS Overlay] Invalid target time room id:', targetRoomId);
      return;
    }

    if (timeWs && currentTimeRoomId === safeTargetId && timeWs.readyState === WebSocket.OPEN) {
      if (!isSilentRetry) {
        console.log('[OBS Overlay] Already connected to target time room:', safeTargetId);
      }
      return;
    }

    if (!isSilentRetry) {
      disconnectTimeDevice();
    }
    currentTimeRoomId = safeTargetId;
    isTimeConnecting = true;
    console.log('[OBS Overlay] Connecting to Time Device Room:', safeTargetId);

    function establishTimeWs(token) {
      if (currentTimeRoomId !== safeTargetId) {
        isTimeConnecting = false;
        return;
      }
      var wsUrl = 'wss://api.mx.server.ndcoo.com/gaoguang-ws?roomId=' + safeTargetId + '&token=' + encodeURIComponent(token);
      var ws = new WebSocket(wsUrl);
      timeWs = ws;

      ws.onopen = function () {
        if (timeWs !== ws) return;
        isTimeConnecting = false;
        timeLastRecvAt = Date.now();
        console.log('[OBS Overlay] Time Device Connected to room', safeTargetId);
        ws.send(JSON.stringify({
          type: 'BROADCAST_JOIN',
          roomId: safeTargetId,
          sys_t: Date.now()
        }));
        startTimeHeartbeat(ws, safeTargetId);
      };

      ws.onmessage = function (event) {
        if (timeWs !== ws) return;
        timeLastRecvAt = Date.now();
        try {
          var raw = JSON.parse(event.data);
          var frameData = null;
          if (raw.type === 'CROP_FRAME_SYNC' || raw.type === 'DATA_CROP_FRAME') {
            frameData = raw.payload || raw;
          } else if (raw.time_img || (raw.payload && raw.payload.time_img) || (raw.data && raw.data.time_img)) {
            frameData = (raw.payload && raw.payload.time_img) ? raw.payload : ((raw.data && raw.data.time_img) ? raw.data : raw);
          } else if (raw.type === 'DATA_BROADCAST' && raw.payload && (raw.payload.time_img || raw.payload.type === 'CROP_FRAME_SYNC')) {
            frameData = raw.payload;
          }

          if (frameData && (frameData.time_img || frameData.img)) {
            renderTimeCropFrame(frameData);
          } else if (raw.act === 'CLEAR' || (raw.payload && raw.payload.act === 'CLEAR') || raw.type === 'DEVICE_OFFLINE') {
            clearTimeCrop();
          }
        } catch (err) {
          console.error('[OBS Overlay] Time Message Parse Error', err);
        }
      };

      ws.onclose = function () {
        if (timeWs !== ws) return;
        isTimeConnecting = false;
        stopTimeHeartbeat();
        timeWs = null;
        console.warn('[OBS Overlay] Time Device WebSocket Closed, auto reconnecting for room', safeTargetId);
        if (currentTimeRoomId === safeTargetId) {
          scheduleTimeReconnect(safeTargetId, 2000);
        }
      };

      ws.onerror = function (err) {
        if (timeWs !== ws) return;
        isTimeConnecting = false;
        stopTimeHeartbeat();
        try { ws.close(); } catch (e) {}
        timeWs = null;
        if (currentTimeRoomId === safeTargetId) {
          scheduleTimeReconnect(safeTargetId, 2500);
        }
      };
    }

    fetch(apiBase + '/api/get_token?roomId=' + safeTargetId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.token) {
          establishTimeWs(data.token);
        } else {
          fetch(apiBase + '/api/get_token?roomId=' + safeTargetId)
            .then(function (r2) { return r2.json(); })
            .then(function (d2) {
              if (d2 && d2.token) establishTimeWs(d2.token);
              else {
                isTimeConnecting = false;
                scheduleTimeReconnect(safeTargetId, 3000);
              }
            })
            .catch(function () {
              isTimeConnecting = false;
              scheduleTimeReconnect(safeTargetId, 3000);
            });
        }
      })
      .catch(function (err) {
        console.error('[OBS Overlay] Fetch Time Token Error', err);
        fetch(apiBase + '/api/get_token?roomId=' + safeTargetId)
          .then(function (r2) { return r2.json(); })
          .then(function (d2) {
            if (d2 && d2.token) establishTimeWs(d2.token);
            else {
              isTimeConnecting = false;
              scheduleTimeReconnect(safeTargetId, 3000);
            }
          })
          .catch(function () {
            isTimeConnecting = false;
            scheduleTimeReconnect(safeTargetId, 3000);
          });
      });
  }

  // ──────────────────────────────────────────────
  // 5. 零配置 OBS 本地 WebSocket (ws://localhost:4455) & 高光播放控制
  // ──────────────────────────────────────────────
  var domReplayContainer = document.getElementById('replay-overlay-container');
  var domReplayVideo = document.getElementById('replay-video-player');
  var domReplayMask = document.getElementById('replay-mask');
  var domReplayBadgeMain = document.getElementById('replay-badge-main');
  var domReplayBadgeSub = document.getElementById('replay-badge-sub');
  var domReplayCornerBadge = document.getElementById('replay-corner-badge');
  var domReplayCornerText = document.getElementById('replay-corner-text');

  var highlightQueue = [];
  var currentReplayIndex = 0;
  var isReplayPlaying = false;
  var obsNativeWs = null;
  var obsWsPort = urlParams.get('obsWsPort') || '4455';
  var replayAnimTimer = null;
  var replayClipStartedAt = 0;

  function formatFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    var path = String(filePath).trim();

    // 彻底清除之前遗留的历史 proxy 字符串 (如 video?path= 或 http://127.0.0.1:8085/video?path=)
    if (path.indexOf('video?path=') !== -1) {
      path = path.substring(path.indexOf('video?path=') + 11);
    }
    path = decodeURIComponent(path).replace(/\\/g, '/');
    var cleanPath = path.replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '');

    // Windows 磁盘路径: C:/Users/... -> file:///C:/Users/...
    if (/^[a-zA-Z]:\//.test(cleanPath)) {
      return 'file:///' + encodeURI(cleanPath);
    }
    // macOS / Linux 磁盘路径: /Users/... -> file:///Users/...
    if (cleanPath.startsWith('/')) {
      return 'file://' + encodeURI(cleanPath);
    }
    return 'file:///' + encodeURI(cleanPath);
  }

  // 提取文件名中的时间戳数字串（如 Replay_2026-08-30_13-05-12.mp4 -> 20260830130512）
  function extractClipTimestamp(filePath) {
    if (!filePath || typeof filePath !== 'string') return 0;
    var fName = decodeURIComponent(filePath).split('/').pop().split('\\').pop();
    var digits = fName.replace(/\D/g, '');
    if (digits.length >= 14) {
      return parseInt(digits.slice(0, 14), 10) || 0;
    }
    return 0;
  }

  // 严格按录制时间倒序（从新到旧）获取切片队列（最新的一段永远排在 index 0）
  function getSortedHighlightQueue() {
    var unique = [];
    var seen = {};
    for (var i = 0; i < highlightQueue.length; i++) {
      var p = highlightQueue[i];
      if (p && !seen[p]) {
        seen[p] = true;
        unique.push(p);
      }
    }

    unique.sort(function (a, b) {
      var tA = extractClipTimestamp(a);
      var tB = extractClipTimestamp(b);
      if (tA !== tB) {
        return tB - tA; // 降序：时间大的（最新的）排前面
      }
      return b.localeCompare(a);
    });

    return unique;
  }

  // 恢复并清洗本地存储的高光切片路径历史（仅保留有效 mp4 录像切片）
  try {
    var storedQueue = localStorage.getItem('obs_highlight_queue');
    if (storedQueue) {
      var parsed = JSON.parse(storedQueue);
      if (Array.isArray(parsed)) {
        highlightQueue = parsed.map(formatFilePath).filter(function (p) {
          return p && p.toLowerCase().indexOf('.mp4') !== -1;
        });
        highlightQueue = getSortedHighlightQueue();
      }
    }
  } catch (e) {}

  function saveHighlightQueue() {
    try {
      localStorage.setItem('obs_highlight_queue', JSON.stringify(highlightQueue.slice(0, 50)));
    } catch (e) {}
  }

  function addHighlightFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    var cleanPath = formatFilePath(filePath);
    highlightQueue = highlightQueue.filter(function (item) { return item !== cleanPath; });
    highlightQueue.unshift(cleanPath);
    highlightQueue = getSortedHighlightQueue(); // 强制按时间戳严格倒序整理
    console.log('[OBS Overlay] Highlight clip recorded (newest first):', cleanPath);
    saveHighlightQueue();
    if (typeof dbgLog === 'function') {
      dbgLog('💾 捕获新高光切片: ' + cleanPath.split('/').pop(), '#4ade80');
    }
    if (typeof updateDebugUI === 'function') {
      updateDebugUI();
    }
  }

  var obsWsPassword = urlParams.get('obsWsPassword') || urlParams.get('obsPassword') || '';

  // SHA-256 辅助函数（用于 OBS WebSocket v5 密码校验）
  function handleObsAuth(authReq, password) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject('Crypto API unsupported');
    var encoder = new TextEncoder();
    var passSaltData = encoder.encode(password + authReq.salt);
    return window.crypto.subtle.digest('SHA-256', passSaltData).then(function (passSaltHash) {
      var secretBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(passSaltHash)));
      var authData = encoder.encode(secretBase64 + authReq.challenge);
      return window.crypto.subtle.digest('SHA-256', authData).then(function (authHash) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(authHash)));
      });
    });
  }

  var obsMediaSourceName = urlParams.get('obsMedia') || urlParams.get('mediaSource') || '高光回放';
  var currentObsSceneName = '';

  // 发送 OBS 原生媒体源控制指令 (播放 / 停止 / 显示 / 隐藏)
  function obsControlMediaSource(action, filePath) {
    if (!obsNativeWs || obsNativeWs.readyState !== WebSocket.OPEN) {
      console.warn('[OBS Overlay] OBS Native WebSocket is not ready, cannot control media source');
      return;
    }

    if (action === 'PLAY' && filePath) {
      var rawDiskPath = String(filePath).replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '');
      rawDiskPath = decodeURIComponent(rawDiskPath);
      console.log('[OBS Overlay] Setting OBS Media Source [' + obsMediaSourceName + '] to:', rawDiskPath);

      // 1. 设置媒体源的文件路径
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'SetInputSettings',
          requestId: 'req_set_media_file',
          requestData: {
            inputName: obsMediaSourceName,
            inputSettings: {
              local_file: rawDiskPath,
              looping: false,
              restart_on_activate: true,
              close_when_inactive: true
            }
          }
        }
      }));

      // 2. 获取当前场景并显示媒体源
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'GetCurrentProgramScene',
          requestId: 'req_scene_for_play'
        }
      }));

      // 3. 触发媒体播放
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'TriggerMediaInputAction',
          requestId: 'req_media_restart',
          requestData: {
            inputName: obsMediaSourceName,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
          }
        }
      }));
    } else if (action === 'STOP') {
      console.log('[OBS Overlay] Stopping OBS Media Source [' + obsMediaSourceName + ']');
      // 1. 立即停止媒体源播放
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'TriggerMediaInputAction',
          requestId: 'req_media_stop',
          requestData: {
            inputName: obsMediaSourceName,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
          }
        }
      }));

      // 2. 清空媒体源文件路径并关闭文件，彻底清除画面残留
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'SetInputSettings',
          requestId: 'req_clear_media_file',
          requestData: {
            inputName: obsMediaSourceName,
            inputSettings: {
              local_file: '',
              close_when_inactive: true
            }
          }
        }
      }));

      // 3. 隐藏媒体源图层
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'GetCurrentProgramScene',
          requestId: 'req_scene_for_stop'
        }
      }));
    }
  }

  // 自动化开箱即用：后台静默连接 OBS Studio 原生内置 WebSocket (ws://localhost:4455)
  function initObsNativeWs() {
    try {
      var wsUrl = 'ws://localhost:' + obsWsPort;
      console.log('[OBS Overlay] Connecting to OBS Native WebSocket:', wsUrl);
      obsNativeWs = new WebSocket(wsUrl);

      obsNativeWs.onopen = function () {
        console.log('[OBS Overlay] Connected to OBS Native WebSocket at', wsUrl);
      };

      obsNativeWs.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          // OBS WebSocket v5 Hello (op 0)
          if (msg.op === 0) {
            var authReq = msg.d && msg.d.authentication;
            if (authReq) {
              if (!obsWsPassword) {
                console.warn('[OBS Overlay] OBS WebSocket requires password authentication. Please add obsWsPassword to URL parameter if needed');
              }
              handleObsAuth(authReq, obsWsPassword).then(function (authSecret) {
                obsNativeWs.send(JSON.stringify({
                  op: 1,
                  d: {
                    rpcVersion: 1,
                    authentication: authSecret
                  }
                }));
              }).catch(function (err) {
                console.error('[OBS Overlay] OBS auth digest error:', err);
              });
            } else {
              obsNativeWs.send(JSON.stringify({
                op: 1,
                d: { rpcVersion: 1 }
              }));
            }
          } else if (msg.op === 2) {
            console.log('[OBS Overlay] OBS Native WebSocket Identified successfully!');
            alertBanner('🟢 已连通 OBS 原生 WebSocket (端口: ' + obsWsPort + ')');
          } else if (msg.op === 5 && msg.d) {
            var evtType = msg.d.eventType;
            // 捕获 OBS 录像切片保存事件
            if (evtType === 'ReplayBufferSaved') {
              var savedPath = msg.d.eventData && msg.d.eventData.savedReplayPath;
              if (savedPath) {
                addHighlightFile(savedPath);
                var fileName = decodeURIComponent(String(savedPath).split('/').pop().split('\\').pop());
                alertBanner('⚡ OBS 成功推送到新高光: ' + fileName);
              }
            }
            // 捕获 OBS 原生媒体源播放结束事件
            else if (evtType === 'MediaInputPlaybackEnded') {
              var inputName = msg.d.eventData && msg.d.eventData.inputName;
              var elapsed = Date.now() - (replayClipStartedAt || 0);
              if (isReplayPlaying && elapsed > 1500) {
                console.log('[OBS Overlay] OBS MediaInputPlaybackEnded event received after ' + elapsed + 'ms -> advanceOrStopReplay');
                advanceOrStopReplay();
              }
            }
          } else if (msg.op === 7 && msg.d) {
            // 处理场景查询与显示/隐藏控制响应
            var reqId = msg.d.requestId || '';
            if (reqId === 'req_scene_for_play' || reqId === 'req_scene_for_stop') {
              var scName = msg.d.responseData && (msg.d.responseData.currentProgramSceneName || msg.d.responseData.sceneName);
              if (scName) {
                currentObsSceneName = scName;
                var willEnable = (reqId === 'req_scene_for_play');
                obsNativeWs.send(JSON.stringify({
                  op: 6,
                  d: {
                    requestType: 'GetSceneItemId',
                    requestId: willEnable ? 'req_enable_item_id' : 'req_disable_item_id',
                    requestData: {
                      sceneName: scName,
                      sourceName: obsMediaSourceName
                    }
                  }
                }));
              }
            } else if (reqId === 'req_enable_item_id' || reqId === 'req_disable_item_id') {
              var sItemId = msg.d.responseData && msg.d.responseData.sceneItemId;
              if (sItemId && currentObsSceneName) {
                var enableState = (reqId === 'req_enable_item_id');
                obsNativeWs.send(JSON.stringify({
                  op: 6,
                  d: {
                    requestType: 'SetSceneItemEnabled',
                    requestId: 'req_set_item_enabled_' + Date.now(),
                    requestData: {
                      sceneName: currentObsSceneName,
                      sceneItemId: sItemId,
                      sceneItemEnabled: enableState
                    }
                  }
                }));
              }
            } else if (reqId === 'req_media_poll_status') {
              var resp = msg.d.responseData || {};
              var duration = resp.mediaDuration || 0;
              var cursor = resp.mediaCursor || 0;
              var state = String(resp.mediaState || '').toUpperCase();
              var elapsed = Date.now() - (replayClipStartedAt || 0);

              // 持续记录捕获到的最大视频时长 (毫秒)
              if (duration > 0 && duration > currentClipDuration) {
                currentClipDuration = duration;
              }

              // 播完多重高精度判定（播放超过 1.5 秒后生效）
              if (isReplayPlaying && elapsed > 1500) {
                var isEnded = false;

                // 1. OBS 明确返回了停止、闲置或结束状态 (当 OBS 勾选了“播放结束时不显示任何内容”时，状态会直接变为 STOPPED 或 NONE)
                if (state === 'OBS_MEDIA_STATE_ENDED' || state === 'OBS_MEDIA_STATE_STOPPED' || state === 'OBS_MEDIA_STATE_NONE') {
                  console.log('[OBS Overlay] Replay clip finished via state:', state);
                  isEnded = true;
                }
                // 2. 播放进度 cursor 接近已记录的时长
                else if (currentClipDuration > 0 && cursor >= currentClipDuration - 400) {
                  console.log('[OBS Overlay] Replay clip finished via cursor:', cursor, '/', currentClipDuration);
                  isEnded = true;
                }
                // 3. 实际播放经过时间超过了捕获到的视频时长
                else if (currentClipDuration > 0 && elapsed >= currentClipDuration + 300) {
                  console.log('[OBS Overlay] Replay clip finished via elapsed time:', elapsed, '>=', currentClipDuration);
                  isEnded = true;
                }
                // 4. 超时安全强制兜底 (单段高光最长 16 秒自动退场，防止由于任何原因卡死)
                else if (elapsed >= 16000) {
                  console.log('[OBS Overlay] Replay clip finished via max safety timeout (16s)');
                  isEnded = true;
                }

                if (isEnded) {
                  advanceOrStopReplay();
                }
              }
            }
          }
        } catch (e) {}
      };

      obsNativeWs.onerror = function (err) {
        console.warn('[OBS Overlay] OBS Native WebSocket connection error:', err);
      };

      obsNativeWs.onclose = function (e) {
        if (e && e.code === 4009) {
          console.error('[OBS Overlay] OBS WebSocket Auth Failed (code 4009). Please check obsWsPassword URL parameter');
          alertBanner('❌ OBS WebSocket 密码验证失败，请检查密码设置');
        }
        setTimeout(initObsNativeWs, 8000);
      };
    } catch (err) {
      setTimeout(initObsNativeWs, 8000);
    }
  }

  initObsNativeWs();

  // 远程下发 OBS 原生保存高光重放缓冲区指令 (SaveReplayBuffer)
  function triggerObsSaveReplayBuffer() {
    if (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) {
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'SaveReplayBuffer',
          requestId: 'req_save_replay_' + Date.now()
        }
      }));
      console.log('[OBS Overlay] Sent SaveReplayBuffer request to OBS Native WebSocket');
      alertBanner('💾 已下发 OBS 重放缓冲区保存指令...');
    } else {
      console.warn('[OBS Overlay] OBS Native WebSocket not connected');
      alertBanner('⚠️ 未连通 OBS WebSocket(4455)，无法远程下发保存高光');
    }
  }

  var replayPollTimer = null;
  var currentClipDuration = 0;
  var isPlayingSingleClipOnly = false;

  // 自动切下一个高光切片，或播完自动退场切回直播
  function advanceOrStopReplay() {
    if (replayPollTimer) {
      clearInterval(replayPollTimer);
      replayPollTimer = null;
    }
    console.log('[OBS Overlay] advanceOrStopReplay: current idx =', currentReplayIndex, 'queue length =', highlightQueue.length, 'singleOnly =', isPlayingSingleClipOnly);

    // 如果是单片播放模式，或者已经播完最后一段切片，立即自动触发红色 Wipe 转场退场
    if (isPlayingSingleClipOnly || currentReplayIndex + 1 >= highlightQueue.length) {
      stopHighlightReplay(true);
    } else {
      // 连续轮播模式：稍微缓冲 250ms 让 OBS 媒体源释放上一段，然后顺畅播放下一段切片
      setTimeout(function () {
        if (isReplayPlaying) {
          playReplayIndex(currentReplayIndex + 1);
        }
      }, 250);
    }
  }

  // 转场 Wipe 动效与视频顺序播放控制器
  function startHighlightReplay(opt) {
    opt = opt || {};
    isReplayPlaying = true;
    isPlayingSingleClipOnly = true;

    // 1. 强制按时间倒序重新整理当前全部有效切片
    var sortedQueue = getSortedHighlightQueue();
    highlightQueue = sortedQueue;
    saveHighlightQueue();

    if (sortedQueue.length === 0) {
      console.warn('[OBS Overlay] No highlight clips recorded in queue');
      alertBanner('⚠️ 暂未捕获到高光切片！请在 OBS 保存重放后再播放');
      if (typeof dbgLog === 'function') {
        dbgLog('⚠️ 播放失败: 队列中没有高光切片', '#f87171');
      }
      stopHighlightReplay(true);
      return;
    }

    // 2. 解析目标切片序号 (优先按 targetIndex: 1, 2, 3... 或 clipIndex: 0, 1, 2...)
    var targetIdx = 0; // 默认最新一段 (index 0)

    if (opt.targetIndex !== undefined && opt.targetIndex !== null) {
      var tIdx = parseInt(opt.targetIndex, 10);
      if (!isNaN(tIdx) && tIdx >= 1) {
        targetIdx = tIdx - 1; // 转换为 0-based 索引
      }
    } else if (opt.clipIndex !== undefined && opt.clipIndex !== null) {
      var cIdx = parseInt(opt.clipIndex, 10);
      if (!isNaN(cIdx) && cIdx >= 0) {
        targetIdx = cIdx;
      }
    } else if (opt.index !== undefined && opt.index !== null) {
      var iIdx = parseInt(opt.index, 10);
      if (!isNaN(iIdx) && iIdx >= 0) {
        targetIdx = iIdx;
      }
    }

    // 边界安全钳位
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= sortedQueue.length) targetIdx = sortedQueue.length - 1;

    currentReplayIndex = targetIdx;
    var targetFile = sortedQueue[currentReplayIndex];
    var targetName = decodeURIComponent(String(targetFile).split('/').pop().split('\\').pop());

    console.log('[OBS Overlay] Playing highlight clip [第 ' + (currentReplayIndex + 1) + ' 段 / 共 ' + sortedQueue.length + ' 段]:', targetFile);
    if (typeof dbgLog === 'function') {
      dbgLog('▶ 启动高光切片播放 [第 ' + (currentReplayIndex + 1) + ' 段 / 共 ' + sortedQueue.length + ' 段]: ' + targetName, '#38bdf8');
    }

    // 3. 强制重置并触发 Wipe 入场转场遮罩（蓝色 Stinger + "精彩回放 HIGHLIGHT REPLAY"）
    if (domReplayMask) {
      domReplayMask.className = 'replay-mask replay-mask--hidden';
      void domReplayMask.offsetWidth; // 强制 DOM 重绘，确保 CSS keyframes 每次百分百生效
      domReplayMask.className = 'replay-mask replay-mask--replay';
      if (domReplayBadgeMain) domReplayBadgeMain.textContent = '精彩回放';
      if (domReplayBadgeSub) domReplayBadgeSub.textContent = 'HIGHLIGHT REPLAY';
    }

    if (replayAnimTimer) clearTimeout(replayAnimTimer);

    if (highlightQueue.length === 0) {
      console.warn('[OBS Overlay] No highlight clips recorded in queue');
      alertBanner('⚠️ 暂未捕获到高光切片！请在 OBS 保存重放后再播放');
      replayAnimTimer = setTimeout(function () {
        stopHighlightReplay(true);
      }, 3200);
      return;
    }

    // 0.45s 遮罩划满全屏时，启动 OBS 原生媒体源播放并展示角标
    replayAnimTimer = setTimeout(function () {
      if (domReplayContainer) domReplayContainer.classList.remove('replay-hidden');
      playReplayIndex(currentReplayIndex);
    }, 450);
  }

  function playReplayIndex(idx) {
    if (!isReplayPlaying || highlightQueue.length === 0) return;
    if (idx >= highlightQueue.length) {
      stopHighlightReplay(true);
      return;
    }
    currentReplayIndex = idx;
    replayClipStartedAt = Date.now();
    currentClipDuration = 0;
    var targetSrc = highlightQueue[idx];
    var fileName = decodeURIComponent(String(targetSrc).split('/').pop().split('\\').pop());
    console.log('[OBS Overlay] Playing highlight clip via OBS Media Source [' + (idx + 1) + '/' + highlightQueue.length + ']:', targetSrc);

    if (domReplayCornerText) {
      domReplayCornerText.textContent = '精彩回放 · REPLAY';
    }

    if (domReplayContainer) {
      domReplayContainer.classList.remove('replay-hidden');
    }

    // 核心调用：通过 OBS WebSocket 驱动 OBS 原生媒体源硬解播放！
    obsControlMediaSource('PLAY', targetSrc);

    // 启动双保险轮询：每 300ms 查询一次 OBS 媒体状态 (进度、时长、结束状态)
    if (replayPollTimer) clearInterval(replayPollTimer);
    replayPollTimer = setInterval(function () {
      if (!isReplayPlaying || !obsNativeWs || obsNativeWs.readyState !== WebSocket.OPEN) {
        clearInterval(replayPollTimer);
        return;
      }
      obsNativeWs.send(JSON.stringify({
        op: 6,
        d: {
          requestType: 'GetMediaInputStatus',
          requestId: 'req_media_poll_status',
          requestData: {
            inputName: obsMediaSourceName
          }
        }
      }));
    }, 300);
  }

  function stopHighlightReplay(force) {
    if (!isReplayPlaying && !force) {
      if (domReplayContainer) domReplayContainer.classList.add('replay-hidden');
      return;
    }
    isReplayPlaying = false;
    if (replayPollTimer) {
      clearInterval(replayPollTimer);
      replayPollTimer = null;
    }

    if (typeof dbgLog === 'function') {
      dbgLog('⏹ 执行回放退场并切回现场直播 (红色 Wipe)', '#f87171');
    }

    // 无论如何，立刻强制隐藏角标容器
    if (domReplayContainer) domReplayContainer.classList.add('replay-hidden');

    // 立即通知 OBS 媒体源停止播放并清空画面（0ms 立即执行，杜绝声音画面残留）
    obsControlMediaSource('STOP');

    // 1. 强制重置并触发红色退场转场遮罩 ("实时直播 LIVE STREAM")
    if (domReplayMask) {
      domReplayMask.className = 'replay-mask replay-mask--hidden';
      void domReplayMask.offsetWidth; // 强制 DOM 重绘，确保 CSS keyframes 每次百分百生效
      domReplayMask.className = 'replay-mask replay-mask--live';
      if (domReplayBadgeMain) domReplayBadgeMain.textContent = '实时直播';
      if (domReplayBadgeSub) domReplayBadgeSub.textContent = 'LIVE STREAM';
    }

    if (replayAnimTimer) clearTimeout(replayAnimTimer);

    // 0.92s 退场全套动效完成后清理 Mask class
    setTimeout(function () {
      if (domReplayMask) domReplayMask.className = 'replay-mask replay-mask--hidden';
    }, 920);
  }

  // 房间号一键设置与修改 Modal 逻辑
  var domRoomEditBtn = document.getElementById('ws-room-edit-btn');
  var domCurrentRoomText = document.getElementById('ws-current-room-text');
  var domRoomModal = document.getElementById('room-setting-modal');
  var domRoomInput = document.getElementById('room-modal-input');
  var domRoomSubmitBtn = document.getElementById('room-modal-submit-btn');
  var domRoomCloseBtn = document.getElementById('room-modal-close');

  if (domCurrentRoomText) {
    domCurrentRoomText.textContent = roomId;
  }
  if (domRoomInput) {
    domRoomInput.value = roomId;
  }

  function openRoomModal() {
    if (domRoomModal) domRoomModal.classList.remove('room-modal--hidden');
    if (domRoomInput) domRoomInput.focus();
  }

  function closeRoomModal() {
    if (domRoomModal) domRoomModal.classList.add('room-modal--hidden');
  }

  function switchRoomId(newId) {
    var digits = String(newId || '').replace(/\D/g, '').slice(0, 6);
    if (digits.length !== 6) {
      alert('请输入 6 位纯数字房间号！');
      return;
    }
    roomId = digits;
    try { localStorage.setItem('obs_room_id', roomId); } catch (e) {}
    if (domCurrentRoomText) domCurrentRoomText.textContent = roomId;
    closeRoomModal();

    console.log('[OBS Overlay] Switched roomId to:', roomId);
    if (statusText) statusText.textContent = '🔑 正在切换至房间 ' + roomId + '...';
    // 重新连接主记分 WebSocket
    initWebSocket();
  }

  if (domRoomEditBtn) domRoomEditBtn.addEventListener('click', openRoomModal);
  if (domRoomCloseBtn) domRoomCloseBtn.addEventListener('click', closeRoomModal);
  if (domRoomSubmitBtn) {
    domRoomSubmitBtn.addEventListener('click', function () {
      if (domRoomInput) switchRoomId(domRoomInput.value);
    });
  }

  // ──────────────────────────────────────────────
  // 🛠️ 网页内置可视化实时调试面板逻辑 (按键盘 D 键或加 ?debug=1 开启)
  // ──────────────────────────────────────────────
  var domDebugPanel = document.getElementById('obs-debug-panel');
  var domDbgCloseBtn = document.getElementById('debug-close-btn');
  var domDbgRoomStatus = document.getElementById('dbg-room-status');
  var domDbgObsStatus = document.getElementById('dbg-obs-status');
  var domDbgMediaStatus = document.getElementById('dbg-media-status');
  var domDbgQueueCount = document.getElementById('dbg-queue-count');
  var domDbgLogsBox = document.getElementById('dbg-logs-box');

  var domDbgPlaySingle = document.getElementById('dbg-btn-play-single');
  var domDbgPlayAll = document.getElementById('dbg-btn-play-all');
  var domDbgStop = document.getElementById('dbg-btn-stop');
  var domDbgClearQueue = document.getElementById('dbg-btn-clear-queue');

  function dbgLog(msg, color) {
    if (!domDbgLogsBox) return;
    var now = new Date();
    var t = (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' +
            (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + ':' +
            (now.getSeconds() < 10 ? '0' : '') + now.getSeconds();
    var item = document.createElement('div');
    item.className = 'dbg-log-item';
    if (color) item.style.color = color;
    item.textContent = '[' + t + '] ' + msg;
    domDbgLogsBox.insertBefore(item, domDbgLogsBox.firstChild);
    if (domDbgLogsBox.children.length > 50) {
      domDbgLogsBox.removeChild(domDbgLogsBox.lastChild);
    }
  }

  function updateDebugUI() {
    if (domDbgRoomStatus) {
      domDbgRoomStatus.textContent = (mainWs && mainWs.readyState === WebSocket.OPEN) ? ('🟢 已连通 (房间 ' + roomId + ')') : '🔴 未连接';
      domDbgRoomStatus.style.color = (mainWs && mainWs.readyState === WebSocket.OPEN) ? '#4ade80' : '#f87171';
    }
    if (domDbgObsStatus) {
      domDbgObsStatus.textContent = (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) ? ('🟢 已连通 (端口 ' + obsWsPort + ')') : '🔴 未连接';
      domDbgObsStatus.style.color = (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) ? '#4ade80' : '#f87171';
    }
    if (domDbgQueueCount) {
      domDbgQueueCount.textContent = highlightQueue.length + ' 段有效切片';
    }

    var domDbgClipsList = document.getElementById('dbg-clips-list');
    var domDbgClipsTip = document.getElementById('dbg-clips-tip');
    if (domDbgClipsTip) {
      domDbgClipsTip.textContent = highlightQueue.length + ' 段';
    }
    if (domDbgClipsList) {
      if (highlightQueue.length === 0) {
        domDbgClipsList.innerHTML = '<div style="color: #64748b; font-size: 11px; text-align: center; padding: 6px;">暂无捕获切片 (请在 OBS 保存高光)</div>';
      } else {
        var html = '';
        for (var i = 0; i < highlightQueue.length; i++) {
          var p = highlightQueue[i];
          var fName = decodeURIComponent(String(p).split('/').pop().split('\\').pop());
          html += '<div class="dbg-clip-item">' +
                    '<span class="dbg-clip-name" title="' + fName + '">#' + (i + 1) + ' ' + fName + '</span>' +
                    '<button class="dbg-clip-btn" onclick="window.__dbgPlayClip(' + i + ')">▶ 播此段</button>' +
                  '</div>';
        }
        domDbgClipsList.innerHTML = html;
      }
    }
  }

  window.__dbgPlayClip = function (idx) {
    if (idx < 0 || idx >= highlightQueue.length) return;
    var target = highlightQueue[idx];
    var fName = decodeURIComponent(String(target).split('/').pop().split('\\').pop());
    dbgLog('调试控制台触发: 精准点播切片 #' + (idx + 1) + ' (' + fName + ')', '#38bdf8');
    startHighlightReplay({ clipIndex: idx, fileName: fName, filePath: target });
  };

  setInterval(updateDebugUI, 1000);

  var isDebugVisible = (urlParams.get('debug') === '1' || urlParams.get('dbg') === '1');
  if (domDebugPanel && isDebugVisible) {
    domDebugPanel.style.display = 'flex';
  }

  // 快捷键 D 或 ~ 开关调试面板
  window.addEventListener('keydown', function (e) {
    if (e.key === 'd' || e.key === 'D' || e.key === '`') {
      if (domDebugPanel) {
        var isShow = (domDebugPanel.style.display !== 'none');
        domDebugPanel.style.display = isShow ? 'none' : 'flex';
        dbgLog('调试面板切换: ' + (isShow ? '隐藏' : '显示'), '#38bdf8');
      }
    }
  });

  if (domDbgCloseBtn) {
    domDbgCloseBtn.addEventListener('click', function () {
      if (domDebugPanel) domDebugPanel.style.display = 'none';
    });
  }

  if (domDbgStop) {
    domDbgStop.addEventListener('click', function () {
      dbgLog('调试面板触发: 强制中断退场', '#f87171');
      stopHighlightReplay(true);
    });
  }

  if (domDbgClearQueue) {
    domDbgClearQueue.addEventListener('click', function () {
      highlightQueue = [];
      try { localStorage.removeItem('obs_highlight_queue'); } catch (e) {}
      dbgLog('已清空所有高光切片历史', '#fbbf24');
      updateDebugUI();
      alertBanner('🗑️ 高光队列已清空');
    });
  }

  // 初始默认高对比度应用
  applyTeamContrastStyle(domHomeName, domHomeScore, currentHomeColor);
  applyTeamContrastStyle(domAwayName, domAwayScore, currentAwayColor);

  // 初始化主记分 WebSocket 与看门狗
  initWebSocket();
  startMainWatchdog();
  startTimeDeviceWatchdog();

  // 支持 URL 参数直连时间房间 (?timeRoom=xxxxxx)
  var initialTimeRoomParam = urlParams.get('timeRoom') || urlParams.get('timeRoomId') || urlParams.get('time_room');
  if (initialTimeRoomParam) {
    connectTimeDevice(initialTimeRoomParam);
  }
})();

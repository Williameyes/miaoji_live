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
          timeRoomId: obj.tr || ''
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
          timeRoomId: jsonObj.timeRoomId || jsonObj.tr || ''
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

    // 6. 赛场时间采集设备联动控制 (由中控台下发指令控制连接/断开)
    var actType = d.act || '';
    var targetTimeRoom = (d.timeRoomId || d.time_room_id || (d.time_device && d.time_device.roomId) || (meta && meta.timeRoomId) || (meta && meta.tr) || (decoded && decoded.timeRoomId));
    var isTimeSyncOff = (actType === 'DISCONNECT_TIME_ROOM' || d.timeSyncEnabled === 0 || (d.time_device && d.time_device.enabled === false));
    var isTimeSyncOn = (actType === 'CONNECT_TIME_ROOM' || d.timeSyncEnabled === 1 || d.timeSyncEnabled === true || (d.time_device && d.time_device.enabled === true) || (targetTimeRoom && !isTimeSyncOff));

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
      initWebSocket();
    }, wait);
  }

  function startMainWatchdog() {
    if (mainWatchdogTimer) clearInterval(mainWatchdogTimer);
    mainWatchdogTimer = setInterval(function () {
      var now = Date.now();
      if (!mainWs || mainWs.readyState === WebSocket.CLOSED || mainWs.readyState === WebSocket.CLOSING) {
        if (!isMainConnecting && !mainReconnectTimer) {
          console.warn('[OBS Overlay][Watchdog] Main WS closed or missing, reconnecting...');
          scheduleMainReconnect(500);
        }
        return;
      }
      if (mainWs.readyState === WebSocket.OPEN) {
        // 超过 24s 没有任何服务器信令/Pong，判定为静默断网/僵尸连接，主动踢掉重连
        if (now - mainLastRecvAt > 24000) {
          console.warn('[OBS Overlay][Watchdog] Main WS zombie silence detected (>24s), forcing reconnect!');
          try {
            mainWs.onopen = null;
            mainWs.onmessage = null;
            mainWs.onclose = null;
            mainWs.onerror = null;
            mainWs.close();
          } catch (e) {}
          mainWs = null;
          scheduleMainReconnect(500);
        }
      }
    }, 4000);
  }

  function initWebSocket() {
    if (isMainConnecting) return;
    isMainConnecting = true;
    stopMainHeartbeat();

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

    function onTokenSuccess(token) {
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
    }

    fetch(apiBase + '/api/get_token?roomId=' + roomId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.token) {
          onTokenSuccess(data.token);
        } else {
          fetch(apiBase + '/api/get_token?roomId=' + roomId)
            .then(function (r2) { return r2.json(); })
            .then(function (d2) {
              if (d2 && d2.token) onTokenSuccess(d2.token);
              else {
                isMainConnecting = false;
                scheduleMainReconnect(3000);
              }
            })
            .catch(function () {
              isMainConnecting = false;
              scheduleMainReconnect(3000);
            });
        }
      })
      .catch(function (err) {
        console.error('[OBS Overlay] Token Fetch Fail', err);
        fetch(apiBase + '/api/get_token?roomId=' + roomId)
          .then(function (r2) { return r2.json(); })
          .then(function (d2) {
            if (d2 && d2.token) onTokenSuccess(d2.token);
            else {
              isMainConnecting = false;
              scheduleMainReconnect(3000);
            }
          })
          .catch(function () {
            isMainConnecting = false;
            scheduleMainReconnect(3000);
          });
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
      var nw = timeImageObj.naturalWidth || timeImageObj.width || 120;
      var nh = timeImageObj.naturalHeight || timeImageObj.height || 40;
      var aspect = payload.aspect || (nw / nh);

      if (domTimeCropCanvas.width !== nw || domTimeCropCanvas.height !== nh) {
        domTimeCropCanvas.width = nw;
        domTimeCropCanvas.height = nh;
      }
      var targetBoxWidth = Math.max(74, Math.round(52 * aspect));
      if (domTimeCropBox) {
        domTimeCropBox.style.width = targetBoxWidth + 'px';
        domTimeCropBox.classList.remove('crop-time-box--hidden');
      }

      timeCropCanvasCtx.clearRect(0, 0, nw, nh);
      timeCropCanvasCtx.drawImage(timeImageObj, 0, 0, nw, nh);
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

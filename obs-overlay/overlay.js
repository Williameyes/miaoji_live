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

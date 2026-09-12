(function () {
  'use strict';

  /**
   * 解码 URL 片段；OBS CEF 偶发非法 % 序列时不抛死整页。
   * @param {string} s
   * @returns {string}
   */
  function decodeComp(s) {
    try {
      return decodeURIComponent(String(s || '').replace(/\+/g, ' '));
    } catch (eDecode) {
      return String(s || '');
    }
  }

  /**
   * 手动解析 query + hash（不依赖 URLSearchParams / location.search）。
   * OBS 浏览器源常见：location.search 为空，但 href/hash 仍带 roomId。
   * @param {string} href
   * @returns {Object<string, string>}
   */
  function parseHrefParams(href) {
    var map = {};
    var s = String(href || '');
    try { s = decodeURIComponent(s); } catch (eHref) {}
    var hashPos = s.indexOf('#');
    var searchPos = s.indexOf('?');
    var query = '';
    var hash = '';
    if (searchPos >= 0) {
      query = (hashPos > searchPos) ? s.substring(searchPos + 1, hashPos) : s.substring(searchPos + 1);
    }
    if (hashPos >= 0) {
      hash = s.substring(hashPos + 1);
      if (hash.charAt(0) === '/') hash = hash.substring(1);
      if (hash.charAt(0) === '?') hash = hash.substring(1);
    }
    function absorb(chunk) {
      if (!chunk) return;
      var parts = chunk.split('&');
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        var eq = p.indexOf('=');
        var k = decodeComp(eq >= 0 ? p.substring(0, eq) : p);
        var v = decodeComp(eq >= 0 ? p.substring(eq + 1) : '');
        if (k) map[k] = v;
      }
    }
    absorb(query);
    absorb(hash);
    return map;
  }

  /**
   * 收集 OBS/CEF 可能提供的全部地址字符串。
   * @returns {string[]}
   */
  function collectHrefCandidates() {
    var list = [];
    function push(v) {
      var s = String(v || '');
      if (s && list.indexOf(s) === -1) list.push(s);
    }
    try { push(window.location.href); } catch (e1) {}
    try { push(window.location.search); } catch (e2) {}
    try { push(window.location.hash); } catch (e3) {}
    try { push(document.URL); } catch (e4) {}
    try { push(document.location && document.location.href); } catch (e5) {}
    return list;
  }

  var paramMap = {};
  var hrefCandidates = collectHrefCandidates();
  var hi;
  for (hi = 0; hi < hrefCandidates.length; hi++) {
    var parsed = parseHrefParams(hrefCandidates[hi]);
    var pk;
    for (pk in parsed) {
      if (Object.prototype.hasOwnProperty.call(parsed, pk) && parsed[pk] && !paramMap[pk]) {
        paramMap[pk] = parsed[pk];
      }
    }
  }

  var urlParams = {
    /**
     * @param {string} key
     * @returns {string|null}
     */
    get: function (key) {
      if (!key) return null;
      if (paramMap[key] != null && paramMap[key] !== '') return paramMap[key];
      var lower = String(key).toLowerCase();
      var k;
      for (k in paramMap) {
        if (Object.prototype.hasOwnProperty.call(paramMap, k) && k.toLowerCase() === lower && paramMap[k]) {
          return paramMap[k];
        }
      }
      return null;
    }
  };

  var isObsBrowser = typeof window.obsstudio !== 'undefined';

  // ──────────────────────────────────────────────
  // 🛠️ 全局排查诊断日志管理器 (内存队列 + 控制台拦截 + 现场还原)
  // ──────────────────────────────────────────────
  var debugLogHistory = [];
  var MAX_DEBUG_LOGS = 500;
  var domDbgLogsBox = null;

  // 尝试恢复上一次运行的历史日志（保留前次崩溃/退场现场）
  try {
    var cachedLogs = localStorage.getItem('obs_debug_log_cache');
    if (cachedLogs) {
      var parsedLogs = JSON.parse(cachedLogs);
      if (Array.isArray(parsedLogs)) {
        debugLogHistory = parsedLogs.slice(0, 50);
      }
    }
  } catch (eCache) {}

  function dbgLog(msg, color, level) {
    level = level || 'INFO';
    var now = new Date();
    var t = (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' +
            (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + ':' +
            (now.getSeconds() < 10 ? '0' : '') + now.getSeconds() + '.' +
            ('00' + now.getMilliseconds()).slice(-3);
    var fullTimeStr = now.getFullYear() + '-' +
            ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
            ('0' + now.getDate()).slice(-2) + ' ' + t;

    var logEntry = {
      timestamp: Date.now(),
      timeStr: t,
      fullTime: fullTimeStr,
      level: level,
      msg: String(msg || ''),
      color: color || '#e2e8f0'
    };

    debugLogHistory.unshift(logEntry);
    if (debugLogHistory.length > MAX_DEBUG_LOGS) {
      debugLogHistory.pop();
    }

    if (!domDbgLogsBox && typeof document !== 'undefined') {
      domDbgLogsBox = document.getElementById('dbg-logs-box');
    }
    if (domDbgLogsBox) {
      var item = document.createElement('div');
      item.className = 'dbg-log-item';
      if (color) item.style.color = color;
      item.textContent = '[' + t + '] ' + msg;
      domDbgLogsBox.insertBefore(item, domDbgLogsBox.firstChild);
      if (domDbgLogsBox.children.length > 200) {
        domDbgLogsBox.removeChild(domDbgLogsBox.lastChild);
      }
    }

    try {
      if (debugLogHistory.length % 5 === 0 || level === 'ERROR' || level === 'WARN') {
        localStorage.setItem('obs_debug_log_cache', JSON.stringify(debugLogHistory.slice(0, 60)));
      }
    } catch (eSaveLog) {}
  }

  // 自动包装与捕获系统及控制台日志流
  (function () {
    var rawLog = console.log;
    var rawWarn = console.warn;
    var rawError = console.error;

    console.log = function () {
      rawLog.apply(console, arguments);
      try {
        var text = Array.prototype.slice.call(arguments).map(function (a) {
          return (typeof a === 'object') ? JSON.stringify(a) : String(a);
        }).join(' ');
        if (text.indexOf('[OBS Overlay]') !== -1) {
          dbgLog(text.replace('[OBS Overlay] ', ''), '#38bdf8', 'INFO');
        }
      } catch (eLog) {}
    };

    console.warn = function () {
      rawWarn.apply(console, arguments);
      try {
        var text = Array.prototype.slice.call(arguments).map(function (a) {
          return (typeof a === 'object') ? JSON.stringify(a) : String(a);
        }).join(' ');
        dbgLog('⚠️ ' + text.replace('[OBS Overlay] ', ''), '#fbbf24', 'WARN');
      } catch (eWarn) {}
    };

    console.error = function () {
      rawError.apply(console, arguments);
      try {
        var text = Array.prototype.slice.call(arguments).map(function (a) {
          return (typeof a === 'object') ? JSON.stringify(a) : String(a);
        }).join(' ');
        dbgLog('❌ ' + text.replace('[OBS Overlay] ', ''), '#f87171', 'ERROR');
      } catch (eErr) {}
    };
  })();

  // 智能提取房间号：query / hash / 完整 href，兼容 OBS 丢失 search
  var rawRoomId = urlParams.get('roomId') || urlParams.get('roomid') || urlParams.get('roomld') || urlParams.get('room1d') || urlParams.get('room_id') || urlParams.get('room') || urlParams.get('matchCode') || urlParams.get('matchId') || urlParams.get('id') || '';
  if (!rawRoomId) {
    var hrefBlob = hrefCandidates.join('\n');
    var urlMatch = hrefBlob.match(/(?:roomid|roomId|roomld|room1d|room_id|room|matchcode|matchid)[=:]+(\d{6})/i);
    if (urlMatch && urlMatch[1]) {
      rawRoomId = urlMatch[1];
    }
  }
  if (!rawRoomId) {
    var anySixDigits = hrefCandidates.join('\n').match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/);
    if (anySixDigits && anySixDigits[1]) {
      rawRoomId = anySixDigits[1];
      console.log('[OBS Overlay] 智能从 URL 中识别到 6 位房间号:', rawRoomId);
    }
  }
  console.log('[OBS Overlay] boot', {
    isObsBrowser: isObsBrowser,
    href: (function () { try { return window.location.href; } catch (eBoot) { return ''; } })(),
    search: (function () { try { return window.location.search; } catch (eS) { return ''; } })(),
    hash: (function () { try { return window.location.hash; } catch (eH) { return ''; } })(),
    rawRoomId: rawRoomId
  });
  /**
   * 规范化 6 位纯数字房间号
   * @param {string} raw
   * @returns {string}
   */
  function normalizeRoomId(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (digits.length >= 6) return digits.slice(0, 6);
    return '';
  }

  // 1. 优先从 URL (query / hash / href) 中读取专属房间号
  rawRoomId = normalizeRoomId(rawRoomId);
  var isCustomUrlRoom = !!rawRoomId;

  // 2. 其次读取本地缓存保存的房间号
  if (!rawRoomId) {
    try { rawRoomId = normalizeRoomId(localStorage.getItem('obs_room_id')); } catch (e) {}
  }
  // 3. 再次读取 config.js 外部配置 (若手动指定)
  if (!rawRoomId && window.MIAOXIE_ROOM_ID) {
    rawRoomId = normalizeRoomId(window.MIAOXIE_ROOM_ID);
  }

  // 杜绝盲连公共房间：若无专属参数且无本地缓存，保持为空并弹出连接向导，支持 OBS 右键【交互】输入
  var roomId = rawRoomId || '';
  if (roomId) {
    try { localStorage.setItem('obs_room_id', roomId); } catch (e) {}
  }

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

  // 5. 防误封版权与现场实拍声明悬浮角标 (按住拖拽移动位置、拖拽右下角手柄改变大小、双击关闭隐藏)
  var domCopyrightBadge = document.getElementById('copyright-floating-badge');
  var domCopyrightResizeHandle = document.getElementById('copyright-resize-handle');

  if (domCopyrightBadge) {
    (function enableCopyrightBadgeDragAndResize() {
      var badgeScale = 1.0;
      var isMoveDragging = false;
      var isResizeDragging = false;
      var startX = 0, startY = 0;
      var initLeft = 0, initTop = 0;
      var startScale = 1.0;

      // 还原本地保存的位置、大小与关闭状态
      try {
        var savedData = localStorage.getItem('obs_copyright_badge_state');
        if (savedData) {
          var state = JSON.parse(savedData);
          if (state.hidden) {
            domCopyrightBadge.style.display = 'none';
          }
          if (state.left !== undefined) domCopyrightBadge.style.left = isNaN(state.left) ? state.left : state.left + 'px';
          if (state.top !== undefined) {
            domCopyrightBadge.style.top = isNaN(state.top) ? state.top : state.top + 'px';
            domCopyrightBadge.style.bottom = 'auto';
            domCopyrightBadge.style.right = 'auto';
          }
          if (state.scale) badgeScale = parseFloat(state.scale) || 1.0;
        }
      } catch (e) {}

      function applyBadgeTransform() {
        domCopyrightBadge.style.transform = 'scale(' + badgeScale + ')';
        domCopyrightBadge.style.transformOrigin = 'center center';
      }

      applyBadgeTransform();

      function saveBadgeState(hidden) {
        try {
          localStorage.setItem('obs_copyright_badge_state', JSON.stringify({
            hidden: hidden !== undefined ? hidden : (domCopyrightBadge.style.display === 'none'),
            left: domCopyrightBadge.style.left,
            top: domCopyrightBadge.style.top,
            scale: badgeScale
          }));
        } catch (e) {}
      }

      // 双击组件全域隐藏关闭
      domCopyrightBadge.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        e.preventDefault();
        domCopyrightBadge.style.display = 'none';
        saveBadgeState(true);
      });

      // 拖拽右下角 L 型拉手改变大小
      if (domCopyrightResizeHandle) {
        domCopyrightResizeHandle.addEventListener('mousedown', function (e) {
          isResizeDragging = true;
          startX = e.clientX;
          startY = e.clientY;
          startScale = badgeScale;
          e.stopPropagation();
          e.preventDefault();
        });
      }

      // 按住主体移动位置
      domCopyrightBadge.addEventListener('mousedown', function (e) {
        if (e.target === domCopyrightResizeHandle) return;
        isMoveDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        var rect = domCopyrightBadge.getBoundingClientRect();
        initLeft = rect.left;
        initTop = rect.top;
        domCopyrightBadge.style.left = initLeft + 'px';
        domCopyrightBadge.style.top = initTop + 'px';
        domCopyrightBadge.style.bottom = 'auto';
        domCopyrightBadge.style.right = 'auto';
        applyBadgeTransform();
        e.preventDefault();
      });

      // 滚轮辅助缩放
      domCopyrightBadge.addEventListener('wheel', function (e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 0.05 : -0.05;
        badgeScale = Math.max(0.5, Math.min(3.5, badgeScale + delta));
        applyBadgeTransform();
        saveBadgeState();
      });

      window.addEventListener('mousemove', function (e) {
        if (isResizeDragging) {
          var dx = e.clientX - startX;
          var dy = e.clientY - startY;
          var deltaScale = (dx + dy) / 200;
          badgeScale = Math.max(0.5, Math.min(3.5, startScale + deltaScale));
          applyBadgeTransform();
        } else if (isMoveDragging) {
          var dx = e.clientX - startX;
          var dy = e.clientY - startY;
          var newLeft = Math.max(0, initLeft + dx);
          var newTop = Math.max(0, initTop + dy);
          domCopyrightBadge.style.left = newLeft + 'px';
          domCopyrightBadge.style.top = newTop + 'px';
          applyBadgeTransform();
        }
      });

      window.addEventListener('mouseup', function () {
        if (isMoveDragging || isResizeDragging) {
          isMoveDragging = false;
          isResizeDragging = false;
          saveBadgeState();
        }
      });
    })();
  }

  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // 版权署名动态替换 & 弹球碰撞飘动欢迎文案控制器
  // ─────────────────────────────────────────────
  var domCopyrightName = document.getElementById('copyright-name');
  var domWelcomeOverlay = document.getElementById('welcome-bounce-overlay') || document.getElementById('marquee-overlay');
  var domWelcomePill = document.getElementById('welcome-bounce-pill');
  var domWelcomeText = document.getElementById('welcome-bounce-text');

  var _currentBroadcasterName = '';
  var _cachedBroadcaster = '';
  try {
    _cachedBroadcaster = urlParams.get('broadcaster') || urlParams.get('broadcasterNickname') || urlParams.get('nick') || localStorage.getItem('obs_broadcaster_name') || '';
  } catch (e) {}

  /**
  /**
   * 构造标准欢迎文案并高亮主播名
   * 规范格式：欢迎来到 *** 的直播间，点个免费的关注一起看球！
   */
  function buildWelcomeMarqueeHtml(customText) {
    var broadcaster = (_currentBroadcasterName || _cachedBroadcaster || '').trim();
    if (broadcaster === '微信用户' || broadcaster === 'WeChat User') {
      broadcaster = '';
    }

    var baseText = (typeof customText === 'string' && customText.trim()) ? customText.trim() : '';

    // 如果未传文本，或者文本是旧格式/未带当前主播名，则按规范自动生成
    if (!baseText || baseText.indexOf('希望大家关注') >= 0 || (broadcaster && baseText.indexOf(broadcaster) === -1)) {
      if (broadcaster) {
        baseText = '欢迎来到 ' + broadcaster + ' 的直播间，点个免费的关注一起看球！';
      } else {
        baseText = '欢迎来到直播间，点个免费的关注一起看球！';
      }
    }

    if (broadcaster && baseText.indexOf(broadcaster) >= 0) {
      var escapedName = broadcaster.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return baseText.replace(new RegExp(escapedName, 'g'), '<span class="welcome-highlight-name">' + broadcaster + '</span>');
    }
    return baseText;
  }

  /**
   * 极低资源弹球碰撞引擎 (DVD screensaver 经典反弹算法)
   * 采用 requestAnimationFrame + translate3d 纯 GPU 合成，CPU 占用 < 0.05%
   */
  var BounceMarquee = {
    rafId: null,
    isRunning: false,
    x: 100,
    y: 150,
    vx: 1.4,
    vy: 1.2,
    hitTimer: null,

    start: function () {
      if (!domWelcomeOverlay || !domWelcomePill) return;
      domWelcomeOverlay.classList.remove('welcome-bounce--hidden');
      if (domWelcomeOverlay.classList.contains('marquee-overlay--hidden')) {
        domWelcomeOverlay.classList.remove('marquee-overlay--hidden');
      }

      if (this.isRunning) return;
      this.isRunning = true;

      // 首次启动时，随机一个初始位置和初始运动方向
      var winW = window.innerWidth || 1920;
      var winH = window.innerHeight || 1080;
      var pillW = domWelcomePill.offsetWidth || 450;
      var pillH = domWelcomePill.offsetHeight || 52;

      var maxX = Math.max(20, winW - pillW - 40);
      var maxY = Math.max(20, winH - pillH - 40);

      this.x = Math.floor(Math.random() * (maxX - 40)) + 40;
      this.y = Math.floor(Math.random() * (maxY - 40)) + 40;

      // 速度模长在 1.3 ~ 1.7 像素/帧，随机角度
      var speed = 1.35 + Math.random() * 0.35;
      var angle = (Math.PI / 4) + (Math.random() * (Math.PI / 6) - Math.PI / 12); // ~35° - 55°
      this.vx = Math.cos(angle) * speed * (Math.random() > 0.5 ? 1 : -1);
      this.vy = Math.sin(angle) * speed * (Math.random() > 0.5 ? 1 : -1);

      var self = this;
      function tick() {
        if (!self.isRunning) return;
        self.update();
        self.rafId = requestAnimationFrame(tick);
      }
      this.rafId = requestAnimationFrame(tick);
    },

    update: function () {
      if (!domWelcomePill) return;
      var winW = window.innerWidth || 1920;
      var winH = window.innerHeight || 1080;
      var pillW = domWelcomePill.offsetWidth || 450;
      var pillH = domWelcomePill.offsetHeight || 52;

      this.x += this.vx;
      this.y += this.vy;

      var hit = false;
      var minX = 16;
      var maxX = winW - pillW - 16;
      var minY = 16;
      var maxY = winH - pillH - 16;

      if (this.x <= minX) {
        this.x = minX;
        this.vx = Math.abs(this.vx);
        hit = true;
      } else if (this.x >= maxX) {
        this.x = maxX;
        this.vx = -Math.abs(this.vx);
        hit = true;
      }

      if (this.y <= minY) {
        this.y = minY;
        this.vy = Math.abs(this.vy);
        hit = true;
      } else if (this.y >= maxY) {
        this.y = maxY;
        this.vy = -Math.abs(this.vy);
        hit = true;
      }

      if (hit) {
        this.onHit();
      }

      domWelcomePill.style.transform = 'translate3d(' + this.x.toFixed(1) + 'px, ' + this.y.toFixed(1) + 'px, 0)';
    },

    onHit: function () {
      if (!domWelcomePill) return;
      domWelcomePill.classList.add('bounce-hit');
      clearTimeout(this.hitTimer);
      this.hitTimer = setTimeout(function () {
        if (domWelcomePill) domWelcomePill.classList.remove('bounce-hit');
      }, 180);
    },

    stop: function () {
      this.isRunning = false;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (domWelcomeOverlay) {
        domWelcomeOverlay.classList.add('welcome-bounce--hidden');
      }
    }
  };

  /**
   * 更新版权署名：有 broadcaster 时显示金色高亮，否则回退"本人"
   */
  function updateBroadcasterName(name) {
    if (!domCopyrightName) return;
    var safeNick = (typeof name === 'string') ? name.trim() : '';
    var isDefault = !safeNick || safeNick === '微信用户' || safeNick === 'WeChat User';
    if (isDefault) {
      domCopyrightName.textContent = '本人';
      domCopyrightName.className = 'copyright-name';
      _currentBroadcasterName = '';
      try { localStorage.removeItem('obs_broadcaster_name'); } catch (e) {}
    } else {
      domCopyrightName.textContent = safeNick;
      domCopyrightName.className = 'copyright-name copyright-name--branded';
      try { localStorage.setItem('obs_broadcaster_name', safeNick); } catch (e) {}
    }
    if (domWelcomeText && typeof BounceMarquee !== 'undefined' && BounceMarquee && BounceMarquee.isRunning) {
      domWelcomeText.innerHTML = buildWelcomeMarqueeHtml();
    }
  }

  // 初始化时直接根据缓存或 URL query 预载入播主署名
  if (_cachedBroadcaster) {
    updateBroadcasterName(_cachedBroadcaster);
  }

  /**
   * 显示飘动欢迎/防盗播文案 (单条弹球碰撞)
   */
  function showMarquee(text) {
    if (domWelcomeText) {
      domWelcomeText.innerHTML = buildWelcomeMarqueeHtml(text);
    }
    BounceMarquee.start();
  }

  /**
   * 隐藏飘动文案并彻底停止计算
   */
  function hideMarquee() {
    BounceMarquee.stop();
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

  function alertBanner(text, state) {
    console.log('[OBS Overlay Notice]:', text);
    showStatus(text, state || '', true);
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
          title: obj.t || obj.title || obj.m || '',
          teamA: obj.a || obj.teamA || '',
          teamB: obj.b || obj.teamB || '',
          colorA: obj.ca ? '#' + obj.ca.replace('#', '') : (obj.colorA || ''),
          colorB: obj.cb ? '#' + obj.cb.replace('#', '') : (obj.colorB || ''),
          matchId: obj.id || obj.matchId || '',
          timeRoomId: obj.tr || '',
          targetIndex: obj.ci || 0,
          clipIndex: obj.ci ? (obj.ci - 1) : 0,
          act: obj.act || '',
          broadcaster: obj.bc || obj.broadcaster || obj.nick || '',
          marqueeText: obj.mt || obj.text || obj.welcomeText || obj.marqueeText || ''
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
              matchId: parts[5] ? decodeURIComponent(parts[5]) : '',
              broadcaster: parts[6] ? decodeURIComponent(parts[6]) : ''
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
          act: jsonObj.act || '',
          broadcaster: jsonObj.bc || jsonObj.broadcaster || jsonObj.nick || ''
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

    // 5.5 版权署名：多通道提取主播昵称 (兼容 top-level broadcaster, broadcasterNickname, bc, 以及 meta/decoded 字段)
    var broadcasterVal = (typeof d.broadcaster === 'string' ? d.broadcaster : '') ||
      (typeof d.broadcasterNickname === 'string' ? d.broadcasterNickname : '') ||
      (typeof d.bc === 'string' ? d.bc : '') ||
      (meta && typeof meta.broadcaster === 'string' ? meta.broadcaster : '') ||
      (meta && typeof meta.bc === 'string' ? meta.bc : '') ||
      (decoded && typeof decoded.broadcaster === 'string' ? decoded.broadcaster : '');

    if (broadcasterVal) {
      updateBroadcasterName(broadcasterVal);
    }

    // 5.8 实时更新设置面板中的通信诊断卡片状态 (让用户一目了然是否收到控制端指令)
    var domDiagWsStatus = document.getElementById('diag-ws-status');
    var domDiagLastPacket = document.getElementById('diag-last-packet');
    if (domDiagWsStatus) {
      domDiagWsStatus.textContent = '🟢 正常连通 (房间: ' + roomId + ')';
      domDiagWsStatus.style.color = '#4ade80';
    }
    if (domDiagLastPacket) {
      var dTime = new Date();
      var tStr = (dTime.getHours() < 10 ? '0' : '') + dTime.getHours() + ':' +
                 (dTime.getMinutes() < 10 ? '0' : '') + dTime.getMinutes() + ':' +
                 (dTime.getSeconds() < 10 ? '0' : '') + dTime.getSeconds();
      var actLabel = d.act || (decoded && decoded.act) || 'SCORE';
      domDiagLastPacket.textContent = '[' + tStr + '] ' + actLabel + ' · ' + (nameA || '主队') + ' ' + (scoreA !== undefined ? scoreA : '-') + ':' + (scoreB !== undefined ? scoreB : '-') + ' ' + (nameB || '客队');
      domDiagLastPacket.style.color = '#4ade80';
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
      var finalTargetIndex = (extractedFromAct > 0) ? extractedFromAct : (d.targetIndex || (decoded && decoded.targetIndex) || (decoded && decoded.ci) || (d.clipIndex !== undefined ? (d.clipIndex + 1) : 1));
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
    } else if (actType === 'SHOW_WELCOME_MARQUEE' || d.type === 'SHOW_WELCOME_MARQUEE') {
      var marqueeText = d.marqueeText || d.welcomeText || d.text || (decoded && decoded.marqueeText) || '';
      console.log('[OBS Overlay] Received SHOW_WELCOME_MARQUEE, text:', marqueeText);
      showMarquee(marqueeText);
      alertBanner('📢 收到中控台指令：欢迎横幅已启动');
    } else if (actType === 'HIDE_WELCOME_MARQUEE' || d.type === 'HIDE_WELCOME_MARQUEE') {
      console.log('[OBS Overlay] Received HIDE_WELCOME_MARQUEE');
      hideMarquee();
      alertBanner('🔕 收到中控台指令：欢迎横幅已关闭');
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
      if (!roomId || roomId.length !== 6) return;
      if (!mainWs || mainWs.readyState === WebSocket.CLOSED || mainWs.readyState === WebSocket.CLOSING) {
        if (!isMainConnecting && !mainReconnectTimer) {
          console.warn('[OBS Overlay][Watchdog] Main WS closed or missing, reconnecting...');
          scheduleMainReconnect(1000);
        }
      }
    }, 4000);
  }

  /**
   * OBS CEF 上 fetch 可能不可用或 POST 失败，用 XHR 兜底。
   * @param {string} method
   * @param {string} url
   * @returns {Promise<Object>}
   */
  function xhrJson(method, url) {
    return new Promise(function (resolve, reject) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.timeout = 10000;
        if (method === 'POST') {
          xhr.setRequestHeader('Content-Type', 'application/json');
        }
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText || '{}'));
            } catch (eParse) {
              reject(eParse);
            }
          } else {
            reject(new Error('HTTP ' + xhr.status));
          }
        };
        xhr.onerror = function () { reject(new Error('XHR error')); };
        xhr.ontimeout = function () { reject(new Error('XHR timeout')); };
        xhr.send(method === 'POST' ? '{}' : null);
      } catch (eXhr) {
        reject(eXhr);
      }
    });
  }

  /**
   * @param {string} method
   * @param {string} url
   * @returns {Promise<Object>}
   */
  function fetchJson(method, url) {
    if (typeof fetch === 'function') {
      var opts = { method: method, cache: 'no-store' };
      if (method === 'POST') {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = '{}';
      }
      return fetch(url, opts).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }
    return xhrJson(method, url);
  }

  /**
   * @param {Object} data
   * @returns {string}
   */
  function tokenFromPayload(data) {
    if (data && data.token) return data.token;
    throw new Error('Token missing in response');
  }

  /**
   * POST → GET → XHR，兼容 Chrome 与 OBS CEF。
   * @param {string} targetRoomId
   * @returns {Promise<string>}
   */
  function fetchTokenWithFallback(targetRoomId) {
    var safeRoomId = String(targetRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (safeRoomId.length !== 6) {
      return Promise.reject(new Error('未提供有效 6 位房间号'));
    }

    var primaryUrl = apiBase + '/api/get_token?roomId=' + safeRoomId;

    return fetchJson('POST', primaryUrl)
      .then(tokenFromPayload)
      .catch(function () {
        return fetchJson('GET', primaryUrl).then(tokenFromPayload);
      })
      .catch(function () {
        return xhrJson('POST', primaryUrl).then(tokenFromPayload);
      })
      .catch(function () {
        return xhrJson('GET', primaryUrl).then(tokenFromPayload);
      });
  }

  function initWebSocket() {
    if (!roomId || roomId.length !== 6) {
      console.log('[OBS Overlay] 未配置有效房间号，等待通过专属链接或右键【交互】输入');
      showStatus('⚠️ 未连接中控台：请右键来源选择【交互】输入房间码', 'error', false);
      if (domCurrentRoomText) domCurrentRoomText.textContent = '未设置';
      openRoomModal(true);
      return;
    }

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
          showStatus('🟢 已连通房间 ' + roomId, 'connected', true);

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
        showStatus('🔴 取 Token 失败，正在重试 (房间 ' + roomId + ')', 'error', false);
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
  var hasMediaStartedPlaying = false;
  var actualPlaybackStartedAt = 0;
  var lastReplayStartAt = 0;
  var lastReplayTargetIdx = -1;
  var replaySpeedParam = parseFloat(urlParams.get('replaySpeed') || urlParams.get('speed') || '0.66');
  var detectedReplaySpeed = 0;
  var lastPolledCursor = 0;
  var lastPolledTime = 0;

  function toRawDiskPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    var path = filePath;
    try {
      path = decodeURIComponent(filePath).trim();
    } catch (e) {
      path = String(filePath).trim();
    }
    if (path.indexOf('video?path=') !== -1) {
      path = path.substring(path.indexOf('video?path=') + 11);
    }
    path = path.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '').replace(/^file:\//i, '');
    path = path.replace(/\\/g, '/');
    if (/^\/?[a-zA-Z]:\//.test(path)) {
      path = path.replace(/^\/+/, '');
    } else if (!path.startsWith('/')) {
      path = '/' + path;
    }
    return path;
  }

  function formatFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    var rawPath = toRawDiskPath(filePath);
    if (!rawPath) return '';
    try {
      // Windows 磁盘路径: C:/Users/... -> file:///C:/Users/...
      if (/^[a-zA-Z]:\//.test(rawPath)) {
        return 'file:///' + encodeURI(rawPath);
      }
      // macOS / Linux 磁盘路径: /Users/... -> file:///Users/...
      if (rawPath.startsWith('/')) {
        return 'file://' + encodeURI(rawPath);
      }
      return 'file:///' + encodeURI(rawPath);
    } catch (e) {
      return 'file:///' + rawPath;
    }
  }

  // 提取文件名中的时间戳数字串（如 Replay_2026-08-30_13-05-12.mp4 / .mkv -> 20260830130512）
  function extractClipTimestamp(filePath) {
    if (!filePath || typeof filePath !== 'string') return 0;
    try {
      var fName = decodeURIComponent(filePath).split('/').pop().split('\\').pop();
      var digits = fName.replace(/\D/g, '');
      if (digits.length >= 14) {
        return parseInt(digits.slice(0, 14), 10) || 0;
      }
      if (digits.length >= 6) {
        return parseInt(digits, 10) || 0;
      }
    } catch (e) {}
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

  // 恢复并清洗本地存储的高光切片路径历史（兼容 mp4, mkv, mov, ts, flv 等 OBS 常见录制格式）
  try {
    var storedQueue = localStorage.getItem('obs_highlight_queue');
    if (storedQueue) {
      var parsed = JSON.parse(storedQueue);
      if (Array.isArray(parsed)) {
        highlightQueue = parsed.map(formatFilePath).filter(function (p) {
          return p && /\.(mp4|mkv|mov|ts|flv|m4v|webm)$/i.test(p.split('?')[0]);
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
  var currentObsSceneItems = [];
  var cachedMediaSceneItemId = null;
  var cachedBrowserSceneItemId = null;

  // 发送 OBS 原生媒体源控制指令 (播放 / 停止 / 显示 / 隐藏)
  function obsControlMediaSource(action, filePath) {
    if (!obsNativeWs || obsNativeWs.readyState !== WebSocket.OPEN) {
      console.warn('[OBS Overlay] OBS Native WebSocket is not ready, cannot control media source');
      return;
    }

    if (action === 'PLAY' && filePath) {
      var rawDiskPath = toRawDiskPath(filePath);
      console.log('[OBS Overlay] Setting OBS Media Source [' + obsMediaSourceName + '] to:', rawDiskPath);
      dbgLog('🎬 设置 OBS 媒体源 [' + obsMediaSourceName + '] 播放切片: ' + rawDiskPath.split('/').pop().split('\\').pop(), '#38bdf8', 'INFO');

      // 1. 设置媒体源的文件路径 (跨平台标准绝对路径)
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

      // 2. 获取当前场景，自适应检查并智能置顶图层层级与显示状态
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
      dbgLog('⏹ 停止 OBS 媒体源 [' + obsMediaSourceName + ']', '#94a3b8', 'INFO');

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

      // 3. 若已知图层 ID，立即发送隐藏指令 (0ms 极速响应)
      if (cachedMediaSceneItemId && currentObsSceneName) {
        obsNativeWs.send(JSON.stringify({
          op: 6,
          d: {
            requestType: 'SetSceneItemEnabled',
            requestId: 'req_quick_disable_' + Date.now(),
            requestData: {
              sceneName: currentObsSceneName,
              sceneItemId: cachedMediaSceneItemId,
              sceneItemEnabled: false
            }
          }
        }));
      }

      // 4. 查询当前场景，确保场景同步并隐藏图层
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
                    authentication: authSecret,
                    eventSubscriptions: 1023
                  }
                }));
              }).catch(function (err) {
                console.error('[OBS Overlay] OBS auth digest error:', err);
              });
            } else {
              obsNativeWs.send(JSON.stringify({
                op: 1,
                d: {
                  rpcVersion: 1,
                  eventSubscriptions: 1023
                }
              }));
            }
          } else if (msg.op === 2) {
            console.log('[OBS Overlay] OBS Native WebSocket Identified successfully with full eventSubscriptions (1023)!');
            alertBanner('🟢 已连通 OBS 原生 WebSocket (端口: ' + obsWsPort + ')');

            // 1. 自动自愈恢复：向 OBS 主动查询最近一次保存的高光重放切片
            obsNativeWs.send(JSON.stringify({
              op: 6,
              d: {
                requestType: 'GetLastReplayBufferReplay',
                requestId: 'req_get_last_replay'
              }
            }));

            // 2. 智能探测：查询 OBS 中所有输入源，自动自适应匹配媒体源名称
            obsNativeWs.send(JSON.stringify({
              op: 6,
              d: {
                requestType: 'GetInputList',
                requestId: 'req_get_input_list'
              }
            }));

            // 3. 初始场景与图层智能探测：获取当前激活场景及图层堆叠结构
            obsNativeWs.send(JSON.stringify({
              op: 6,
              d: {
                requestType: 'GetCurrentProgramScene',
                requestId: 'req_init_scene_check'
              }
            }));
          } else if (msg.op === 5 && msg.d) {
            var evtType = msg.d.eventType;
            // 捕获 OBS 录像切片保存事件
            if (evtType === 'ReplayBufferSaved') {
              var savedPath = msg.d.eventData && msg.d.eventData.savedReplayPath;
              if (savedPath) {
                addHighlightFile(savedPath);
                var fileName = decodeURIComponent(String(savedPath).split('/').pop().split('\\').pop());
                alertBanner('⚡成功保存高光片段: ' + fileName);
              }
            }
            // 捕获 OBS 当前场景切换事件
            else if (evtType === 'CurrentProgramSceneChanged') {
              var newScene = msg.d.eventData && msg.d.eventData.sceneName;
              if (newScene) {
                currentObsSceneName = newScene;
                console.log('[OBS Overlay] OBS Program Scene changed to:', newScene);
                dbgLog('🎬 OBS 当前场景切换为: ' + newScene, '#38bdf8', 'INFO');
                if (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) {
                  obsNativeWs.send(JSON.stringify({
                    op: 6,
                    d: {
                      requestType: 'GetSceneItemList',
                      requestId: 'req_scene_items_cache',
                      requestData: { sceneName: newScene }
                    }
                  }));
                }
              }
            }
            // 捕获 OBS 原生媒体源播放结束事件
            else if (evtType === 'MediaInputPlaybackEnded') {
              var inputName = msg.d.eventData && msg.d.eventData.inputName;
              var elapsed = Date.now() - (actualPlaybackStartedAt || replayClipStartedAt || 0);
              // 关键修复：确保真正开始解码播放过 (hasMediaStartedPlaying)，且过滤掉旧媒体残留结束信号
              if (isReplayPlaying && hasMediaStartedPlaying && (inputName === obsMediaSourceName || !inputName) && elapsed > 800) {
                console.log('[OBS Overlay] OBS MediaInputPlaybackEnded event received for [' + inputName + '] after ' + elapsed + 'ms -> advanceOrStopReplay');
                advanceOrStopReplay();
              }
            }
          } else if (msg.op === 7 && msg.d) {
            // 处理场景查询与显示/隐藏控制响应
            var reqId = msg.d.requestId || '';
            if (reqId === 'req_get_last_replay') {
              var lastSavedPath = msg.d.responseData && msg.d.responseData.savedReplayPath;
              if (lastSavedPath) {
                console.log('[OBS Overlay] Auto-recovered last replay buffer clip from OBS:', lastSavedPath);
                addHighlightFile(lastSavedPath);
              }
            } else if (reqId === 'req_get_input_list') {
              var inputList = (msg.d.responseData && msg.d.responseData.inputs) || [];
              var exactMatch = false;

              // 1. 第一优先级：精确匹配当前配置或默认的媒体源名称 (如 "高光回放")
              for (var i = 0; i < inputList.length; i++) {
                var item = inputList[i];
                var iName = item.inputName || item.name || '';
                if (iName === obsMediaSourceName) {
                  exactMatch = true;
                  break;
                }
              }

              // 2. 第二优先级：名称中含有强高光/回放意图关键字的媒体源 (如 "高光", "回放", "replay", "highlight")
              if (!exactMatch) {
                for (var j = 0; j < inputList.length; j++) {
                  var itemCandidate = inputList[j];
                  var cName = itemCandidate.inputName || itemCandidate.name || '';
                  var cKind = itemCandidate.inputKind || itemCandidate.unversionedInputKind || '';
                  var lowerName = cName.toLowerCase();
                  if (cKind === 'ffmpeg_source' && (cName.indexOf('高光') !== -1 || cName.indexOf('回放') !== -1 || lowerName.indexOf('replay') !== -1 || lowerName.indexOf('highlight') !== -1)) {
                    console.log('[OBS Overlay] Auto-matched OBS replay media source name to [' + cName + '] (kind: ' + cKind + ')');
                    obsMediaSourceName = cName;
                    exactMatch = true;
                    break;
                  }
                }
              }

              // 3. 第三优先级：名称含有 "媒体源" 或 "media source"，且明确排除音频/背景音乐/开场/片头片尾等干扰项
              if (!exactMatch) {
                for (var k = 0; k < inputList.length; k++) {
                  var itemCandidate2 = inputList[k];
                  var cName2 = itemCandidate2.inputName || itemCandidate2.name || '';
                  var cKind2 = itemCandidate2.inputKind || itemCandidate2.unversionedInputKind || '';
                  var lowerName2 = cName2.toLowerCase();
                  var isExcluded = (lowerName2.indexOf('bgm') !== -1 || lowerName2.indexOf('music') !== -1 || cName2.indexOf('音乐') !== -1 || cName2.indexOf('音频') !== -1 || cName2.indexOf('开场') !== -1 || cName2.indexOf('片头') !== -1 || cName2.indexOf('片尾') !== -1 || cName2.indexOf('转场') !== -1);
                  if (cKind2 === 'ffmpeg_source' && !isExcluded && (cName2.indexOf('媒体源') !== -1 || lowerName2.indexOf('media source') !== -1)) {
                    console.log('[OBS Overlay] Auto-matched OBS replay media source name to fallback [' + cName2 + '] (kind: ' + cKind2 + ')');
                    obsMediaSourceName = cName2;
                    exactMatch = true;
                    break;
                  }
                }
              }

              if (exactMatch) {
                console.log('[OBS Overlay] Verified OBS replay media source name:', obsMediaSourceName);
              } else {
                console.warn('[OBS Overlay] Warning: Media source [' + obsMediaSourceName + '] not found in OBS inputs. Keeping default [' + obsMediaSourceName + '].');
              }
            } else if (reqId === 'req_init_scene_check') {
              var initScName = msg.d.responseData && (msg.d.responseData.currentProgramSceneName || msg.d.responseData.sceneName);
              if (initScName) {
                currentObsSceneName = initScName;
                console.log('[OBS Overlay] Initial OBS Program Scene:', initScName);
                obsNativeWs.send(JSON.stringify({
                  op: 6,
                  d: {
                    requestType: 'GetSceneItemList',
                    requestId: 'req_scene_items_cache',
                    requestData: { sceneName: initScName }
                  }
                }));
              }
            } else if (reqId === 'req_scene_for_play' || reqId === 'req_scene_for_stop') {
              var scName = msg.d.responseData && (msg.d.responseData.currentProgramSceneName || msg.d.responseData.sceneName);
              if (scName) {
                currentObsSceneName = scName;
                var willEnable = (reqId === 'req_scene_for_play');
                // 关键升级：向 OBS 查询该场景所有图层列表，以进行智能层级置顶和显隐控制
                obsNativeWs.send(JSON.stringify({
                  op: 6,
                  d: {
                    requestType: 'GetSceneItemList',
                    requestId: willEnable ? 'req_scene_items_for_play' : 'req_scene_items_for_stop',
                    requestData: {
                      sceneName: scName
                    }
                  }
                }));
              }
            } else if (reqId === 'req_scene_items_for_play' || reqId === 'req_scene_items_for_stop' || reqId === 'req_scene_items_cache') {
              var isPlay = (reqId === 'req_scene_items_for_play');
              var isStop = (reqId === 'req_scene_items_for_stop');
              var scItems = (msg.d.responseData && msg.d.responseData.sceneItems) || [];
              currentObsSceneItems = scItems;

              var targetMediaItem = null;
              var targetBrowserItem = null;
              var maxOtherIndex = -1;

              for (var si = 0; si < scItems.length; si++) {
                var it = scItems[si];
                var sName = it.sourceName || '';
                var sKind = it.inputKind || '';
                if (sName === obsMediaSourceName) {
                  targetMediaItem = it;
                } else if (sKind === 'browser_source' || sName.indexOf('浏览器') !== -1 || sName.toLowerCase().indexOf('overlay') !== -1) {
                  targetBrowserItem = it;
                } else {
                  if (it.sceneItemIndex > maxOtherIndex) {
                    maxOtherIndex = it.sceneItemIndex;
                  }
                }
              }

              // 备用兜底：若按精确名称未匹配到，寻找含有高光/回放的 ffmpeg_source
              if (!targetMediaItem) {
                for (var si2 = 0; si2 < scItems.length; si2++) {
                  var it2 = scItems[si2];
                  var itKind = it2.inputKind || '';
                  var itName = it2.sourceName || '';
                  if (itKind === 'ffmpeg_source' && (itName.indexOf('高光') !== -1 || itName.indexOf('回放') !== -1)) {
                    targetMediaItem = it2;
                    obsMediaSourceName = itName;
                    break;
                  }
                }
              }

              if (targetMediaItem && currentObsSceneName) {
                cachedMediaSceneItemId = targetMediaItem.sceneItemId;
                if (targetBrowserItem) {
                  cachedBrowserSceneItemId = targetBrowserItem.sceneItemId;
                }

                if (isPlay) {
                  // 1. 智能图层层级提拔与重排：
                  // 高光回放图层必须排在所有实时相机/SRT/采集卡之上，且位于记分牌网页图层正下方！
                  var totalCount = scItems.length;
                  var idealMediaIndex = Math.max(0, totalCount - 1);

                  if (targetBrowserItem) {
                    // 若记分牌处于较高层，高光回放排在记分牌正下方
                    if (targetBrowserItem.sceneItemIndex >= targetMediaItem.sceneItemIndex) {
                      idealMediaIndex = Math.max(0, targetBrowserItem.sceneItemIndex - 1);
                    } else {
                      idealMediaIndex = Math.max(0, totalCount - 2);
                    }
                  }

                  if (targetMediaItem.sceneItemIndex < idealMediaIndex || (maxOtherIndex >= 0 && targetMediaItem.sceneItemIndex < maxOtherIndex)) {
                    console.log('[OBS Overlay] Auto-promoting media source [' + obsMediaSourceName + '] layer index from ' + targetMediaItem.sceneItemIndex + ' to ' + idealMediaIndex);
                    dbgLog('🚀 智能置顶高光图层: 从第 ' + (targetMediaItem.sceneItemIndex + 1) + ' 层提升至第 ' + (idealMediaIndex + 1) + ' 层 (覆盖现场直播画面)', '#38bdf8', 'INFO');
                    obsNativeWs.send(JSON.stringify({
                      op: 6,
                      d: {
                        requestType: 'SetSceneItemIndex',
                        requestId: 'req_set_media_index_' + Date.now(),
                        requestData: {
                          sceneName: currentObsSceneName,
                          sceneItemId: targetMediaItem.sceneItemId,
                          sceneItemIndex: idealMediaIndex
                        }
                      }
                    }));
                  }

                  // 2. 自适应画布全屏缩放：确保 1920x1080 满屏无缝贴合 (OBS_BOUNDS_SCALE_INNER)
                  obsNativeWs.send(JSON.stringify({
                    op: 6,
                    d: {
                      requestType: 'SetSceneItemTransform',
                      requestId: 'req_set_media_transform_' + Date.now(),
                      requestData: {
                        sceneName: currentObsSceneName,
                        sceneItemId: targetMediaItem.sceneItemId,
                        sceneItemTransform: {
                          boundsType: 'OBS_BOUNDS_SCALE_INNER',
                          boundsWidth: 1920,
                          boundsHeight: 1080,
                          boundsAlignment: 0,
                          positionX: 0,
                          positionY: 0,
                          alignment: 5
                        }
                      }
                    }
                  }));

                  // 3. 显式开启图层显示 (开启眼睛)
                  obsNativeWs.send(JSON.stringify({
                    op: 6,
                    d: {
                      requestType: 'SetSceneItemEnabled',
                      requestId: 'req_enable_media_layer_' + Date.now(),
                      requestData: {
                        sceneName: currentObsSceneName,
                        sceneItemId: targetMediaItem.sceneItemId,
                        sceneItemEnabled: true
                      }
                    }
                  }));
                  dbgLog('👁️ 已激活高光回放图层显示 (ID: ' + targetMediaItem.sceneItemId + ')', '#34d399', 'INFO');

                  // 4. 补发一次 RESTART 播放信号，确保渲染就绪
                  obsNativeWs.send(JSON.stringify({
                    op: 6,
                    d: {
                      requestType: 'TriggerMediaInputAction',
                      requestId: 'req_media_restart_confirm',
                      requestData: {
                        inputName: obsMediaSourceName,
                        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
                      }
                    }
                  }));
                } else if (isStop) {
                  // STOP: 隐藏图层
                  obsNativeWs.send(JSON.stringify({
                    op: 6,
                    d: {
                      requestType: 'SetSceneItemEnabled',
                      requestId: 'req_disable_media_layer_' + Date.now(),
                      requestData: {
                        sceneName: currentObsSceneName,
                        sceneItemId: targetMediaItem.sceneItemId,
                        sceneItemEnabled: false
                      }
                    }
                  }));
                  dbgLog('⏹ 已隐藏高光图层 (ID: ' + targetMediaItem.sceneItemId + ')，切回现场直播', '#94a3b8', 'INFO');
                }
              } else if (!targetMediaItem && currentObsSceneName && isPlay) {
                console.warn('[OBS Overlay] Media source [' + obsMediaSourceName + '] not found in scene [' + currentObsSceneName + ']');
                dbgLog('⚠️ 未在当前场景 [' + currentObsSceneName + '] 中找到媒体源 [' + obsMediaSourceName + ']', '#f87171', 'WARN');
              }
            } else if (reqId === 'req_media_poll_status') {
              var resp = msg.d.responseData || {};
              var duration = resp.mediaDuration || 0;
              var cursor = resp.mediaCursor || 0;
              var state = String(resp.mediaState || '').toUpperCase();
              var now = Date.now();

              // 持续记录捕获到的最大视频文件时长 (毫秒)
              if (duration > 0 && duration > currentClipDuration) {
                currentClipDuration = duration;
              }

              // 当媒体源明确进入 PLAYING 状态或 cursor > 100ms 时，确认真正开始解码播放
              if (!hasMediaStartedPlaying && (state === 'OBS_MEDIA_STATE_PLAYING' || cursor > 100)) {
                hasMediaStartedPlaying = true;
                actualPlaybackStartedAt = now;
                console.log('[OBS Overlay] Media playback confirmed active at:', actualPlaybackStartedAt, 'state:', state, 'cursor:', cursor);
              }

              // 动态测量当前 OBS 实际播放倍速 (根据 cursor 进度增量与真实 wall-clock 时间增量换算)
              if (cursor > 200 && lastPolledCursor > 0 && cursor > lastPolledCursor && lastPolledTime > 0) {
                var deltaCursor = cursor - lastPolledCursor;
                var deltaTime = now - lastPolledTime;
                if (deltaTime > 150 && deltaTime < 1000 && deltaCursor > 0) {
                  var measured = deltaCursor / deltaTime;
                  if (measured >= 0.1 && measured <= 2.5) {
                    detectedReplaySpeed = detectedReplaySpeed ? (detectedReplaySpeed * 0.7 + measured * 0.3) : measured;
                  }
                }
              }
              lastPolledCursor = cursor;
              lastPolledTime = now;

              var effectiveSpeed = detectedReplaySpeed || replaySpeedParam || 0.66;
              var elapsedFromStart = actualPlaybackStartedAt ? (now - actualPlaybackStartedAt) : (now - replayClipStartedAt);
              var expectedWallDuration = (currentClipDuration > 0 && effectiveSpeed > 0) ? Math.round(currentClipDuration / effectiveSpeed) : 0;

              // 播完多重高精度判定
              if (isReplayPlaying) {
                var isEnded = false;

                // 1. OBS 明确返回了停止、闲置或结束状态 (前提：必须已经正式开始播放过，防止加载中误判)
                if (hasMediaStartedPlaying && (state === 'OBS_MEDIA_STATE_ENDED' || state === 'OBS_MEDIA_STATE_STOPPED' || state === 'OBS_MEDIA_STATE_NONE')) {
                  console.log('[OBS Overlay] Replay clip finished via state after playback started:', state);
                  isEnded = true;
                }
                // 2. 播放进度 cursor 接近已记录的文件时长 (文件内部时间戳，不受播放倍速影响)
                else if (hasMediaStartedPlaying && currentClipDuration > 0 && cursor >= currentClipDuration - 300) {
                  console.log('[OBS Overlay] Replay clip finished via file cursor:', cursor, '/', currentClipDuration);
                  isEnded = true;
                }
                // 3. 真实经过时间超过按倍速换算后的播放时长（给予 2.5 秒缓冲，避免提前掐断慢放）
                else if (hasMediaStartedPlaying && expectedWallDuration > 0 && elapsedFromStart >= expectedWallDuration + 2500) {
                  console.log('[OBS Overlay] Replay clip finished via converted wall duration:', elapsedFromStart, '>=', expectedWallDuration + 2500, '(file duration:', currentClipDuration, 'speed:', effectiveSpeed.toFixed(2), ')');
                  isEnded = true;
                }
                // 4. 超时安全强制兜底 (设为换算时长 + 15s 或 120 秒，杜绝硬切)
                else if (elapsedFromStart >= (expectedWallDuration > 0 ? expectedWallDuration + 15000 : 120000)) {
                  console.log('[OBS Overlay] Replay clip finished via max safety timeout');
                  isEnded = true;
                }
                // 5. 若媒体指令下发超过 8 秒且始终未能成功解码播放（如文件缺失或源未就绪），自动结束回放释放画面
                else if (!hasMediaStartedPlaying && (now - replayClipStartedAt) > 8000) {
                  console.warn('[OBS Overlay] Replay media failed to start playing within 8s timeout, advancing/stopping replay');
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
    var now = Date.now();

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
      // 紧急自愈机会：主动向 OBS 请求最近一次保存的高光切片
      if (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) {
        obsNativeWs.send(JSON.stringify({
          op: 6,
          d: {
            requestType: 'GetLastReplayBufferReplay',
            requestId: 'req_get_last_replay'
          }
        }));
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

    // 边界安全钳位与对齐提示
    if (opt.targetIndex && opt.targetIndex > sortedQueue.length) {
      console.warn('[OBS Overlay] Requested clip #' + opt.targetIndex + ' exceeds current queue length (' + sortedQueue.length + '), clamped to #' + (targetIdx + 1));
      if (typeof dbgLog === 'function') {
        dbgLog('⚠️ 点播第 ' + opt.targetIndex + ' 段超出网页端捕获数(' + sortedQueue.length + '段)，播放第 ' + (targetIdx + 1) + ' 段', '#fbbf24');
      }
    }
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= sortedQueue.length) targetIdx = sortedQueue.length - 1;

    // 3. 防抖与去重：如果 2.5 秒内收到相同的播放请求，且当前已经在播放该片段，予以忽略（防止连击打断 OBS 播放）
    if (isReplayPlaying && lastReplayTargetIdx === targetIdx && (now - lastReplayStartAt) < 2500) {
      console.log('[OBS Overlay] Ignored duplicate START_HIGHLIGHT_REPLAY command for targetIdx:', targetIdx, 'within 2500ms cooldown');
      return;
    }

    lastReplayStartAt = now;
    lastReplayTargetIdx = targetIdx;
    isReplayPlaying = true;
    isPlayingSingleClipOnly = true;

    currentReplayIndex = targetIdx;
    var targetFile = sortedQueue[currentReplayIndex];
    var targetName = decodeURIComponent(String(targetFile).split('/').pop().split('\\').pop());

    console.log('[OBS Overlay] Playing highlight clip [第 ' + (currentReplayIndex + 1) + ' 段 / 共 ' + sortedQueue.length + ' 段]:', targetFile);
    if (typeof dbgLog === 'function') {
      dbgLog('▶ 启动高光切片播放 [第 ' + (currentReplayIndex + 1) + ' 段 / 共 ' + sortedQueue.length + ' 段]: ' + targetName, '#38bdf8');
    }

    // 4. 强制重置并触发 Wipe 入场转场遮罩（蓝色 Stinger + "精彩回放 HIGHLIGHT REPLAY"）
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
    hasMediaStartedPlaying = false;
    actualPlaybackStartedAt = 0;
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
    hasMediaStartedPlaying = false;
    actualPlaybackStartedAt = 0;
    lastReplayTargetIdx = -1;

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

  // ──────────────────────────────────────────────
  // 房间号一键设置/修改 & 图层显隐管理逻辑
  // ──────────────────────────────────────────────
  var domRoomEditBtn = document.getElementById('ws-room-edit-btn');
  var domCurrentRoomText = document.getElementById('ws-current-room-text');
  var domRoomModal = document.getElementById('room-setting-modal');
  var domRoomInput = document.getElementById('room-modal-input');
  var domRoomSubmitBtn = document.getElementById('room-modal-submit-btn');
  var domRoomCloseBtn = document.getElementById('room-modal-close');
  var domModalErrTip = document.getElementById('modal-err-tip');

  var domBtnToggleCopyright = document.getElementById('btn-toggle-copyright');
  var domIconToggleCopyright = document.getElementById('icon-toggle-copyright');
  var domTextToggleCopyright = document.getElementById('text-toggle-copyright');

  var domBtnToggleLive = document.getElementById('btn-toggle-live');
  var domIconToggleLive = document.getElementById('icon-toggle-live');
  var domTextToggleLive = document.getElementById('text-toggle-live');

  var domBtnResetLayerPos = document.getElementById('btn-reset-layer-pos');

  if (domCurrentRoomText) {
    domCurrentRoomText.textContent = roomId || '未设置';
  }
  if (domRoomInput) {
    domRoomInput.value = roomId || '';
  }

  function showModalError(msg) {
    if (domModalErrTip) {
      domModalErrTip.textContent = msg || '';
      domModalErrTip.style.display = msg ? 'block' : 'none';
    }
  }

  /**
   * 刷新面板上的图层显隐按钮状态
   */
  function updateLayerControlUI() {
    if (domCopyrightBadge && domBtnToggleCopyright) {
      var isCopyHidden = (domCopyrightBadge.style.display === 'none');
      if (domIconToggleCopyright) domIconToggleCopyright.textContent = isCopyHidden ? '🚫' : '📷';
      if (domTextToggleCopyright) domTextToggleCopyright.textContent = isCopyHidden ? '版权说明: 已隐藏 [点此恢复]' : '版权说明: 显示中';
      if (isCopyHidden) {
        domBtnToggleCopyright.classList.add('layer-hidden');
      } else {
        domBtnToggleCopyright.classList.remove('layer-hidden');
      }
    }

    if (domDynamicIslandBadge && domBtnToggleLive) {
      var isLiveHidden = (domDynamicIslandBadge.style.display === 'none');
      if (domIconToggleLive) domIconToggleLive.textContent = isLiveHidden ? '🚫' : '🔴';
      if (domTextToggleLive) domTextToggleLive.textContent = isLiveHidden ? 'LIVE角标: 已隐藏 [点此恢复]' : 'LIVE角标: 显示中';
      if (isLiveHidden) {
        domBtnToggleLive.classList.add('layer-hidden');
      } else {
        domBtnToggleLive.classList.remove('layer-hidden');
      }
    }
  }

  /**
   * 恢复或显隐现场实拍版权声明说明
   * @param {boolean} [forceShow]
   */
  window.__toggleCopyrightBadge = function (forceShow) {
    if (!domCopyrightBadge) return;
    var isHidden = (domCopyrightBadge.style.display === 'none');
    var shouldShow = (forceShow !== undefined) ? !!forceShow : isHidden;
    domCopyrightBadge.style.display = shouldShow ? 'flex' : 'none';

    try {
      var saved = localStorage.getItem('obs_copyright_badge_state');
      var state = saved ? JSON.parse(saved) : {};
      state.hidden = !shouldShow;
      localStorage.setItem('obs_copyright_badge_state', JSON.stringify(state));
    } catch (e) {}

    updateLayerControlUI();
    showStatus(shouldShow ? '📷 版权说明: 已恢复显示' : '📷 版权说明: 已隐藏', 'connected', true);
  };

  /**
   * 恢复或显隐 LIVE 直播纵向角标
   * @param {boolean} [forceShow]
   */
  window.__toggleLiveBadge = function (forceShow) {
    if (!domDynamicIslandBadge) return;
    var isHidden = (domDynamicIslandBadge.style.display === 'none');
    var shouldShow = (forceShow !== undefined) ? !!forceShow : isHidden;
    domDynamicIslandBadge.style.display = shouldShow ? 'flex' : 'none';

    try {
      var saved = localStorage.getItem('obs_island_uniform_state');
      var state = saved ? JSON.parse(saved) : {};
      state.hidden = !shouldShow;
      localStorage.setItem('obs_island_uniform_state', JSON.stringify(state));
    } catch (e) {}

    updateLayerControlUI();
    showStatus(shouldShow ? '🔴 LIVE角标: 已恢复显示' : '🔴 LIVE角标: 已隐藏', 'connected', true);
  };

  /**
   * 一键将所有角标恢复为默认位置与默认可见状态
   */
  window.__resetAllLayerPositions = function () {
    try {
      localStorage.removeItem('obs_copyright_badge_state');
      localStorage.removeItem('obs_island_uniform_state');
    } catch (e) {}

    if (domCopyrightBadge) {
      domCopyrightBadge.style.display = 'flex';
      domCopyrightBadge.style.left = 'auto';
      domCopyrightBadge.style.right = '24px';
      domCopyrightBadge.style.bottom = '24px';
      domCopyrightBadge.style.top = 'auto';
      domCopyrightBadge.style.transform = 'scale(1.0)';
    }

    if (domDynamicIslandBadge) {
      domDynamicIslandBadge.style.display = 'flex';
      domDynamicIslandBadge.style.left = '0px';
      domDynamicIslandBadge.style.top = '0px';
      domDynamicIslandBadge.style.transform = 'scale(1.0)';
    }

    updateLayerControlUI();
    showStatus('🔄 所有角标已恢复默认位置与显示', 'connected', true);
  };

  var domModalCurrentRoomText = document.getElementById('modal-current-room-text');

  function openRoomModal(isMandatory) {
    if (domRoomModal) domRoomModal.classList.remove('room-modal--hidden');
    showModalError('');
    updateLayerControlUI();
    if (domModalCurrentRoomText) {
      domModalCurrentRoomText.textContent = roomId ? (roomId + ' (已连接)') : '未设置';
    }
    var domDiagWsStatus = document.getElementById('diag-ws-status');
    var domDiagObsStatus = document.getElementById('diag-obs-ws-status');
    if (domDiagWsStatus) {
      if (mainWs && mainWs.readyState === WebSocket.OPEN) {
        domDiagWsStatus.textContent = '🟢 正常连通 (房间: ' + roomId + ')';
        domDiagWsStatus.style.color = '#4ade80';
      } else {
        domDiagWsStatus.textContent = '🔴 未连接 (房间: ' + (roomId || '未设置') + ')';
        domDiagWsStatus.style.color = '#f87171';
      }
    }
    if (domDiagObsStatus) {
      if (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) {
        domDiagObsStatus.textContent = '🟢 正常连通 (端口 ' + obsWsPort + ')';
        domDiagObsStatus.style.color = '#4ade80';
      } else {
        domDiagObsStatus.textContent = '🔴 未连接 (端口 ' + obsWsPort + '，需在 OBS【工具->WebSocket服务器设置】开启)';
        domDiagObsStatus.style.color = '#f87171';
      }
    }
    if (domRoomCloseBtn) {
      domRoomCloseBtn.style.display = (isMandatory && (!roomId || roomId.length !== 6)) ? 'none' : 'block';
    }
    if (domRoomInput) {
      domRoomInput.value = roomId || '';
      setTimeout(function () {
        try {
          domRoomInput.focus();
          domRoomInput.select();
        } catch (e) {}
      }, 50);
    }
  }

  function closeRoomModal() {
    if (roomId && roomId.length === 6) {
      if (domRoomModal) domRoomModal.classList.add('room-modal--hidden');
      showModalError('');
    } else {
      showModalError('⚠️ 请先输入 6 位房间码并点击连接');
    }
  }

  function switchRoomId(newId) {
    var digits = String(newId || '').replace(/\D/g, '').slice(0, 6);
    if (digits.length !== 6) {
      showModalError('⚠️ 请输入完整的 6 位纯数字房间码！');
      if (domRoomInput) domRoomInput.focus();
      return;
    }
    showModalError('');
    roomId = digits;
    try { localStorage.setItem('obs_room_id', roomId); } catch (e) {}
    if (domCurrentRoomText) domCurrentRoomText.textContent = roomId;
    if (domModalCurrentRoomText) domModalCurrentRoomText.textContent = roomId + ' (正在连接)';
    var domDiagWsStatus = document.getElementById('diag-ws-status');
    if (domDiagWsStatus) {
      domDiagWsStatus.textContent = '⏳ 正在连接房间 ' + roomId + '...';
      domDiagWsStatus.style.color = '#38bdf8';
    }
    if (domRoomInput) domRoomInput.value = roomId;
    if (domRoomModal) domRoomModal.classList.add('room-modal--hidden');

    console.log('[OBS Overlay] Switched roomId to:', roomId);
    showStatus('🔑 正在连接至房间 ' + roomId + '...', '', false);
    
    // 强制重置连接状态，防止被旧连接锁阻断
    isMainConnecting = false;
    if (mainWs) {
      try {
        mainWs.onclose = null;
        mainWs.close();
      } catch (e) {}
      mainWs = null;
    }
    // 重新连接主记分 WebSocket 并启动看门狗
    initWebSocket();
    startMainWatchdog();
  }

  if (domRoomEditBtn) {
    domRoomEditBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openRoomModal(false);
    });
  }
  if (domRoomCloseBtn) domRoomCloseBtn.addEventListener('click', closeRoomModal);
  if (domRoomSubmitBtn) {
    domRoomSubmitBtn.addEventListener('click', function () {
      if (domRoomInput) switchRoomId(domRoomInput.value);
    });
  }
  if (domRoomInput) {
    domRoomInput.addEventListener('input', function () {
      showModalError('');
    });
    domRoomInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        switchRoomId(domRoomInput.value);
      }
    });
  }

  // 双击顶部记分牌也可在 OBS 交互中唤出设置面板
  if (domScoreboard) {
    domScoreboard.addEventListener('dblclick', function () {
      openRoomModal(false);
    });
  }

  // 图层控制按钮事件
  if (domBtnToggleCopyright) {
    domBtnToggleCopyright.addEventListener('click', function () {
      window.__toggleCopyrightBadge();
    });
  }
  if (domBtnToggleLive) {
    domBtnToggleLive.addEventListener('click', function () {
      window.__toggleLiveBadge();
    });
  }
  if (domBtnResetLayerPos) {
    domBtnResetLayerPos.addEventListener('click', function () {
      window.__resetAllLayerPositions();
    });
  }

  // 点击遮罩空白处关闭设置面板 (若已连接房间)
  if (domRoomModal) {
    domRoomModal.addEventListener('click', function (e) {
      if (e.target === domRoomModal) {
        closeRoomModal();
      }
    });
  }

  // 快捷键支持：R (换房间/开设置), C (显隐版权说明), L (显隐LIVE角标)
  window.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      return;
    }
    var k = (e.key || '').toUpperCase();
    if (k === 'R') {
      if (domRoomModal) {
        if (domRoomModal.classList.contains('room-modal--hidden')) {
          openRoomModal(false);
        } else {
          closeRoomModal();
        }
      }
    } else if (k === 'C') {
      window.__toggleCopyrightBadge();
    } else if (k === 'L') {
      window.__toggleLiveBadge();
    }
  });

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

  var domDbgCopyLogs = document.getElementById('dbg-btn-copy-logs');
  var domDbgExportLogs = document.getElementById('dbg-btn-export-logs');
  var domModalBtnOpenDebug = document.getElementById('modal-btn-open-debug');
  var domModalBtnCopyLogs = document.getElementById('modal-btn-copy-logs');
  var domModalBtnExportLogs = document.getElementById('modal-btn-export-logs');

  /** 生成包含系统状态、OBS连接、切片队列与详细时序事件的完整排查报告 */
  function generateDebugReportText() {
    var now = new Date();
    var lines = [];
    lines.push('================================================================');
    lines.push('  MIAOJI OBS OVERLAY 排查诊断日志报告');
    lines.push('  导出时间: ' + now.toLocaleString());
    lines.push('================================================================');
    lines.push('');
    lines.push('【系统与运行环境】');
    lines.push('- 页面地址: ' + window.location.href);
    lines.push('- UserAgent: ' + navigator.userAgent);
    lines.push('- 屏幕分辨率: ' + window.innerWidth + 'x' + window.innerHeight + ' (DPR: ' + (window.devicePixelRatio || 1) + ')');
    lines.push('');
    lines.push('【连接与服务状态】');
    lines.push('- 房间号 (roomId): ' + (roomId || '未设置'));
    lines.push('- 主记分网关 WebSocket: ' + (mainWs ? (mainWs.readyState === WebSocket.OPEN ? '🟢 OPEN (已连接)' : '🔴 readyState=' + mainWs.readyState) : '未初始化'));
    lines.push('- OBS 本地 WebSocket: ' + (obsNativeWs ? (obsNativeWs.readyState === WebSocket.OPEN ? '🟢 OPEN (端口 ' + obsWsPort + ' 已连接)' : '🔴 readyState=' + obsNativeWs.readyState) : '未初始化'));
    lines.push('- 媒体源名称 (obsMediaSourceName): ' + obsMediaSourceName);
    lines.push('- 当前 OBS 场景名 (currentObsSceneName): ' + (currentObsSceneName || '未获取'));
    lines.push('- 已缓存媒体源图层 ID (cachedMediaSceneItemId): ' + (cachedMediaSceneItemId != null ? cachedMediaSceneItemId : '未捕获'));
    lines.push('');
    lines.push('【OBS 场景图层堆叠结构 (由底至顶，共 ' + currentObsSceneItems.length + ' 层)】');
    if (currentObsSceneItems.length === 0) {
      lines.push('  (未获取到场景图层信息，请确认 OBS WebSocket 已连接且存在图层)');
    } else {
      for (var s = 0; s < currentObsSceneItems.length; s++) {
        var itm = currentObsSceneItems[s];
        var isMedia = (itm.sourceName === obsMediaSourceName);
        var isBrowser = (itm.inputKind === 'browser_source');
        var mark = isMedia ? ' 🎬 [高光回放目标源]' : (isBrowser ? ' 🌐 [记分牌网页图层]' : '');
        lines.push('  [第 ' + (itm.sceneItemIndex + 1) + ' 层 / Index ' + itm.sceneItemIndex + '] ' + itm.sourceName + ' (类型: ' + (itm.inputKind || itm.sourceType) + ', 显示: ' + (itm.sceneItemEnabled ? '开' : '关') + ')' + mark);
      }
    }
    lines.push('');
    lines.push('【高光切片队列 (共 ' + highlightQueue.length + ' 段)】');
    if (highlightQueue.length === 0) {
      lines.push('  (暂无高光切片，请确认 OBS 重放缓冲区是否已开启并成功保存)');
    } else {
      for (var i = 0; i < highlightQueue.length; i++) {
        var qPath = highlightQueue[i];
        lines.push('  [' + (i + 1) + '] ' + qPath + ' -> 磁盘路径: ' + toRawDiskPath(qPath));
      }
    }
    lines.push('');
    lines.push('【当前回放状态】');
    lines.push('- 是否回放中 (isReplayPlaying): ' + isReplayPlaying);
    lines.push('- 当前播放切片索引: ' + currentReplayIndex);
    lines.push('- 媒体是否真正开始解码 (hasMediaStartedPlaying): ' + hasMediaStartedPlaying);
    lines.push('- 记录的时长 (currentClipDuration): ' + currentClipDuration + 'ms');
    lines.push('- 测算播放倍速 (detectedReplaySpeed): ' + (detectedReplaySpeed ? detectedReplaySpeed.toFixed(2) : '未测得'));
    lines.push('');
    lines.push('【详细时序事件日志 (最近 ' + debugLogHistory.length + ' 条)】');
    lines.push('----------------------------------------------------------------');
    var chronological = debugLogHistory.slice().reverse();
    for (var j = 0; j < chronological.length; j++) {
      var item = chronological[j];
      lines.push('[' + item.fullTime + '] [' + item.level + '] ' + item.msg);
    }
    lines.push('');
    lines.push('============================ 报告结束 ============================');
    return lines.join('\n');
  }

  function copyDebugLogs() {
    var text = generateDebugReportText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        alertBanner('📋 排查日志已成功复制到剪贴板！请直接粘贴发送');
      }).catch(function () {
        fallbackCopyText(text);
      });
    } else {
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var res = document.execCommand('copy');
      document.body.removeChild(ta);
      if (res) {
        alertBanner('📋 排查日志已成功复制到剪贴板！请直接粘贴发送');
      } else {
        window.prompt('请按 Ctrl+C 复制以下排查日志：', text);
      }
    } catch (eCopy) {
      window.prompt('请按 Ctrl+C 复制以下排查日志：', text);
    }
  }

  function exportDebugLogs() {
    try {
      var text = generateDebugReportText();
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var now = new Date();
      var dateStr = now.getFullYear() +
                    ('0' + (now.getMonth() + 1)).slice(-2) +
                    ('0' + now.getDate()).slice(-2) + '_' +
                    ('0' + now.getHours()).slice(-2) +
                    ('0' + now.getMinutes()).slice(-2) +
                    ('0' + now.getSeconds()).slice(-2);
      var fileName = 'obs_overlay_logs_' + (roomId || 'default') + '_' + dateStr + '.txt';

      if (window.navigator && window.navigator.msSaveOrOpenBlob) {
        window.navigator.msSaveOrOpenBlob(blob, fileName);
      } else {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      }
      alertBanner('📥 已下载排查日志: ' + fileName);
    } catch (eExp) {
      console.error('[OBS Overlay] Export log failed:', eExp);
      copyDebugLogs();
    }
  }

  window.__copyDebugLogs = copyDebugLogs;
  window.__exportDebugLogs = exportDebugLogs;
  window.__getDebugReport = generateDebugReportText;
  window.__openDebugPanel = function () {
    if (domDebugPanel) {
      domDebugPanel.style.display = 'flex';
      updateDebugUI();
    }
  };

  function updateDebugUI() {
    if (domDbgRoomStatus) {
      domDbgRoomStatus.textContent = (mainWs && mainWs.readyState === WebSocket.OPEN) ? ('🟢 已连通 (房间 ' + roomId + ')') : '🔴 未连接';
      domDbgRoomStatus.style.color = (mainWs && mainWs.readyState === WebSocket.OPEN) ? '#4ade80' : '#f87171';
    }
    if (domDbgObsStatus) {
      domDbgObsStatus.textContent = (obsNativeWs && obsNativeWs.readyState === WebSocket.OPEN) ? ('🟢 已连通 (端口 ' + obsWsPort + ' | ' + obsMediaSourceName + ')') : '🔴 未连接';
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
        if (!isShow) updateDebugUI();
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

  if (domDbgCopyLogs) {
    domDbgCopyLogs.addEventListener('click', copyDebugLogs);
  }
  if (domDbgExportLogs) {
    domDbgExportLogs.addEventListener('click', exportDebugLogs);
  }
  if (domModalBtnOpenDebug) {
    domModalBtnOpenDebug.addEventListener('click', function () {
      if (domDebugPanel) domDebugPanel.style.display = 'flex';
      updateDebugUI();
    });
  }
  if (domModalBtnCopyLogs) {
    domModalBtnCopyLogs.addEventListener('click', copyDebugLogs);
  }
  if (domModalBtnExportLogs) {
    domModalBtnExportLogs.addEventListener('click', exportDebugLogs);
  }

  // 初始默认高对比度应用
  applyTeamContrastStyle(domHomeName, domHomeScore, currentHomeColor);
  applyTeamContrastStyle(domAwayName, domAwayScore, currentAwayColor);

  // 初始化主记分 WebSocket 与看门狗 (优先 URL / 缓存，无则向导输入)
  if (domCurrentRoomText) domCurrentRoomText.textContent = roomId || '未设置';
  if (domRoomInput) domRoomInput.value = roomId || '';

  if (roomId && roomId.length === 6) {
    if (domRoomModal) domRoomModal.classList.add('room-modal--hidden');
    initWebSocket();
    startMainWatchdog();
  } else {
    // 未带 URL 房间码且无本地缓存：展示向导面板引导用户输入，绝不盲连公共房间防串台
    openRoomModal(true);
  }
  startTimeDeviceWatchdog();

  // 支持 URL 参数直连时间房间 (?timeRoom=xxxxxx)
  var initialTimeRoomParam = urlParams.get('timeRoom') || urlParams.get('timeRoomId') || urlParams.get('time_room');
  if (initialTimeRoomParam) {
    connectTimeDevice(initialTimeRoomParam);
  }
})();

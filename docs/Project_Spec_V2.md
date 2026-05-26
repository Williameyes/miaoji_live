
📘 《高光计分 V2》全链路重构开发说明书 (Cursor 提示词基准)
零、重构核心思想与工程目标
你好！欢迎接手《高光计分》V2 版本的核心逻辑重构。
本次重构的核心目标是废除旧版蓝牙通信，全面拥抱云端 WebSocket 架构，实现采集端与多个直播端的空间解耦与低延迟同步。
在开始写代码之前，请确立一个核心认知：采集端绝不做“复读机”，要做“信号灯”。
• ❌ 错误思维（复读机）：摄像头每秒抓到 10 次 09:59，就向服务器发 10 次 09:59。这会引发广播风暴。
• ✅ 正确思维（信号灯）：只有在**“状态发生翻转”（如裁判吹哨开表、停表、进球）的瞬间，才向服务器发一次包**。其余时间坚决拦截，让直播端小程序自己去利用 WXS 倒数。
一、全局物理拓扑与通信协议
1.1 全链路拓扑
[赛场大屏] ──(摄像头OCR)──► [采集端(小程序)] 
                               │
                       (1. HTTP 获取 Token)
                       (2. WSS 长连接发包)
                               ▼
                    【腾讯云 Nginx 网关 (:443)】 ──► 负责合规证书解密
                               │
                       (内网反向代理转发)
                               ▼
                    【阿里云 Node.js 服务 (:8000)】 ──► 内存消息路由
                               │
                       (WSS 一拖多广播)
                               ▼
                    [直播端(小程序) - 观众A/B/C]

1.2 极简动态 Token 安全鉴权（防盗刷防御）
为防止未经授权的客户端直接连入 WebSocket 刷爆内存，我们采用 “一次性 Token 换取长连接” 机制。WSS 隧道本身已加密，连接建立后不再需要进行逐包 MD5 校验。
1. 获取令牌：客户端（采集端/直播端）通过 HTTP GET https://api.mx.server.ndcoo.com/api/get_token?roomId=123456 获取一次性 Token。
2. 握手连接：携带 Token 发起连接 wss://api.mx.server.ndcoo.com/gaoguang-ws?roomId=123456&token=xxxx。
3. 连接销毁：服务端验证 Token 有效后建立连接，并立即在内存中销毁该 Token（Token 寿命仅 60 秒）。
1.3 核心 JSON 数据协议
服务端只做转发，业务逻辑依靠以下 JSON 结构运转（发包与广播均遵循此结构）：
{
  "act": "START",           // 动作语义 (START开表, STOP停表, SYNC强校准, SCORE改分, S_RESET重置24秒, PERIOD换节)
  "t": 599,                 // 大表当前剩余秒数 (整数)
  "a": 89,                  // 主队分
  "b": 85,                  // 客队分
  "p": 1,                   // 节次
  "seq": 1001,              // 全局自增序列号，防弱网乱序 (极重要)
  "sys_t": 1715943242000,   // 发包瞬间的 Date.now()，用于跨网延迟补偿 (极重要)
  "match_id": "M_123456"
}

二、服务端 (Node.js) 开发实施规范
核心定位：极简无状态的内存消息路由器。只校验 Token，维护房间 Map，处理广播，不做任何数据持久化。
2.1 基础环境与 Nginx 配置
• 部署要求：使用 PM2 守护进程，防止异常崩溃。
• Nginx 分流配置（在腾讯云现有的 HTTPS server 块中追加）：
location /api/get_token {
    proxy_pass http://47.93.24.233:8000;
    proxy_set_header Host $host;
}
location /gaoguang-ws {
    proxy_pass http://47.93.24.233:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
}

2.2 服务端逻辑骨架 (server.js)
• HTTP 服务：监听 /api/get_token，生成 UUID（Token），存入 tokenMap 并设置 60 秒过期。
• WebSocket 服务：在 upgrade 阶段提取 URL 中的 roomId 和 token，验证合法性。
• 房间模型：内存维护 roomMap。每个 Room 包含： • collector：采集端 WS 实例（独占锁，后来的采集端将被拒绝并返回 COLLECTOR_EXIST）。 • broadcasts：Set 集合，存放最多 50 个直播端 WS 实例。 • lastSnapshot：保存最新一次的比赛状态数据包。
• 消息路由规则： • 收到采集端包：更新 lastSnapshot，遍历 broadcasts Set 下发广播。 • 直播端连入：连接成功后，立即向其单播一次 lastSnapshot。
• 断线兜底与清理（极重要）： • 必须监听 ws.on('close')。如果是直播端断开，从 Set 中 delete(ws) 防止内存泄漏。 • 如果是采集端断开，进入 **10 分钟宽限期**（保留 lastSnapshot，直播端可连入等待）；宽限结束再下发 DEVICE_OFFLINE 并 roomMap.delete(roomId)。 • 防爆指令：任何收到的 JSON，必须包在 try...catch 中解析！
三、采集端 (小程序) 开发实施规范
核心定位：赛场视觉保安。你需要把原有基于蓝牙底层的代码彻底替换为 WebSocket，同时坚守 5 大异常防抖机制。
3.1 网络连接与指数退避重连
• 去除所有 BLE（蓝牙外设）代码。
• 连接流程：请求 /api/get_token -> 拿到 token -> wx.connectSocket。
• 断线重连算法：监听 onClose，使用指数退避算法防风暴（第 1 次断开 3 秒重连，第 2 次 6 秒，第 3 次 12 秒，上限 15 秒）。
3.2 核心控制阀与防抖逻辑 (直接用于 processOcrFrame)
请在你的代码中实现以下 5 道防抖屏蔽门：
1. 假停表防御（1秒错觉）：连续读到相同秒数不算停表。必须记录第一次看到该秒数的时间，当 Date.now() - firstSeenTs > 1200ms 且仍在同一秒，才发 STOP。
2. 遮挡与闪电调表防御（SYNC）：数字落差超过 2 秒，立刻放入“观察室”。连续 5 帧雷打不动，才确信是真的调表并下发 SYNC。遇 null 保持静默。
3. 频闪吃数防御（高位失踪）：新比分如果像是老比分被吃掉首位（如 118 变 18），确信门限从默认的 3 帧拉高到 6 帧。
4. 影子跟随原则（24秒逻辑）：采集端绝不能发送 24秒表 的 START/STOP，只发 S_RESET。
5. 废除“只增不减”断言：篮球比分和时间完全有可能倒退（裁判回看），只要视觉稳定 N 帧，就老实发包，不要用常识拦截。
发包规范：确认有有效 act 产生时，必须更新 sys_t = Date.now() 和 seq = ++globalSeq，然后通过 _socketTask.send 推送。
四、直播端 (小程序) 开发实施规范
核心定位：智能沙盘渲染。接管大表倒计时，消化网络延迟。
4.1 网络接入与异常处理
• 连接流程同采集端：取 Token -> 连 WSS。
• 监听事件： • 收到 DEVICE_OFFLINE：断开 Socket，清空 UI，弹窗提示“采集端已离线”。 • 收到 COLLECTOR_EXIST 或 ROOM_FULL 等错误：弹窗提示并断开。
4.2 乱序盾牌与网络延迟补偿 (核心逻辑)
在收到云端广播包时，务必严格执行以下校验和运算：
// 1. 乱序防御盾牌 (丢弃迟到的旧包)
if (payload.seq <= currentSeq) return;
currentSeq = payload.seq;

// 2. 绝对网络延迟计算
const netLagMs = Date.now() - payload.sys_t; // 计算数据在天上飞了多久
const rawSeconds = payload.t; // 采集端传来的秒数

let targetSeconds = rawSeconds;
// 3. 延迟补偿：如果大表是跑动状态，把飞行的损耗时间扣掉
if (payload.act === 'START') {
    targetSeconds = Math.max(0, rawSeconds - (netLagMs / 1000));
}

// 4. 将 targetSeconds 喂给视图层 WXS 进行倒数渲染

4.3 渲染剥离：WXS 24秒逻辑闭环
• 停止在逻辑层（JS）使用 setInterval，全部交给 WXS 的 requestAnimationFrame 驱动。
• 24秒走停判断逻辑： • 直播端收到 act === 'S_RESET' 时，将 24秒 恢复到 24 (或 14)。 • WXS 如何知道 24 秒表要不要往下走？看全局大表状态。如果最后收到的主控事件是 START，24秒跟大表一起扣减；如果是 STOP，24秒定住不动。这就是“影子跟随”。
五、自检与联调验收清单
请研发同学在提交代码前，必须通过以下 3 项物理测试：
1. [ ] 阀门气密性测试：拿手机对着倒计时视频采集，观察云端控制台。大表顺畅倒数时，云端不能发生连续高频的包轰炸（应只在开表、停表瞬间收到一条指令）。
2. [ ] 遮挡防抽搐测试：用手捂住采集端摄像头 3 秒再移开。直播端的倒计时不能出现断崖式跳变回滚，必须平滑顺延。
3. [ ] 飞行模式极端测试：直播端连接状态下，强制将采集端切为飞行模式 2 秒后恢复。直播端的 seq 防御网应成功拦截过期的积压包，且 sys_t 补偿算法应瞬间将大表拨至正确时间，无视觉倒流。
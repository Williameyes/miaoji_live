# OBS 网页记分牌与时间切图同步部署与运维指南

本目录包含高光记分 OBS 网页端记分牌（Web Overlay）的核心源码与自动化脚本。

---

## 🚀 1. 云端生产服务器部署指令 (SCP)

在项目根目录下，直接使用以下 `scp` 命令将最新前端代码推送到云端生产服务器（无需任何部署脚本）：

```bash
# 推荐：一键上传所有网页记分牌资源（在项目根目录运行）：
scp obs-overlay/index.html obs-overlay/overlay.js obs-overlay/style.css obs-overlay/config.js ubuntu@49.235.145.123:/var/www/gaoguang-obs-overlay/
```

若仅更新逻辑脚本（例如本次高光修复）：
```bash
scp obs-overlay/overlay.js ubuntu@49.235.145.123:/var/www/gaoguang-obs-overlay/
```

> **线上访问地址**：
> `https://api.mx.server.ndcoo.com/obs-overlay/index.html?roomId=666888`

---

## 🛠️ 2. 系统核心架构与联动机制

### 角色分工
1. **📸 时间采集端手机**（`packageLab/pages/sync-lab/collector/`）：
   - 开机即用，生成/复用独立 6 位房间码（例如 `123456`）；
   - 对准赛场倒计时大表，每秒向云端发送一帧无损切图 Base64 流（1 FPS）。
2. **📱 小程序网页记分控制端**（`packageLive/pages/web-score-panel/`）：
   - 纯粹的**中控遥控器**，连接主播房间（`666888`）；
   - 主播在卡片中输入采集端的房间码（`123456`），点击【连接时间设备并下发给网页端】；
   - 仅下发 `{ act: 'CONNECT_TIME_ROOM', timeRoomId: '123456' }` 控制信令，**小程序本身不拉流、不连时间房间**，零网络负载。
3. **🖥️ OBS 网页记分牌**（`obs-overlay/overlay.js`）：
   - 常驻连接主播房间 `666888`，渲染常规比分、队名、节次；
   - 收到中控台的 `CONNECT_TIME_ROOM` 后，**由 OBS 里的网页端动态发起长连接连入 `123456` 房间**；
   - 实时接收大表切图帧，平滑展开右侧黑晶时间容器并绘制；
   - 收到 `DISCONNECT_TIME_ROOM` 时，立即断开 `123456` 并撤下时间容器；
   - **🎬 零配置高光回放**：后台静默建立 OBS 原生 WebSocket (`ws://localhost:4455`)，自动监听 `ReplayBufferSaved` 事件捕获本地保存的高光 MP4 路径；收到中控台 `START_HIGHLIGHT_REPLAY` 信令后，触发专业 Wipe 擦除转场动画并从最新切片开始播放高光，收到 `STOP_HIGHLIGHT_REPLAY` 时切回直播。

---

## ⚙️ 3. OBS 浏览器源常用 URL 参数

| 参数名 | 默认值 | 示例 / 可选值 | 说明 |
| :--- | :--- | :--- | :--- |
| `roomId` | `666888` | `roomId=666888` | 主播记分控制中控台房间号 |
| `pos` | `bottom` | `pos=top` / `pos=bottom` | 记分牌在画面中的垂直位置（置顶或置底） |
| `bottom` | 自适应 | `bottom=50` | 置底时的下边距像素值 |
| `scale` | `1.0` | `scale=1.15` | 记分牌整体等比缩放倍率 |
| `live` | `true` | `live=0` / `noIsland=1` | 是否隐藏左侧纵向「LIVE 现场直播」灵动岛遮罩 |
| `liveText`| `现场直播` | `liveText=高清直播` | 自定义左侧遮罩纵向文案 |
| `liveScale`| `1.0` | `liveScale=1.2` | 左侧遮罩等比缩放倍率（也可在网页上直接滚轮缩放） |
| `mode` | `normal` | `mode=live_only` | 独立角标模式（仅显示左侧 LIVE 遮罩） |
| `timeRoom`| 无 | `timeRoom=123456` | 页面加载时初始直连的时间采集端房间码（可选） |
| `obsWsPort`| `4455` | `obsWsPort=4455` | OBS 原生 WebSocket 端口（默认 4455） |
| `highlightFile`| 无 | `highlightFile=file:///C:/...` | 初始调试直接塞入的高光视频文件路径（可选） |

---

## 🔍 4. 调试与排错指南

1. **修改代码后 OBS 没变化？**
   - 运行上述 `scp` 上传命令；
   - 在 OBS 中双击浏览器源，点击底部的 **「刷新当前页面缓存」** (Refresh cache of current page)。
2. **在 Chrome 浏览器中先本地/远程验证：**
   - 直接用电脑浏览器打开：`https://api.mx.server.ndcoo.com/obs-overlay/index.html?roomId=666888`；
   - 按 `F12` 打开控制台（Console），可实时观察：
     - `[OBS Overlay] WebSocket Connected to room 666888`
     - `[OBS Overlay] Received CONNECT_TIME_ROOM -> connecting time device: 123456`
     - `[OBS Overlay] Received START_HIGHLIGHT_REPLAY -> starting replay`
     - `[OBS Overlay] Connected to OBS Native WebSocket at ws://localhost:4455`


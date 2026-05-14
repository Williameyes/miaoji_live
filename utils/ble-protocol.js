/**
 * @fileoverview BLE 蓝牙协议工具：7-Byte 数据包的编码/解码与校验。
 *
 * ┌────────────────────────────────────────────────────────────┐
 * │          7-Byte Packet Layout (ArrayBuffer)                │
 * ├─────┬──────────┬──────────┬────────┬──────┬──────┬──────────┬────────┤
 * │ idx │  Byte 0  │  Byte 1  │ Byte 2 │ B 3  │ B 4  │  B 5     │ B 6    │
 * ├─────┼──────────┼──────────┼────────┼──────┼──────┼──────────┼────────┤
 * │ 含义 │ 主队分   │ 客队分   │ 节次   │ 分钟 │ 秒   │ 24s/OCR  │ CRC-8  │
 * │ 范围 │ 0–255   │ 0–255   │ 1–8    │ 0–59 │ 0–59 │ 低5位24s │ CRC-8  │
 * └─────┴──────────┴──────────┴────────┴──────┴──────┴──────────┴────────┘
 *
 * 校验位 (Byte 6) — v2：CRC-8/SMBUS
 *   多项式：0x07（x^8 + x^2 + x + 1），初始值 0x00，无反射。
 *   相比原版 XOR：
 *     · 可检测所有单字节差错（100%）
 *     · 可检测所有突发长度 ≤ 8 的突发错误
 *     · 可检测约 99.6% 的随机多字节差错
 *   PACKET_LENGTH 与 UUID 常量保持不变，双端同步更新即可。
 *
 * 节次编码 (Byte 2)：
 *   1 = 第一节  2 = 第二节  3 = 第三节  4 = 第四节
 *   5 = 上半场  6 = 下半场  7 = 加时1   8 = 加时2
 *
 * Byte 5 状态位：
 *   - bit 0-4: 24 秒（0-24）
 *   - bit 6: OCR 正在切换
 *   - bit 7: OCR 已启动
 *
 * UUID 常量命名规则：
 *   - SERVICE_UUID: 主 GATT Service
 *   - CHAR_SCORE_UUID: 比分数据特征值 (notify + read + write)
 *   - 使用自定义 128-bit UUID，避免与系统保留 UUID 冲突
 */

// ─── GATT UUID 常量 ─────────────────────────────────────────────────────────

/**
 * 主 GATT Service UUID（完全自定义 128-bit，不以 0000 开头）。
 * 避开 Bluetooth SIG 成员服务 UUID 段（FExx），Android 会拒绝 Peripheral 注册。
 * @type {string}
 */
var SERVICE_UUID = 'ba5e1ab1-c0de-ca11-ab1e-b1ead5ea1010';

/**
 * 比分数据 Characteristic UUID（完全自定义）。
 * 属性：notify + read + write。
 * @type {string}
 */
var CHAR_SCORE_UUID = 'ba5e1ab2-c0de-ca11-ab1e-b1ead5ea1011';

/**
 * CCCD UUID（仅供参考，Android 自动管理，无需在 addService 中手动传入）。
 * @type {string}
 */
var CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';

/** 数据包固定长度（字节数）。 */
var PACKET_LENGTH = 7;

/** 广播名前缀，Peripheral 使用 "SG_" + 4位随机码。 */
var DEVICE_NAME_PREFIX = 'SG_';

// ─── CRC-8/SMBUS 查找表 ──────────────────────────────────────────────────────

/**
 * 预计算 CRC-8/SMBUS（多项式 0x07）查找表，256 项。
 * 在小程序模块初始化时一次性生成，之后 O(1) 查表，无运行时乘法。
 * @type {Uint8Array}
 */
var _CRC8_TABLE = (function buildCrc8Table() {
  var table = new Uint8Array(256);
  for (var i = 0; i < 256; i++) {
    var crc = i;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
    }
    table[i] = crc;
  }
  return table;
}());

/**
 * 计算 Uint8Array [start, end) 区间的 CRC-8/SMBUS 校验值。
 * @param {Uint8Array} view
 * @param {number} start  起始索引（含）
 * @param {number} end    结束索引（不含）
 * @returns {number} 0-255
 */
function computeCrc8(view, start, end) {
  var crc = 0x00;
  for (var i = start; i < end; i++) {
    crc = _CRC8_TABLE[crc ^ view[i]];
  }
  return crc;
}

// ─── 编码 ────────────────────────────────────────────────────────────────────

/**
 * 将比赛状态编码为 7 字节 ArrayBuffer（含 CRC-8/SMBUS 校验位）。
 *
 * @param {object} state - 当前比赛状态
 * @param {number} state.homeScore   - 主队得分 (0–255)
 * @param {number} state.awayScore   - 客队得分 (0–255)
 * @param {number} state.period      - 节次 (1–8)
 * @param {number} state.minutes     - 当前节剩余/已过分钟 (0–59)
 * @param {number} state.seconds     - 当前节剩余/已过秒 (0–59)
 * @param {number} state.shotClock   - 进攻24秒 (0–24)
 * @param {boolean} [state.ocrEnabled] - 采集端 OCR 是否已启动
 * @param {boolean} [state.ocrTransitioning] - 采集端 OCR 是否正在切换
 * @returns {ArrayBuffer} 7字节数据包
 */
function encodePacket(state) {
  var buf = new ArrayBuffer(PACKET_LENGTH);
  var view = new Uint8Array(buf);
  view[0] = clampByte(state.homeScore);
  view[1] = clampByte(state.awayScore);
  view[2] = clampByte(state.period, 1, 8);
  view[3] = clampByte(state.minutes, 0, 59);
  view[4] = clampByte(state.seconds, 0, 59);
  view[5] = clampByte(state.shotClock, 0, 24) & 0x1F;
  if (state.ocrTransitioning) view[5] |= 0x40;
  if (state.ocrEnabled) view[5] |= 0x80;
  view[6] = computeCrc8(view, 0, 6); // CRC-8/SMBUS over Bytes 0-5
  return buf;
}

// ─── 解码 ────────────────────────────────────────────────────────────────────

/**
 * 解码 7 字节 ArrayBuffer，CRC-8 校验通过后返回比赛状态对象。
 * 校验失败或长度不符则返回 null，调用方应直接丢弃该帧。
 *
 * @param {ArrayBuffer} buf - 接收到的原始字节
 * @returns {{ homeScore:number, awayScore:number, period:number, minutes:number, seconds:number, shotClock:number, ocrEnabled:boolean, ocrTransitioning:boolean } | null}
 */
function decodePacket(buf) {
  if (!buf || buf.byteLength !== PACKET_LENGTH) {
    return null;
  }
  var view = new Uint8Array(buf);
  var expectedCrc = computeCrc8(view, 0, 6);
  if (view[6] !== expectedCrc) {
    // CRC-8 校验失败，丢弃该帧
    return null;
  }
  return {
    homeScore: view[0],
    awayScore: view[1],
    period:    view[2],
    minutes:   view[3],
    seconds:   view[4],
    shotClock: view[5] & 0x1F,
    ocrTransitioning: !!(view[5] & 0x40),
    ocrEnabled: !!(view[5] & 0x80)
  };
}

// ─── 纠错逻辑 ────────────────────────────────────────────────────────────────

/**
 * 联调阶段不过滤业务跳变，解码成功就直接接受。
 * 这样记分牌回表、断电重设比分、24 秒手动回拨都不会被本地规则挡住。
 *
 * @param {{ homeScore:number, awayScore:number, period:number, shotClock:number }} prev
 * @param {{ homeScore:number, awayScore:number, period:number, shotClock:number }} next
 * @returns {boolean}
 */
function isLogicallyValid(prev, next) {
  return !!next;
}

/**
 * 连续帧一致性判断：两帧内容完全相同则认为 OCR 稳定，可触发蓝牙发送。
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function framesEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.homeScore === b.homeScore &&
    a.awayScore === b.awayScore &&
    a.period    === b.period    &&
    a.minutes   === b.minutes   &&
    a.seconds   === b.seconds   &&
    a.shotClock === b.shotClock
  );
}

// ─── 随机码生成 ───────────────────────────────────────────────────────────────

/**
 * 生成 4 位纯数字随机匹配码，用于广播名 "SG_XXXX"。
 * 不做持久化，每次 Peripheral 启动时重新生成。
 *
 * @returns {string} 4位数字字符串，不足 4 位前补零
 */
function generateMatchCode() {
  var n = Math.floor(Math.random() * 10000);
  return String(n).padStart ? String(n).padStart(4, '0') : zeroPad(n, 4);
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 将数值夹紧到 [min, max] 范围内并取整。
 * @param {number} v
 * @param {number} [lo=0]
 * @param {number} [hi=255]
 * @returns {number}
 */
function clampByte(v, lo, hi) {
  lo = (lo === undefined) ? 0 : lo;
  hi = (hi === undefined) ? 255 : hi;
  var n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 数字补零（低版本 JS 兼容 padStart 缺失）。
 * @param {number} n
 * @param {number} len
 * @returns {string}
 */
function zeroPad(n, len) {
  var s = String(n);
  while (s.length < len) s = '0' + s;
  return s;
}

// ─── 导出 ─────────────────────────────────────────────────────────────────────

module.exports = {
  // UUID 常量
  SERVICE_UUID:       SERVICE_UUID,
  CHAR_SCORE_UUID:    CHAR_SCORE_UUID,
  CCCD_UUID:          CCCD_UUID,
  DEVICE_NAME_PREFIX: DEVICE_NAME_PREFIX,
  PACKET_LENGTH:      PACKET_LENGTH,

  // 核心编解码（Byte 6 已升级为 CRC-8/SMBUS）
  encodePacket:      encodePacket,
  decodePacket:      decodePacket,

  // 纠错
  isLogicallyValid:  isLogicallyValid,
  framesEqual:       framesEqual,

  // 工具
  generateMatchCode: generateMatchCode,
  clampByte:         clampByte,

  // 校验算法（供单元测试直接调用）
  computeCrc8:       computeCrc8
};

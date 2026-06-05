/**
 * @fileoverview Live 页内「扫描 SG_xxxx + 连接采集端」流程。
 */

const BLE = require('./ble-protocol.js');
const bleManager = require('../services/bleManager.js');

/** 扫描超时（ms） */
const DEFAULT_SCAN_TIMEOUT_MS = 20000;

/** 最近一次在 Live 页输入的 4 位匹配码（仅本地 Storage） */
const STORAGE_LAST_MATCH_CODE = 'LIVE_BLE_LAST_MATCH_CODE_V1';

/**
 * 启动 BLE 扫描，发现与 `deviceName` 完全一致的广播名后断开旧连接并 `bleManager.connect`。
 *
 * @param {object} opts
 * @param {string} opts.deviceName 完整外围名，如 `SG_1234`
 * @param {number} [opts.timeoutMs] 扫描超时，默认 20000
 * @param {(phase: 'scanning'|'connecting'|'connected'|'not_found'|'error'|'cancelled', detail?: string) => void} [opts.onPhase] 阶段回调
 * @returns {{ cancel: () => void, finished: Promise<void> }} `finished` 成功 resolve，失败 reject
 */
function startLiveBleQuickScan(opts) {
  var deviceName = String(opts.deviceName || '');
  var timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SCAN_TIMEOUT_MS;
  var onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : function () {};

  var cancelled = false;
  var scanTimer = null;
  var settled = false;
  /** @type {((v?: void) => void) | null} */
  var settleResolve = null;
  /** @type {((e: Error) => void) | null} */
  var settleReject = null;

  /**
   * @param {void} [value]
   * @returns {void}
   */
  function settleOk(value) {
    if (settled) return;
    settled = true;
    if (settleResolve) settleResolve(value);
  }

  /**
   * @param {Error} err
   * @returns {void}
   */
  function settleErr(err) {
    if (settled) return;
    settled = true;
    if (settleReject) settleReject(err);
  }

  function cleanupDiscovery() {
    try {
      if (scanTimer) clearTimeout(scanTimer);
    } catch (e0) {}
    scanTimer = null;
    try {
      wx.stopBluetoothDevicesDiscovery();
    } catch (e1) {}
    try {
      wx.offBluetoothDeviceFound(onFound);
    } catch (e2) {}
  }

  function onFound(res) {
    if (cancelled) return;
    var devices = res.devices || [];
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      var name = d.name || d.localName || '';
      if (name === deviceName) {
        cleanupDiscovery();
        if (cancelled) {
          onPhase('cancelled', '');
          settleErr(new Error('cancelled'));
          return;
        }
        onPhase('connecting', d.deviceId || '');
        Promise.resolve(bleManager.disconnect())
          .then(function () {
            return bleManager.connect(d.deviceId, BLE.SERVICE_UUID, BLE.CHAR_SCORE_UUID);
          })
          .then(function () {
            onPhase('connected', '');
            settleOk();
          })
          .catch(function (err) {
            var msg =
              err && err.errMsg ? String(err.errMsg) : String(err && err.message ? err.message : err);
            onPhase('error', msg || 'connect_failed');
            settleErr(err instanceof Error ? err : new Error(msg || 'connect_failed'));
          });
        return;
      }
    }
  }

  var finished = new Promise(function (resolve, reject) {
    settleResolve = resolve;
    settleReject = reject;

    wx.openBluetoothAdapter({
      mode: 'central',
      success: function () {
        if (cancelled) {
          onPhase('cancelled', '');
          settleErr(new Error('cancelled'));
          return;
        }
        onPhase('scanning', '');
        wx.onBluetoothDeviceFound(onFound);
        scanTimer = setTimeout(function () {
          if (cancelled) return;
          cleanupDiscovery();
          onPhase('not_found', '');
          settleErr(new Error('not_found'));
        }, timeoutMs);
        try {
          wx.startBluetoothDevicesDiscovery({
            services: [BLE.SERVICE_UUID],
            allowDuplicatesKey: false
          });
        } catch (eDisc) {
          cleanupDiscovery();
          var es = String((eDisc && eDisc.message) || eDisc || 'discovery_start_failed');
          onPhase('error', es);
          settleErr(eDisc instanceof Error ? eDisc : new Error(es));
        }
      },
      fail: function (err) {
        var msg = err && err.errMsg ? String(err.errMsg) : 'adapter_open_failed';
        onPhase('error', msg);
        settleErr(err instanceof Error ? err : new Error(msg));
      }
    });
  });

  return {
    /**
     * 中止扫描；若已进入 `connect` 则不打断底层连接尝试。
     * @returns {void}
     */
    cancel: function () {
      if (cancelled) return;
      cancelled = true;
      try {
        if (scanTimer) clearTimeout(scanTimer);
      } catch (eT) {}
      scanTimer = null;
      try {
        wx.stopBluetoothDevicesDiscovery();
      } catch (eS) {}
      try {
        wx.offBluetoothDeviceFound(onFound);
      } catch (eO) {}
      onPhase('cancelled', '');
      settleErr(new Error('cancelled'));
    },
    finished: finished
  };
}

module.exports = {
  startLiveBleQuickScan: startLiveBleQuickScan,
  STORAGE_LAST_MATCH_CODE: STORAGE_LAST_MATCH_CODE,
  DEFAULT_SCAN_TIMEOUT_MS: DEFAULT_SCAN_TIMEOUT_MS
};

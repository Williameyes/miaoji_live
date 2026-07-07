/**
 * @fileoverview 投篮训练 YOLO 模型配置（avishah3 best.pt → ONNX）。
 *
 * v3：imgsz=640，与 Python shot_detector.py 默认 YOLO 推理一致（v2 的 320 检出率约低 8 倍）。
 * 本地文件：packageRec/models/basketball-avishah-v3.onnx（约 12MB，勿打入代码包）。
 */

var API = require('../../config/api.js');

/** 模型版本号（变更后触发重新下载） */
var MODEL_VERSION = 'v3';

/** ONNX 文件名 */
var MODEL_FILE_NAME = 'basketball-avishah-v3.onnx';

/** 推理输入边长（须与 ONNX 导出 imgsz 一致，Python 默认 640） */
var INPUT_SIZE = 640;

/** 篮球类别 ID（0=Basketball） */
var BALL_CLASS_IDS = [0];

/** 篮筐类别 ID（1=Basketball Hoop） */
var HOOP_CLASS_IDS = [1];

/** 类别数（篮球 + 篮筐） */
var NUM_CLASSES = 2;

/** 篮球置信度（对齐 shot_detector.py conf>0.3） */
var CONF_THRESHOLD = 0.3;

/** 篮筐附近时降低篮球阈值（shot_detector.py 0.15） */
var CONF_THRESHOLD_NEAR_HOOP = 0.08;

/** 弱检出 UI / 轨迹阈值 */
var CONF_THRESHOLD_PEEK = 0.06;

/** 篮筐置信度（对齐 shot_detector.py conf>0.5） */
var HOOP_CONF_THRESHOLD = 0.5;

/** NMS IoU 阈值 */
var IOU_THRESHOLD = 0.45;

/** ONNX 输入/输出张量名 */
var INPUT_TENSOR = 'images';
var OUTPUT_TENSOR = 'output0';

/** 推理精度：2=平衡（iOS 上 4 易异常）；4=最高精度 */
var PRECISION_LEVEL = 2;

/**
 * 是否启用 NPU（iOS 上关闭，避免异常快速空推理）。
 * @returns {boolean}
 */
function getAllowNpu() {
  return false;
}

/**
 * 模型下载地址（按需下载）。
 * @type {string}
 */
var MODEL_DOWNLOAD_URL = API.API_BASE_URL + '/static/ml/' + MODEL_FILE_NAME;

module.exports = {
  MODEL_VERSION: MODEL_VERSION,
  MODEL_FILE_NAME: MODEL_FILE_NAME,
  INPUT_SIZE: INPUT_SIZE,
  BALL_CLASS_IDS: BALL_CLASS_IDS,
  HOOP_CLASS_IDS: HOOP_CLASS_IDS,
  NUM_CLASSES: NUM_CLASSES,
  CONF_THRESHOLD: CONF_THRESHOLD,
  CONF_THRESHOLD_NEAR_HOOP: CONF_THRESHOLD_NEAR_HOOP,
  CONF_THRESHOLD_PEEK: CONF_THRESHOLD_PEEK,
  HOOP_CONF_THRESHOLD: HOOP_CONF_THRESHOLD,
  IOU_THRESHOLD: IOU_THRESHOLD,
  INPUT_TENSOR: INPUT_TENSOR,
  OUTPUT_TENSOR: OUTPUT_TENSOR,
  PRECISION_LEVEL: PRECISION_LEVEL,
  MODEL_DOWNLOAD_URL: MODEL_DOWNLOAD_URL,
  getAllowNpu: getAllowNpu
};

/**
 * @fileoverview 后端 API 根地址配置（须与微信公众平台「request 合法域名」一致）。
 */

/** @type {string} 末尾不要带 / */
const API_BASE_URL = 'https://api.mx.server.ndcoo.com';

/**
 * 头像上传（multipart）。若服务端未实现该路由会 404，此时前端应关闭换头像能力。
 * 后端就绪后把路径改为实际地址并恢复上传流程。
 */
const API_PATH_UPLOAD = '/api/upload';

/**
 * 客户端直播诊断日志（JSON 上报）。服务端实现后可落库分析 segment_start_fail 等现场。
 */
const API_PATH_CLIENT_DIAGNOSTIC_LOG = '/api/client/diagnostic-log';

/**
 * 更新当前用户昵称/头像（PUT /api/user/update，需 Bearer）。
 */
const API_PATH_USER_UPDATE = '/api/user/update';

module.exports = {
  API_BASE_URL,
  API_PATH_UPLOAD,
  API_PATH_CLIENT_DIAGNOSTIC_LOG,
  API_PATH_USER_UPDATE
};

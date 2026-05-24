/**
 * 将微信 API / 混合错误对象序列化为可读字符串（health log 用）。
 * @param {unknown} err
 * @returns {string}
 */
function formatWxErr(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object') {
    const o = err;
    if (typeof o.errMsg === 'string' && o.errMsg) return o.errMsg;
    if (typeof o.message === 'string' && o.message) return o.message;
    try {
      return JSON.stringify(err);
    } catch (eJson) {
      return String(err);
    }
  }
  return String(err);
}

module.exports = {
  formatWxErr
};

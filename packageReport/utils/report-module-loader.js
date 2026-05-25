/**
 * @fileoverview 分包内模块加载入口；主包跨分包引用请用 require.async 指向本目录文件。
 */

/** @type {Promise<{ parseMatchExcelBuffer: Function }>|null} */
let excelParserPromise = null;

/**
 * 异步加载 Excel 解析模块（含 xlsx 依赖）。
 * @returns {Promise<{ parseMatchExcelBuffer: Function }>}
 */
function loadExcelParserAsync() {
  if (!excelParserPromise) {
    excelParserPromise = require
      .async('./radar-excel-parser.js')
      .catch(function (err) {
        excelParserPromise = null;
        return Promise.reject(err);
      });
  }
  return excelParserPromise;
}

/**
 * 异步加载记分导出模块（V2 事件流水 → xlsx）。
 * @returns {Promise<{ exportScoreEventsToXlsx: Function }>}
 */
function loadScoreExporterAsync() {
  return require.async('./score-excel-export.js');
}

module.exports = {
  loadExcelParserAsync,
  loadScoreExporterAsync
};

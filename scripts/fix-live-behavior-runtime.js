/**
 * 修复 Behavior 拆分后的运行时问题：
 * 1. 页面生命周期须挂在 Behavior 根级，不能放在 methods 内
 * 2. 实例状态字段须挂在 Page 根级，不能放在 Behavior 根级
 */
const fs = require('fs');
const path = require('path');

const LIVE_DIR = path.join(__dirname, '../pages/live');
const LIFECYCLE_FILE = path.join(LIVE_DIR, 'behaviors/live-lifecycle-behavior.js');
const STATE_FILE = path.join(LIVE_DIR, 'behaviors/live-state-behavior.js');
const LIVE_FILE = path.join(LIVE_DIR, 'live.js');

/** @type {string[]} */
const PAGE_LIFECYCLES = ['onLoad', 'onShow', 'onHide', 'onUnload', 'onReady'];

/**
 * @param {string} methodsBody
 * @returns {Map<string, string>}
 */
function parseMethodsBody(methodsBody) {
  const result = new Map();
  let pos = 0;
  while (pos < methodsBody.length) {
    while (pos < methodsBody.length && /\s/.test(methodsBody[pos])) pos++;
    if (pos >= methodsBody.length) break;
    const km = methodsBody.slice(pos).match(/^([a-zA-Z_@][a-zA-Z0-9_]*)\s*:\s*function\s*\(/);
    if (!km) break;
    const name = km[1];
    const keyStart = pos;
    pos += km[0].length;
    let depth = 1;
    let inStr = false;
    let strCh = '';
    for (; pos < methodsBody.length; pos++) {
      const ch = methodsBody[pos];
      if (inStr) {
        if (ch === '\\') { pos++; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          pos++;
          break;
        }
      }
    }
    while (pos < methodsBody.length && /\s/.test(methodsBody[pos])) pos++;
    if (methodsBody[pos] === ',') pos++;
    result.set(name, methodsBody.slice(keyStart, pos).trim().replace(/,\s*$/, ''));
  }
  return result;
}

function fixLifecycleBehavior() {
  const src = fs.readFileSync(LIFECYCLE_FILE, 'utf8');
  const preambleEnd = src.indexOf('module.exports = Behavior({');
  const preamble = src.slice(0, preambleEnd);
  const methodsMarker = '  methods: {';
  const methodsStart = src.indexOf(methodsMarker);
  if (methodsStart < 0) throw new Error('methods block not found');
  const bodyStart = methodsStart + methodsMarker.length;
  const bodyEnd = src.lastIndexOf('\n  }\n});');
  if (bodyEnd < 0) throw new Error('methods block end not found');
  const methodsBody = src.slice(bodyStart, bodyEnd);
  const map = parseMethodsBody(methodsBody);

  const lifecycleParts = [];
  const methodParts = [];
  PAGE_LIFECYCLES.forEach((key) => {
    if (!map.has(key)) throw new Error('Missing lifecycle: ' + key);
    lifecycleParts.push('  ' + map.get(key));
    map.delete(key);
  });
  map.forEach((body) => methodParts.push('    ' + body));

  const fixed = `${preamble}module.exports = Behavior({
${lifecycleParts.join(',\n')},
  methods: {
${methodParts.join(',\n')}
  }
});
`;
  fs.writeFileSync(LIFECYCLE_FILE, fixed);
  console.log('Fixed live-lifecycle-behavior.js:', lifecycleParts.length, 'lifecycles,', methodParts.length, 'methods');
}

function fixPageInstanceState() {
  const stateSrc = fs.readFileSync(STATE_FILE, 'utf8');
  const start = stateSrc.indexOf('module.exports = Behavior({');
  const end = stateSrc.lastIndexOf('});');
  const inner = stateSrc.slice(stateSrc.indexOf('{', start) + 1, end).trim();
  const indented = inner.split('\n').map((line) => (line ? '  ' + line : line)).join('\n');
  const liveSrc = fs.readFileSync(LIVE_FILE, 'utf8');
  const withoutStateBehavior = liveSrc
    .replace(/const livestateBehavior = require\('\.\/behaviors\/live-state-behavior\.js'\);\n/, '')
    .replace(/livestateBehavior, /, '')
    .replace(/ \*   live-state-behavior.*\n/, '');
  const pageEnd = withoutStateBehavior.lastIndexOf('\n});');
  const fixedLive = withoutStateBehavior.slice(0, pageEnd)
    + ',\n  // 实例状态（须在 Page 根级；Behavior 根级字段不会合并到 this）\n'
    + indented
    + '\n});\n';
  fs.writeFileSync(LIVE_FILE, fixedLive);
  fs.unlinkSync(STATE_FILE);
  console.log('Moved instance state into live.js; removed live-state-behavior.js');
}

fixLifecycleBehavior();
fixPageInstanceState();

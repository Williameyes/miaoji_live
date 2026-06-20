/**
 * 将编码参数一致的本地 mp4 无重编码拼接为单文件（保持原画质）。
 * 合并策略：拼接 mdat + 单 chunk stco/stsc + 扁平 stts，兼容 MediaContainer 导出差异。
 */

/** @type {string[]} */
const CONTAINER_BOX_TYPES = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf'];

/**
 * 读取大端 uint32。
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function readUint32BE(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

/**
 * 写入大端 uint32。
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {number} value
 * @returns {void}
 */
function writeUint32BE(buf, offset, value) {
  const v = value >>> 0;
  buf[offset] = (v >>> 24) & 0xff;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

/**
 * 读取 box 类型四字符。
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {string}
 */
function readBoxType(buf, offset) {
  return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
}

/**
 * 解析 box 头。
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {number} end
 * @returns {{ type: string, size: number, headerSize: number, dataStart: number, boxEnd: number }|null}
 */
function readBoxHeader(buf, offset, end) {
  if (offset + 8 > end) return null;
  let size = readUint32BE(buf, offset);
  const type = readBoxType(buf, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    const hi = readUint32BE(buf, offset + 8);
    const lo = readUint32BE(buf, offset + 12);
    size = hi * 0x100000000 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) return null;
  return {
    type,
    size,
    headerSize,
    dataStart: offset + headerSize,
    boxEnd: offset + size
  };
}

/**
 * 递归查找 box。
 * @param {Uint8Array} buf
 * @param {string} type
 * @param {number} start
 * @param {number} end
 * @returns {{ offset: number, size: number, headerSize: number, dataStart: number, boxEnd: number, type: string }|null}
 */
function findBox(buf, type, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    const header = readBoxHeader(buf, offset, end);
    if (!header) break;
    if (header.type === type) {
      return { offset, ...header };
    }
    if (CONTAINER_BOX_TYPES.indexOf(header.type) >= 0) {
      const inner = findBox(buf, type, header.dataStart, header.boxEnd);
      if (inner) return inner;
    }
    offset += header.size;
  }
  return null;
}

/**
 * 在 buffer 中查找 FourCC。
 * @param {Uint8Array} buf
 * @param {string} fourCc
 * @returns {number}
 */
function findFourCc(buf, fourCc) {
  const c0 = fourCc.charCodeAt(0);
  const c1 = fourCc.charCodeAt(1);
  const c2 = fourCc.charCodeAt(2);
  const c3 = fourCc.charCodeAt(3);
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === c0 && buf[i + 1] === c1 && buf[i + 2] === c2 && buf[i + 3] === c3) {
      return i;
    }
  }
  return -1;
}

/**
 * 从 stsd 提取视频编码指纹（宽高等），用于兼容性判断。
 * @param {Uint8Array} stsdBytes
 * @returns {{ codec: string, width: number, height: number }}
 */
function parseVisualSampleFingerprint(stsdBytes) {
  const buf = stsdBytes || new Uint8Array(0);
  const codecCandidates = ['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v'];
  let codec = 'unknown';
  let idx = -1;
  codecCandidates.some((cc) => {
    const at = findFourCc(buf, cc);
    if (at >= 0) {
      codec = cc;
      idx = at;
      return true;
    }
    return false;
  });
  if (idx < 0 || idx + 28 > buf.length) {
    return { codec, width: 0, height: 0 };
  }
  const width = (buf[idx + 24] << 8) | buf[idx + 25];
  const height = (buf[idx + 26] << 8) | buf[idx + 27];
  return { codec, width, height };
}

/**
 * 将微信文件系统 fail 回调规范为带 message 的 Error（避免日志里出现 [object Object]）。
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {Error}
 */
function normalizeFsError(err, fallback) {
  if (err instanceof Error) {
    if (!err.message && err.errMsg) err.message = String(err.errMsg);
    return err;
  }
  const msg = err && typeof err === 'object' && (err.errMsg || err.message)
    ? String(err.errMsg || err.message)
    : (typeof err === 'string' && err ? err : fallback || 'fs_fail');
  const wrapped = new Error(msg);
  if (err && typeof err === 'object') {
    if (err.errMsg) wrapped.errMsg = String(err.errMsg);
    if (err.errno != null) wrapped.errno = err.errno;
  }
  return wrapped;
}

/**
 * 读取本地文件。
 * @param {string} filePath
 * @returns {Promise<Uint8Array>}
 */
function readFileBytes(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (res) => {
        const data = res && res.data;
        if (data instanceof ArrayBuffer) {
          resolve(new Uint8Array(data));
          return;
        }
        reject(new Error('read_file_fail'));
      },
      fail: (err) => reject(normalizeFsError(err, 'read_file_fail'))
    });
  });
}

/**
 * 写入本地文件。
 * @param {string} filePath
 * @param {Uint8Array} bytes
 * @returns {Promise<void>}
 */
function writeFileBytes(filePath, bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const data = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data,
      success: () => resolve(),
      fail: (err) => reject(normalizeFsError(err, 'write_file_fail'))
    });
  });
}

/**
 * 解析 stsz sample 列表。
 * @param {Uint8Array} buf
 * @param {{ dataStart: number, boxEnd: number }} box
 * @returns {number[]}
 */
function parseStsz(buf, box) {
  const base = box.dataStart;
  const sampleSize = readUint32BE(buf, base + 4);
  const sampleCount = readUint32BE(buf, base + 8);
  if (sampleSize > 0) {
    const list = [];
    for (let i = 0; i < sampleCount; i += 1) list.push(sampleSize);
    return list;
  }
  const list = [];
  let off = base + 12;
  for (let i = 0; i < sampleCount; i += 1) {
    list.push(readUint32BE(buf, off));
    off += 4;
  }
  return list;
}

/**
 * 读取大端 uint64。
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function readUint64BE(buf, offset) {
  const hi = readUint32BE(buf, offset);
  const lo = readUint32BE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

/**
 * 写入大端 uint64。
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {number} value
 * @returns {void}
 */
function writeUint64BE(buf, offset, value) {
  const v = Math.floor(Number(value) || 0);
  writeUint32BE(buf, offset, Math.floor(v / 0x100000000));
  writeUint32BE(buf, offset + 4, v >>> 0);
}

/**
 * 写入 FullBox 的 duration 字段（兼容 version 0 / 1）。
 * @param {Uint8Array} buf
 * @param {{ dataStart: number, boxEnd: number }} box
 * @param {number} durationOffsetV0 version 0 时 duration 相对 dataStart 的偏移
 * @param {number} durationOffsetV1 version 1 时 duration 相对 dataStart 的偏移
 * @param {number} duration
 * @returns {void}
 */
function writeFullBoxDuration(buf, box, durationOffsetV0, durationOffsetV1, duration) {
  const base = box.dataStart;
  const ver = buf[base];
  const dur = Math.max(1, Math.floor(duration));
  if (ver === 0) {
    writeUint32BE(buf, base + durationOffsetV0, dur);
    return;
  }
  if (ver === 1) {
    writeUint64BE(buf, base + durationOffsetV1, dur);
  }
}

/**
 * 解析 stts。
 * @param {Uint8Array} buf
 * @param {{ dataStart: number, boxEnd: number }} box
 * @returns {{ sampleCount: number, sampleDelta: number }[]}
 */
function parseStts(buf, box) {
  const base = box.dataStart;
  const count = readUint32BE(buf, base + 4);
  const list = [];
  let off = base + 8;
  for (let i = 0; i < count; i += 1) {
    list.push({
      sampleCount: readUint32BE(buf, off),
      sampleDelta: readUint32BE(buf, off + 4)
    });
    off += 8;
  }
  return list;
}

/**
 * 解析 mdhd duration。
 * @param {Uint8Array} buf
 * @param {{ dataStart: number, boxEnd: number }} box
 * @returns {{ duration: number, timescale: number }}
 */
function parseMdhd(buf, box) {
  const base = box.dataStart;
  if (buf[base] === 0) {
    return {
      version: 0,
      timescale: readUint32BE(buf, base + 12) || 1,
      duration: readUint32BE(buf, base + 16)
    };
  }
  return {
    version: 1,
    timescale: readUint32BE(buf, base + 20) || 1,
    duration: readUint64BE(buf, base + 24)
  };
}

/**
 * 提取 mp4 拼接元数据。
 * @param {Uint8Array} buf
 * @returns {object}
 */
function extractMp4Parts(buf) {
  let offset = 0;
  /** @type {Uint8Array|null} */
  let ftyp = null;
  /** @type {Uint8Array|null} */
  let moov = null;
  /** @type {Uint8Array|null} */
  let mdatPayload = null;
  let mdatDataOffset = 0;
  /** @type {string[]} */
  const topLevelTypes = [];

  while (offset + 8 <= buf.length) {
    const header = readBoxHeader(buf, offset, buf.length);
    if (!header) break;
    topLevelTypes.push(header.type);
    if (header.type === 'ftyp') ftyp = buf.slice(offset, header.boxEnd);
    if (header.type === 'moov') moov = buf.slice(offset, header.boxEnd);
    if (header.type === 'mdat') {
      mdatPayload = buf.slice(header.dataStart, header.boxEnd);
      mdatDataOffset = header.dataStart;
    }
    offset += header.size;
  }

  if (!moov || !mdatPayload) {
    const err = new Error('mp4_structure_incomplete');
    err.topLevel = topLevelTypes.join(',');
    throw err;
  }

  if (!ftyp) {
    /** 部分导出无 ftyp，补最小 isom ftyp */
    ftyp = new Uint8Array([
      0, 0, 0, 24, 102, 116, 121, 112,
      105, 115, 111, 109, 0, 0, 0, 1,
      105, 115, 111, 109, 109, 112, 52, 49
    ]);
  }

  const stsdBox = findBox(moov, 'stsd', 0, moov.length);
  const stszBox = findBox(moov, 'stsz', 0, moov.length);
  const sttsBox = findBox(moov, 'stts', 0, moov.length);
  const mdhdBox = findBox(moov, 'mdhd', 0, moov.length);
  if (!stsdBox || !stszBox || !sttsBox || !mdhdBox) {
    const err = new Error('mp4_stbl_missing');
    err.hasStsd = !!stsdBox;
    err.hasStsz = !!stszBox;
    err.hasStts = !!sttsBox;
    throw err;
  }

  const stszSamples = parseStsz(moov, stszBox);
  if (!stszSamples.length) throw new Error('mp4_no_samples');

  return {
    ftyp,
    moov,
    mdatPayload,
    mdatDataOffset,
    topLevelTypes,
    stsdBytes: moov.slice(stsdBox.offset, stsdBox.boxEnd),
    stszSamples,
    sttsEntries: parseStts(moov, sttsBox),
    mdhd: parseMdhd(moov, mdhdBox),
    fingerprint: parseVisualSampleFingerprint(moov.slice(stsdBox.offset, stsdBox.boxEnd))
  };
}

/**
 * 判断两段视频编码是否可拼接（宽/高/codec 一致即可，不要求 stsd 字节完全相同）。
 * @param {ReturnType<typeof extractMp4Parts>} a
 * @param {ReturnType<typeof extractMp4Parts>} b
 * @returns {boolean}
 */
function partsCompatible(a, b) {
  const fa = a.fingerprint || parseVisualSampleFingerprint(a.stsdBytes);
  const fb = b.fingerprint || parseVisualSampleFingerprint(b.stsdBytes);
  if (fa.codec !== 'unknown' && fb.codec !== 'unknown') {
    if (fa.codec !== fb.codec) return false;
    /** MediaContainer 导出常解析不出宽高（均为 0），此时回退 stsd 字节比对 */
    if (fa.width > 0 && fb.width > 0 && fa.height > 0 && fb.height > 0) {
      return fa.width === fb.width && fa.height === fb.height;
    }
  }
  /** 无法解析时回退 stsd 长度 + 前 64 字节 */
  if (a.stsdBytes.length !== b.stsdBytes.length) return false;
  const n = Math.min(64, a.stsdBytes.length);
  for (let i = 0; i < n; i += 1) {
    if (a.stsdBytes[i] !== b.stsdBytes[i]) return false;
  }
  return true;
}

/**
 * 合并 stts：优先结构合并，失败则扁平为单 entry。
 * @param {ReturnType<typeof extractMp4Parts>[]} partsList
 * @returns {{ sampleCount: number, sampleDelta: number }[]}
 */
function resolveMergedStts(partsList) {
  const first = partsList[0].sttsEntries || [];
  const totalSamples = partsList.reduce((s, p) => s + p.stszSamples.length, 0);
  if (!totalSamples) throw new Error('mp4_no_samples');

  let canMerge = first.length > 0;
  let delta = first[0] ? first[0].sampleDelta : 0;
  if (canMerge) {
    partsList.forEach((p) => {
      const entries = p.sttsEntries || [];
      if (entries.length !== first.length) canMerge = false;
      entries.forEach((e, i) => {
        if (!first[i] || e.sampleDelta !== first[i].sampleDelta) canMerge = false;
      });
    });
  }

  if (canMerge && first.length) {
    return first.map((e, i) => ({
      sampleDelta: e.sampleDelta,
      sampleCount: partsList.reduce((s, p) => s + (p.sttsEntries[i] ? p.sttsEntries[i].sampleCount : 0), 0)
    }));
  }

  /** 取首个有效 delta，合并为单 entry */
  partsList.some((p) => {
    if (p.sttsEntries && p.sttsEntries.length && p.sttsEntries[0].sampleDelta > 0) {
      delta = p.sttsEntries[0].sampleDelta;
      return true;
    }
    return false;
  });
  if (!delta) delta = 1024;
  return [{ sampleCount: totalSamples, sampleDelta: delta }];
}

/**
 * 构造 stts box。
 * @param {{ sampleCount: number, sampleDelta: number }[]} entries
 * @returns {Uint8Array}
 */
function buildSttsBox(entries) {
  const size = 8 + 8 + entries.length * 8;
  const buf = new Uint8Array(size);
  writeUint32BE(buf, 0, size);
  buf[4] = 115; buf[5] = 116; buf[6] = 116; buf[7] = 115;
  writeUint32BE(buf, 12, entries.length);
  let off = 16;
  entries.forEach((e) => {
    writeUint32BE(buf, off, e.sampleCount);
    writeUint32BE(buf, off + 4, e.sampleDelta);
    off += 8;
  });
  return buf;
}

/**
 * 构造 stsz box。
 * @param {number[]} samples
 * @returns {Uint8Array}
 */
function buildStszBox(samples) {
  const size = 8 + 12 + samples.length * 4;
  const buf = new Uint8Array(size);
  writeUint32BE(buf, 0, size);
  buf[4] = 115; buf[5] = 116; buf[6] = 115; buf[7] = 122;
  writeUint32BE(buf, 12, 0);
  writeUint32BE(buf, 16, samples.length);
  let off = 20;
  samples.forEach((sz) => {
    writeUint32BE(buf, off, sz);
    off += 4;
  });
  return buf;
}

/**
 * 构造 stco box（单 chunk）。
 * @param {number[]} offsets
 * @returns {Uint8Array}
 */
function buildStcoBox(offsets) {
  const size = 8 + 8 + offsets.length * 4;
  const buf = new Uint8Array(size);
  writeUint32BE(buf, 0, size);
  buf[4] = 115; buf[5] = 116; buf[6] = 99; buf[7] = 111;
  writeUint32BE(buf, 12, offsets.length);
  let off = 16;
  offsets.forEach((v) => {
    writeUint32BE(buf, off, v);
    off += 4;
  });
  return buf;
}

/**
 * 构造 stsc box（单 chunk 含全部 samples）。
 * @param {number} sampleCount
 * @returns {Uint8Array}
 */
function buildStscBoxSingleChunk(sampleCount) {
  const size = 8 + 8 + 12;
  const buf = new Uint8Array(size);
  writeUint32BE(buf, 0, size);
  buf[4] = 115; buf[5] = 116; buf[6] = 115; buf[7] = 99;
  writeUint32BE(buf, 12, 1);
  writeUint32BE(buf, 16, 1);
  writeUint32BE(buf, 20, sampleCount);
  writeUint32BE(buf, 24, 1);
  return buf;
}

/**
 * 用新 box 替换 buffer 中的旧 box。
 * @param {Uint8Array} buf
 * @param {{ offset: number, boxEnd: number }} oldBox
 * @param {Uint8Array} newBox
 * @returns {Uint8Array}
 */
function replaceBox(buf, oldBox, newBox) {
  const out = new Uint8Array(buf.length - (oldBox.boxEnd - oldBox.offset) + newBox.length);
  out.set(buf.slice(0, oldBox.offset), 0);
  out.set(newBox, oldBox.offset);
  out.set(buf.slice(oldBox.boxEnd), oldBox.offset + newBox.length);
  return out;
}

/**
 * 测量 container box 内子 box 占用字节（不含自身 8 字节头）。
 * @param {Uint8Array} buf
 * @param {number} dataStart
 * @returns {number}
 */
function measureContainerContentSize(buf, dataStart) {
  let offset = dataStart;
  while (offset + 8 <= buf.length) {
    const header = readBoxHeader(buf, offset, buf.length);
    if (!header || header.size < 8) break;
    offset += header.size;
  }
  return offset - dataStart;
}

/**
 * 自底向上修正 moov 内 container box 的 size（以 buffer 实际长度为界，避免 stbl 替换后边界过期）。
 * @param {Uint8Array} moov moov box 完整字节（含 8 字节头）
 * @returns {Uint8Array}
 */
function fixMoovBoxSizes(moov) {
  const out = new Uint8Array(moov);
  ['stbl', 'minf', 'mdia', 'trak'].forEach((type) => {
    const box = findBox(out, type, 0, out.length);
    if (!box) return;
    const contentSize = measureContainerContentSize(out, box.dataStart);
    writeUint32BE(out, box.offset, 8 + contentSize);
  });
  /** moov 根 box 占满整个 buffer */
  writeUint32BE(out, 0, out.length);
  return out;
}

/**
 * 构造 8 字节空 free box（与微信导出结构对齐）。
 * @returns {Uint8Array}
 */
function buildFreeBox() {
  const buf = new Uint8Array(8);
  writeUint32BE(buf, 0, 8);
  buf[4] = 102; buf[5] = 114; buf[6] = 101; buf[7] = 101;
  return buf;
}

/**
 * 从各段 stts 推断统一 sampleDelta。
 * @param {ReturnType<typeof extractMp4Parts>[]} partsList
 * @returns {number}
 */
function resolveCommonSampleDelta(partsList) {
  /** @type {number|null} */
  let delta = null;
  partsList.forEach((p) => {
    (p.sttsEntries || []).forEach((e) => {
      if (e && e.sampleDelta > 0) {
        if (delta == null) delta = e.sampleDelta;
        else if (delta !== e.sampleDelta) {
          /** 不一致时保留首个，后续靠 flatten 单 entry 兼容 */
        }
      }
    });
  });
  return delta != null && delta > 0 ? delta : 512;
}

/**
 * 一次性重建 stbl（stsd 保留 + 新 stts/stsc/stsz/stco），避免逐个 replace 后 stbl 边界失效。
 * @param {Uint8Array} moov
 * @param {number[]} samples
 * @param {{ sampleCount: number, sampleDelta: number }[]} stts
 * @param {number} mdatDataStart
 * @returns {Uint8Array}
 */
function rebuildStblInMoov(moov, samples, stts, mdatDataStart) {
  const stblBox = findBox(moov, 'stbl', 0, moov.length);
  const stsdBox = findBox(moov, 'stsd', 0, moov.length);
  if (!stblBox || !stsdBox) throw new Error('mp4_stbl_missing');

  const stsdBytes = moov.slice(stsdBox.offset, stsdBox.boxEnd);
  const sttsBytes = buildSttsBox(stts);
  const stscBytes = buildStscBoxSingleChunk(samples.length);
  const stszBytes = buildStszBox(samples);
  const stcoBytes = buildStcoBox([mdatDataStart]);

  const innerSize = stsdBytes.length + sttsBytes.length + stscBytes.length + stszBytes.length + stcoBytes.length;
  const stblBuf = new Uint8Array(8 + innerSize);
  writeUint32BE(stblBuf, 0, 8 + innerSize);
  stblBuf[4] = 115; stblBuf[5] = 116; stblBuf[6] = 98; stblBuf[7] = 108;
  let pos = 8;
  [stsdBytes, sttsBytes, stscBytes, stszBytes, stcoBytes].forEach((part) => {
    stblBuf.set(part, pos);
    pos += part.length;
  });

  return replaceBox(moov, stblBox, stblBuf);
}

/**
 * 根据 stts 计算 track 时长（timescale ticks）。
 * @param {{ sampleCount: number, sampleDelta: number }[]} entries
 * @returns {number}
 */
function durationTicksFromStts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.reduce((sum, e) => sum + (e.sampleCount || 0) * (e.sampleDelta || 0), 0);
}

/**
 * 从 moov 中移除指定 box（用于去掉限制播放时长的 edts/elst）。
 * @param {Uint8Array} moov
 * @param {string} boxType
 * @returns {Uint8Array}
 */
function removeBoxFromMoov(moov, boxType) {
  const box = findBox(moov, boxType, 0, moov.length);
  if (!box) return moov;
  const out = new Uint8Array(moov.length - (box.boxEnd - box.offset));
  out.set(moov.slice(0, box.offset), 0);
  out.set(moov.slice(box.boxEnd), box.offset);
  return out;
}

/**
 * 读取 mvhd timescale。
 * @param {Uint8Array} buf
 * @param {{ dataStart: number, boxEnd: number }} box
 * @returns {number}
 */
function parseMvhdTimescale(buf, box) {
  const base = box.dataStart;
  if (buf[base] === 0) return readUint32BE(buf, base + 12) || 1;
  return readUint32BE(buf, base + 20) || 1;
}

/**
 * 读取 moov 内首个 mdhd duration（用于校验 patch 是否生效）。
 * @param {Uint8Array} moov
 * @returns {{ duration: number, timescale: number }}
 */
function readFirstMdhd(moov) {
  const box = findBox(moov, 'mdhd', 0, moov.length);
  if (!box) return { duration: 0, timescale: 1 };
  return parseMdhd(moov, box);
}

/**
 * 收集区间内所有指定类型的 box（递归）。
 * @param {Uint8Array} buf
 * @param {string} type
 * @param {number} start
 * @param {number} end
 * @param {Array<{ offset: number, size: number, headerSize: number, dataStart: number, boxEnd: number, type: string }>} out
 * @returns {void}
 */
function collectBoxes(buf, type, start, end, out) {
  let offset = start;
  while (offset + 8 <= end) {
    const header = readBoxHeader(buf, offset, end);
    if (!header) break;
    if (header.type === type) {
      out.push({ offset, ...header });
    }
    if (CONTAINER_BOX_TYPES.indexOf(header.type) >= 0) {
      collectBoxes(buf, type, header.dataStart, header.boxEnd, out);
    }
    offset += header.size;
  }
}

/**
 * 更新 moov 内 mdhd / tkhd / mvhd 的 duration（兼容 version 0 与 1，mvhd 按 timescale 换算）。
 * @param {Uint8Array} moov
 * @param {number} durationTicks mdhd 时间轴 ticks
 * @returns {Uint8Array}
 */
function patchDurations(moov, durationTicks) {
  const out = new Uint8Array(moov);
  /** @type {Array<{ offset: number, size: number, headerSize: number, dataStart: number, boxEnd: number, type: string }>} */
  const mdhdList = [];
  /** @type {typeof mdhdList} */
  const tkhdList = [];
  collectBoxes(out, 'mdhd', 0, out.length, mdhdList);
  collectBoxes(out, 'tkhd', 0, out.length, tkhdList);

  let mdhdTimescale = 1;
  if (mdhdList.length) {
    mdhdTimescale = parseMdhd(out, mdhdList[0]).timescale || 1;
  }
  const ticks = Math.max(1, Math.floor(durationTicks));

  mdhdList.forEach((box) => writeFullBoxDuration(out, box, 16, 24, ticks));
  tkhdList.forEach((box) => writeFullBoxDuration(out, box, 20, 32, ticks));

  const mvhd = findBox(out, 'mvhd', 0, out.length);
  if (mvhd) {
    const mvhdTs = parseMvhdTimescale(out, mvhd);
    const mvhdDur = mdhdTimescale > 0
      ? Math.max(1, Math.floor(ticks * mvhdTs / mdhdTimescale))
      : ticks;
    writeFullBoxDuration(out, mvhd, 16, 24, mvhdDur);
  }
  return out;
}

/**
 * 拼接多个 mp4 元数据段（单 chunk 输出，兼容性最佳）。
 * @param {ReturnType<typeof extractMp4Parts>[]} partsList
 * @returns {Uint8Array}
 */
function buildMergedMp4(partsList) {
  const first = partsList[0];
  /** @type {number[]} */
  let samples = first.stszSamples.slice();
  /** @type {Uint8Array[]} */
  const mdatParts = [first.mdatPayload];

  for (let i = 1; i < partsList.length; i += 1) {
    const part = partsList[i];
    if (!partsCompatible(first, part)) {
      const err = new Error('mp4_codec_mismatch');
      err.a = first.fingerprint;
      err.b = part.fingerprint;
      throw err;
    }
    samples = samples.concat(part.stszSamples);
    mdatParts.push(part.mdatPayload);
  }

  const stts = [{ sampleCount: samples.length, sampleDelta: resolveCommonSampleDelta(partsList) }];
  const mdatTotal = mdatParts.reduce((sum, p) => sum + p.length, 0);
  const totalDuration = samples.length * stts[0].sampleDelta;
  const freeBox = buildFreeBox();
  const ftypBytes = first.ftyp;

  const sampleBytes = samples.reduce((sum, sz) => sum + sz, 0);
  if (sampleBytes > 0 && Math.abs(sampleBytes - mdatTotal) > 256) {
    const err = new Error('mp4_mdat_size_mismatch');
    err.sampleBytes = sampleBytes;
    err.mdatTotal = mdatTotal;
    throw err;
  }

  /**
   * 重建 moov（单 chunk stbl 整体替换，移除 edts 避免只播首段）。
   * @param {number} mdatDataStart
   * @returns {Uint8Array}
   */
  const rebuildMoov = (mdatDataStart) => {
    let moov = new Uint8Array(first.moov);
    moov = rebuildStblInMoov(moov, samples, stts, mdatDataStart);
    moov = removeBoxFromMoov(moov, 'edts');
    moov = fixMoovBoxSizes(moov);
    moov = patchDurations(moov, totalDuration);
    const mdhd = readFirstMdhd(moov);
    if (mdhd.duration < totalDuration * 0.85) {
      const err = new Error('mp4_duration_patch_fail');
      err.expectedTicks = totalDuration;
      err.actualTicks = mdhd.duration;
      throw err;
    }
    return moov;
  };

  /** 与微信导出一致：ftyp + free + mdat + moov（moov 在末尾） */
  const mdatDataStart = ftypBytes.length + freeBox.length + 8;
  const moovFinal = rebuildMoov(mdatDataStart);

  const outSize = ftypBytes.length + freeBox.length + 8 + mdatTotal + moovFinal.length;
  const out = new Uint8Array(outSize);
  let off = 0;
  out.set(ftypBytes, off);
  off += ftypBytes.length;
  out.set(freeBox, off);
  off += freeBox.length;
  writeUint32BE(out, off, 8 + mdatTotal);
  out[off + 4] = 109; out[off + 5] = 100; out[off + 6] = 97; out[off + 7] = 116;
  off += 8;
  mdatParts.forEach((payload) => {
    out.set(payload, off);
    off += payload.length;
  });
  out.set(moovFinal, off);
  return out;
}

/**
 * 无重编码拼接多个 mp4，返回输出路径。
 * @param {string[]} filePaths
 * @param {string} [destPath]
 * @returns {Promise<string>}
 */
function concatMp4Files(filePaths, destPath) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter((p) => typeof p === 'string' && p);
  if (paths.length === 0) return Promise.reject(new Error('mp4_concat_empty'));
  if (paths.length === 1) return Promise.resolve(paths[0]);

  const userDataPath = wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '';
  const outPath = destPath || `${userDataPath}/merge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;

  return paths.reduce(
    (chain, p) => chain.then((acc) => readFileBytes(p).then((buf) => {
      try {
        acc.push(extractMp4Parts(buf));
      } catch (e) {
        const err = normalizeFsError(e, 'mp4_extract_fail');
        err.pathTail = p.slice(-48);
        err.fileBytes = buf.length;
        throw err;
      }
      return acc;
    })),
    Promise.resolve(/** @type {ReturnType<typeof extractMp4Parts>[]} */ ([]))
  ).then((partsList) => {
    let mergedBytes = null;
    try {
      mergedBytes = buildMergedMp4(partsList);
    } catch (e) {
      const err = normalizeFsError(e, 'mp4_build_fail');
      err.stage = 'concat';
      return Promise.reject(err);
    }
    return writeFileBytes(outPath, mergedBytes).then(() => outPath).catch((e) => {
      const err = normalizeFsError(e, 'write_file_fail');
      err.stage = 'concat';
      err.outPathTail = outPath.slice(-48);
      err.outBytes = mergedBytes ? mergedBytes.length : 0;
      return Promise.reject(err);
    });
  }).catch((e) => {
    const err = normalizeFsError(e, 'concat_fail');
    if (!err.stage) err.stage = 'concat';
    return Promise.reject(err);
  });
}

/**
 * 诊断：读取 mp4 结构摘要（供日志/弹窗展示）。
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>>}
 */
function inspectMp4File(filePath) {
  const path = typeof filePath === 'string' ? filePath : '';
  if (!path) return Promise.resolve({ ok: false, error: 'path_empty' });
  return readFileBytes(path).then((buf) => {
    try {
      const parts = extractMp4Parts(buf);
      return {
        ok: true,
        fileBytes: buf.length,
        topLevel: (parts.topLevelTypes || []).join(','),
        moovBytes: parts.moov.length,
        mdatBytes: parts.mdatPayload.length,
        sampleCount: parts.stszSamples.length,
        sttsEntries: parts.sttsEntries.length,
        duration: parts.mdhd.duration,
        mdhdVersion: parts.mdhd.version,
        fingerprint: parts.fingerprint
      };
    } catch (e) {
      return {
        ok: false,
        fileBytes: buf.length,
        error: String(e && (e.message || e.errMsg) || e || 'inspect_fail')
      };
    }
  }).catch((e) => ({
    ok: false,
    error: String(e && (e.message || e.errMsg) || e || 'read_fail')
  }));
}

module.exports = {
  concatMp4Files,
  inspectMp4File,
  parseVisualSampleFingerprint
};

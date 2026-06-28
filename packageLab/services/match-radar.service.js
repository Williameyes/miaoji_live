"use strict";
/**
 * @fileoverview 雷达多模态实验功能服务层。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.addMatchRadarTask = addMatchRadarTask;
exports.fetchMatchScoreSnapshots = fetchMatchScoreSnapshots;
exports.fetchMatchMediaSegments = fetchMatchMediaSegments;
const { post, get } = require('../../utils/request.js');
const { parseAppApiResponse } = require('../../utils/app-api-response.js');
/**
 * 挂载抖音口令并可选下发雷达插件能力。
 * @param params - 挂载参数
 * @returns add_task 响应
 */
function addMatchRadarTask(params) {
    const payload = {
        match_id: Number(params.match_id),
        raw_text: String(params.raw_text).trim()
    };
    if (params.capabilities) {
        payload.capabilities = params.capabilities;
    }
    if (params.score_ocr) {
        payload.score_ocr = params.score_ocr;
    }
    if (params.recorder) {
        payload.recorder = params.recorder;
    }
    return post('/api/app/match/add_task', payload).then(parseAppApiResponse);
}
/**
 * 查询场次记分牌截图列表。
 * @param matchId - 场次 ID
 */
function fetchMatchScoreSnapshots(matchId) {
    return get('/api/app/match/score_snapshots', { match_id: matchId }).then(parseAppApiResponse);
}
/**
 * 查询场次录制分片元数据（文件在雷达端）。
 * @param matchId - 场次 ID
 * @param mediaType - 可选 audio | video
 */
function fetchMatchMediaSegments(matchId, mediaType) {
    const params = { match_id: matchId };
    if (mediaType) {
        params.media_type = mediaType;
    }
    return get('/api/app/match/media_segments', params).then(parseAppApiResponse);
}

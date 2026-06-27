/**
 * @fileoverview 雷达多模态实验功能服务层。
 */

declare const require: any;

const { post, get } = require('../../utils/request.js');
const { parseAppApiResponse } = require('../../utils/app-api-response.js');

/** 雷达插件能力开关 */
export interface RadarCapabilities {
  /** 广告物料核销 */
  enable_ad_verify: boolean;
  /** 比分 OCR */
  enable_score_ocr: boolean;
  /** 音频录制 */
  enable_audio_record: boolean;
  /** 视频录制 */
  enable_video_record: boolean;
}

/** 比分 OCR 配置 */
export interface ScoreOcrConfig {
  /** 运动类型 */
  sport_type: 'basketball' | 'badminton' | 'generic';
  /** 主队名称 */
  team_a?: string;
  /** 客队名称 */
  team_b?: string;
}

/** 录制配置 */
export interface RadarRecorderConfig {
  /** 分片时长(秒)，默认 300 */
  segment_duration_sec?: number;
  /** 视频最大高度 */
  video_max_height?: number;
  /** 本地保留(小时)，默认 24 */
  local_retention_hours?: number;
}

/** add_task 请求体扩展 */
export interface AddMatchTaskRequest {
  /** 场次 ID */
  match_id: number;
  /** 抖音口令或链接原文 */
  raw_text: string;
  /** 插件能力 */
  capabilities?: Partial<RadarCapabilities>;
  /** OCR 配置 */
  score_ocr?: ScoreOcrConfig;
  /** 录制配置 */
  recorder?: Partial<RadarRecorderConfig>;
}

/** add_task 响应结构 */
export interface AddMatchTaskResponse {
  /** 请求是否成功 */
  success: boolean;
  /** 任务是否成功入队 */
  task_enqueued?: boolean;
  /** 重复排队原因 */
  duplicate_reason?: string;
}

/** 比分快照最新数据 */
export interface ScoreSnapshot {
  score_a: number;
  score_b: number;
  period: string;
  clock: string;
  confidence: number;
  timestamp: number;
  sec_user_id: string;
}

/** score_timeline 响应结构 */
export interface ScoreTimelineResponse {
  success: boolean;
  match_id: number;
  latest: ScoreSnapshot | null;
  timeline: any[];
}

/** 录制媒体分片 */
export interface MediaSegment {
  segment_index: number;
  media_type: 'audio' | 'video';
  local_path: string;
  file_size_bytes: number;
  duration_sec: number;
  started_at: number;
  ended_at: number;
}

/** media_segments 响应结构 */
export interface MediaSegmentsResponse {
  success: boolean;
  match_id: number;
  storage_location: string;
  counts: {
    audio: number;
    video: number;
  };
  summary: {
    total_duration_sec: number;
    total_file_size_bytes: number;
  };
  recorder_status: {
    event: string;
    media_type: string;
    [key: string]: any;
  };
  segments: MediaSegment[];
}

/**
 * 挂载抖音口令并可选下发雷达插件能力。
 * @param params - 挂载参数
 * @returns add_task 响应
 */
export function addMatchRadarTask(params: AddMatchTaskRequest): Promise<AddMatchTaskResponse> {
  const payload: Record<string, any> = {
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
 * 查询场次 OCR 比分时间线。
 * @param matchId - 场次 ID
 */
export function fetchMatchScoreTimeline(matchId: number): Promise<ScoreTimelineResponse> {
  return get('/api/app/match/score_timeline', { match_id: matchId }).then(parseAppApiResponse);
}

/**
 * 查询场次录制分片元数据（文件在雷达端）。
 * @param matchId - 场次 ID
 * @param mediaType - 可选 audio | video
 */
export function fetchMatchMediaSegments(
  matchId: number,
  mediaType?: 'audio' | 'video'
): Promise<MediaSegmentsResponse> {
  const params: Record<string, any> = { match_id: matchId };
  if (mediaType) {
    params.media_type = mediaType;
  }
  return get('/api/app/match/media_segments', params).then(parseAppApiResponse);
}

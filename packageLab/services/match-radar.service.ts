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
  /** 记分牌截图（能力位名保留兼容） */
  enable_score_ocr: boolean;
  /** 音频录制 */
  enable_audio_record: boolean;
  /** 视频录制 */
  enable_video_record: boolean;
}

/** 记分牌截图配置（领单字段名 score_ocr 保留兼容） */
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

/** 记分牌截图条目 */
export interface MatchScoreSnapshotItem {
  /** 主播 sec_user_id */
  sec_user_id: string;
  /** 截图公网 URL */
  snapshot_url: string;
  /** 运动类型 */
  sport_type: string;
  /** JPEG 字节数 */
  image_bytes: number;
  /** 捕获 Unix 秒 */
  timestamp: number;
}

/** score_snapshots 响应结构 */
export interface ScoreSnapshotsResponse {
  success: boolean;
  match_id: number;
  snapshots: MatchScoreSnapshotItem[];
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
 * 查询场次记分牌截图列表。
 * @param matchId - 场次 ID
 */
export function fetchMatchScoreSnapshots(matchId: number): Promise<ScoreSnapshotsResponse> {
  return get('/api/app/match/score_snapshots', { match_id: matchId }).then(parseAppApiResponse);
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

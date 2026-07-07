#!/usr/bin/env bash
# 将 E-BARD 篮球检测 ONNX 上传到 API 静态目录，供小程序按需下载。
#
# 用法：
#   ./scripts/publish-shooting-model.sh
#   ./scripts/publish-shooting-model.sh https://api.mx.server.ndcoo.com/static/ml/
#
# 上传后请在微信公众平台 → 开发管理 → 服务器域名 → downloadFile 合法域名
# 中确认 api.mx.server.ndcoo.com 已配置。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_FILE="${2:-basketball-avishah-v3.onnx}"
LOCAL_PATH="${ROOT_DIR}/packageRec/models/${MODEL_FILE}"
UPLOAD_BASE="${1:-https://api.mx.server.ndcoo.com/static/ml/}"

if [[ ! -f "${LOCAL_PATH}" ]]; then
  echo "本地模型不存在: ${LOCAL_PATH}"
  echo "请先运行: python3 scripts/export-shooting-ball-model.py"
  exit 1
fi

TARGET_URL="${UPLOAD_BASE%/}/${MODEL_FILE}"
BYTES=$(wc -c < "${LOCAL_PATH}" | tr -d ' ')
echo "上传 ${LOCAL_PATH} (${BYTES} bytes)"
echo "目标: ${TARGET_URL}"

curl -fSL -X PUT \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${LOCAL_PATH}" \
  "${TARGET_URL}"

echo ""
echo "完成。请真机访问投篮训练页验证下载。"

#!/bin/bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR/.."

echo "=========================================================="
echo "🚀 正在部署 OBS 网页记分牌到云服务器 (49.235.145.123)..."
echo "=========================================================="

scp obs-overlay/index.html obs-overlay/overlay.js obs-overlay/style.css obs-overlay/config.js ubuntu@49.235.145.123:/var/www/gaoguang-obs-overlay/

echo "✅ 部署成功！线上 OBS 网页已更新为最新版本。"

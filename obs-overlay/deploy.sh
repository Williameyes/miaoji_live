#!/bin/bash

echo "=== 开始部署高光记分 OBS 网页 Overlay (支持比分 + 中控台下发连接时间采集端) ==="

sudo mkdir -p /var/www/gaoguang-obs-overlay
sudo chown -R ubuntu:ubuntu /var/www/gaoguang-obs-overlay

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
if [ -f "$DIR/index.html" ] && [ -f "$DIR/style.css" ] && [ -f "$DIR/overlay.js" ]; then
  cp "$DIR/index.html" /var/www/gaoguang-obs-overlay/
  cp "$DIR/style.css" /var/www/gaoguang-obs-overlay/
  cp "$DIR/overlay.js" /var/www/gaoguang-obs-overlay/
  echo "✅ 已直接从本地文件目录复制更新至 /var/www/gaoguang-obs-overlay/"
  echo "=== 部署完成！==="
  exit 0
fi

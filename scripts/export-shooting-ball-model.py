#!/usr/bin/env python3
"""
从 HuggingFace E-BARD 权重导出篮球检测 ONNX（供投篮训练按需下载）。

输出：
  packageRec/models/basketball-yolov8n-v1.onnx
  packageRec/models/basketball-yolov8n-v1.meta.json
"""

from __future__ import annotations

import json
import os
import shutil

from ultralytics import YOLO

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'packageRec', 'models')
PT_URL = (
    'https://huggingface.co/GabrieleGiudici/E-BARD-detection-models/'
    'resolve/main/BODD_yolov8n_0001.pt'
)
ONNX_NAME = 'basketball-yolov8n-v1.onnx'
META_NAME = 'basketball-yolov8n-v1.meta.json'


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    print('Loading', PT_URL)
    model = YOLO(PT_URL)
    print('Classes:', model.names)

    onnx_path = model.export(format='onnx', imgsz=320, simplify=True, opset=12)
    dest = os.path.join(OUT_DIR, ONNX_NAME)
    shutil.copy(onnx_path, dest)
    print('Exported', dest, 'bytes', os.path.getsize(dest))

    meta = {
        'version': 'v1',
        'inputSize': 320,
        'classNames': {str(k): v for k, v in model.names.items()},
        'ballClassIds': [k for k, v in model.names.items() if 'ball' in str(v).lower()],
        'hoopClassIds': [k for k, v in model.names.items() if 'hoop' in str(v).lower()],
    }
    meta_path = os.path.join(OUT_DIR, META_NAME)
    with open(meta_path, 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, indent=2, ensure_ascii=False)
    print('Wrote', meta_path)


if __name__ == '__main__':
    main()

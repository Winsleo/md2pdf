#!/usr/bin/env bash
# 把 PDF 每页转成 PNG，方便肉眼检查排版。用法：scripts/preview.sh file.pdf [输出目录] [分辨率dpi]
# 依赖：poppler-utils（pdftoppm）。Ubuntu: sudo apt install poppler-utils
set -euo pipefail
pdf="${1:?用法: preview.sh file.pdf [输出目录] [dpi]}"
out="${2:-${pdf%.pdf}_preview}"
dpi="${3:-70}"
command -v pdftoppm >/dev/null || { echo "需要 pdftoppm：sudo apt install poppler-utils" >&2; exit 1; }
mkdir -p "$out"
pdftoppm -r "$dpi" -png "$pdf" "$out/page"
echo "已输出 $(ls "$out"/page*.png | wc -l) 页到 $out/"
command -v pdfinfo >/dev/null && pdfinfo "$pdf" | grep -E "Pages|Page size"

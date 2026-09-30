#!/usr/bin/env bash
#
# 下载全部原始数据到 data/raw/（该目录已被 .gitignore 忽略）。
#
#   bash scripts/download-raw-data.sh            # 下载全部
#   bash scripts/download-raw-data.sh stars      # 只下载星表
#   bash scripts/download-raw-data.sh cultures   # 只下载星座连线
#
# 为什么要单独写脚本而不是写几条 curl：所有数据源都在 GitHub raw 上，
# 国内网络下经常断流，必须带断点续传 + 重试 + 完整性校验。
# AT-HYG 的两个分片加起来 200 MB，断一次从头来是不可接受的。
#
# macOS 自带的 bash 是 3.2，不支持关联数组，所以这里用普通变量。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_STARS="$ROOT/data/raw"
RAW_CULTURES="$ROOT/data/raw/constellations"

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"

WHAT="${1:-all}"

fetch() {
  # $1 = 输出路径, $2 = URL, $3 = 期望字节数（0 表示不校验）
  local out="$1" url="$2" want="${3:-0}" name
  name="$(basename "$out")"
  mkdir -p "$(dirname "$out")"

  local attempt
  for attempt in $(seq 1 12); do
    local have=0
    [ -f "$out" ] && have="$(wc -c < "$out" | tr -d ' ')"
    if [ "$want" != "0" ] && [ "$have" -ge "$want" ]; then
      echo "  ✔ $name 已完整（$have 字节）"
      return 0
    fi

    echo "  ↓ $name（第 $attempt 次尝试，已有 ${have} 字节）"
    curl -L -C - --retry 4 --retry-all-errors --retry-delay 2 \
      --max-time 600 -A "$UA" -sS -o "$out" "$url" || true
  done

  local final=0
  [ -f "$out" ] && final="$(wc -c < "$out" | tr -d ' ')"
  if [ "$want" != "0" ] && [ "$final" -lt "$want" ]; then
    echo "  ✘ $name 下载不完整：$final / $want 字节" >&2
    return 1
  fi
  echo "  ✔ $name 完成（$final 字节）"
  return 0
}

download_stars() {
  echo
  echo "== AT-HYG v3.2 星表（约 200 MB）=="
  echo "   来源：https://codeberg.org/astronexus/athyg （GitHub 镜像 astronexus/ATHYG-Database）"
  echo "   许可证：CC BY-SA 4.0"
  local base="https://raw.githubusercontent.com/astronexus/ATHYG-Database/main/data"
  fetch "$RAW_STARS/athyg_v32-1.csv.gz" "$base/athyg_v32-1.csv.gz" 98906100 || return 1
  fetch "$RAW_STARS/athyg_v32-2.csv.gz" "$base/athyg_v32-2.csv.gz" 100113696 || return 1

  echo
  echo "== 校验 gzip 完整性 =="
  local f
  for f in "$RAW_STARS"/athyg_v32-*.csv.gz; do
    if gzip -t "$f" 2>/dev/null; then
      echo "  ✔ $(basename "$f")"
    else
      echo "  ✘ $(basename "$f") 损坏，请删除后重跑本脚本" >&2
      return 1
    fi
  done
}

download_cultures() {
  echo
  echo "== Stellarium skyculture（星座连线，约 900 KB）=="
  echo "   来源：https://github.com/Stellarium/stellarium/tree/master/skycultures"
  echo "   许可证：CC BY-SA 4.0"
  local base="https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures"

  # 这两份是 scripts/build-constellations.ts 真正用到的
  fetch "$RAW_CULTURES/Stellarium_modern.index.json" "$base/modern/index.json" || return 1
  fetch "$RAW_CULTURES/Stellarium_chinese.index.json" "$base/chinese/index.json" || return 1
  fetch "$RAW_CULTURES/Stellarium_chinese.star_names.zh_CN.fab" \
    "$base/chinese/star_names.zh_CN.fab" || return 1
  fetch "$RAW_CULTURES/Stellarium.COPYING" \
    "https://raw.githubusercontent.com/Stellarium/stellarium/master/COPYING" || return 1

  # 下面这些不影响构建，只是保留了调研时对比过的其它星官体系，方便将来切换
  local extra
  for extra in chinese_xianglin chinese_yuan_dynasty chinese_song_dynasty; do
    fetch "$RAW_CULTURES/Stellarium_${extra}.index.json" "$base/${extra}/index.json" || true
  done

  # d3-celestial 是调研时评估过的 BSD-3-Clause 备选，默认不用，但留着可比对
  fetch "$RAW_CULTURES/constellations.lines.json" \
    "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json" || true
}

status=0
case "$WHAT" in
  stars)    download_stars || status=1 ;;
  cultures) download_cultures || status=1 ;;
  all)      download_stars && download_cultures || status=1 ;;
  *) echo "用法：$0 [all|stars|cultures]" >&2; exit 2 ;;
esac

echo
if [ "$status" -eq 0 ]; then
  echo "原始数据就绪。接下来："
  echo "  pnpm run data:all      # 生成 public/data/（星表 + 星座 + 银河贴图）"
else
  echo "有文件未能下载完整。网络不稳时可以重复运行本脚本，它会断点续传。" >&2
fi
exit "$status"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SAMPLES_DIR="${SCRIPT_DIR}/samples"
OUTPUT="${SAMPLES_DIR}/synthetic.mkv"

mkdir -p "$SAMPLES_DIR"

# Check if any video files already exist
video_count=$(find "$SAMPLES_DIR" -maxdepth 1 -type f \( -name '*.mkv' -o -name '*.mp4' -o -name '*.avi' \) | wc -l)

if [[ "$video_count" -gt 0 ]]; then
  echo "samples/ already has video files — skipping generation"
  exit 0
fi

if ! command -v ffmpeg &> /dev/null; then
  echo "ERROR: ffmpeg not found. Install it to generate test samples." >&2
  exit 1
fi

echo "Generating synthetic test clip -> samples/synthetic.mkv"

ffmpeg -y \
  -f lavfi -i "smptebars=size=1280x720:rate=24:duration=5" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=5" \
  -c:v libx264 -preset ultrafast -crf 18 \
  -c:a aac -b:a 128k \
  "$OUTPUT" 2>/dev/null

echo "Done: $(du -h "$OUTPUT" | cut -f1) -> samples/synthetic.mkv"

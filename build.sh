#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/src"
DIST_DIR="${SCRIPT_DIR}/dist/LocalFlowPlugins"
DEPLOY=false

# Path to tdarr-av1 interactive test instance plugin dir
TDARR_AV1_DIR="${SCRIPT_DIR}/../tdarr-av1"
DEPLOY_TARGET="${TDARR_AV1_DIR}/test/tdarr_config/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) DEPLOY=true; shift ;;
    --deploy-to) DEPLOY=true; DEPLOY_TARGET="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Find esbuild
ESBUILD="${SCRIPT_DIR}/node_modules/.bin/esbuild"
if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found. Run 'npm install' first." >&2
  exit 1
fi

# Node builtins that must not be bundled
EXTERNALS=(fs path child_process os)
EXTERNAL_FLAGS=""
for ext in "${EXTERNALS[@]}"; do
  EXTERNAL_FLAGS="${EXTERNAL_FLAGS} --external:${ext}"
done

# Clean dist
rm -rf "$DIST_DIR"

# Bundle each plugin (every directory under src/ except shared/)
plugin_count=0
for plugin_dir in "${SRC_DIR}"/*/; do
  plugin_name="$(basename "$plugin_dir")"
  [[ "$plugin_name" == "shared" ]] && continue

  entry="${plugin_dir}index.js"
  if [[ ! -f "$entry" ]]; then
    echo "WARNING: ${plugin_name}/index.js not found, skipping" >&2
    continue
  fi

  version="1.0.0"

  # Read category from plugin.json if it exists, default to "video"
  category="video"
  plugin_json="${plugin_dir}plugin.json"
  if [[ -f "$plugin_json" ]]; then
    cat_override=$(node -e "console.log(require('${plugin_json}').category || 'video')" 2>/dev/null)
    if [[ -n "$cat_override" ]]; then
      category="$cat_override"
    fi
  fi

  out_dir="${DIST_DIR}/${category}/${plugin_name}/${version}"
  mkdir -p "$out_dir"

  echo "  bundle: ${plugin_name} -> dist/LocalFlowPlugins/${category}/${plugin_name}/${version}/index.js"

  # shellcheck disable=SC2086
  "$ESBUILD" "$entry" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node18 \
    ${EXTERNAL_FLAGS} \
    --outfile="${out_dir}/index.js"

  plugin_count=$((plugin_count + 1))
done

echo ""
echo "Built ${plugin_count} plugin(s) -> dist/LocalFlowPlugins/"

# Deploy to test instance
if [[ "$DEPLOY" == true ]]; then
  if [[ ! -d "$DEPLOY_TARGET" ]]; then
    echo ""
    echo "ERROR: deploy target not found: ${DEPLOY_TARGET}" >&2
    exit 1
  fi

  cp -r "${DIST_DIR}/"* "$DEPLOY_TARGET/"

  echo ""
  echo "Deployed to: ${DEPLOY_TARGET}"
  echo "Restart Tdarr server to pick up changes."
fi

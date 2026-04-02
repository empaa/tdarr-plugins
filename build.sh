#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/src"
DIST_DIR="${SCRIPT_DIR}/dist/LocalFlowPlugins"
DEPLOY=false

# Path to tdarr-av1 interactive test instance plugin dir
TDARR_AV1_DIR="${SCRIPT_DIR}/../tdarr-av1"
DEPLOY_TARGET="${TDARR_AV1_DIR}/test/tdarr_config/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins"

for arg in "$@"; do
  case "$arg" in
    --deploy) DEPLOY=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
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
  out_dir="${DIST_DIR}/${plugin_name}/${version}"
  mkdir -p "$out_dir"

  echo "  bundle: ${plugin_name} -> dist/LocalFlowPlugins/${plugin_name}/${version}/index.js"

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
  if [[ ! -d "${TDARR_AV1_DIR}/test/tdarr_config" ]]; then
    echo ""
    echo "WARNING: tdarr-av1 test config not found at ${TDARR_AV1_DIR}/test/tdarr_config" >&2
    echo "Run './build.sh --interactive' in tdarr-av1 first to create it." >&2
    exit 1
  fi

  mkdir -p "$DEPLOY_TARGET"
  cp -r "${DIST_DIR}/"* "$DEPLOY_TARGET/"

  echo ""
  echo "Deployed to: ${DEPLOY_TARGET}"
  echo "Restart Tdarr server to pick up changes."
fi

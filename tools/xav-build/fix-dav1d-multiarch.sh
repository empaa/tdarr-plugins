#!/usr/bin/env bash
# Entrypoint for the xav build container.
#
# Applies the one local patch xav needs on Debian/Ubuntu, then runs whatever
# command was passed (normally: ./build.sh static_tq hdr).
#
# The patch: build_dav1d() rewrites dav1d's generated .pc with
#     sed "s|libdir=\${prefix}/lib|libdir=\${prefix}/build/src|"
# which is correct on Arch (meson writes `libdir=${prefix}/lib`) but wrong on
# Debian/Ubuntu, where meson writes `libdir=${prefix}/lib/x86_64-linux-gnu`.
# The multiarch suffix survives the substitution, producing
#     libdir=${prefix}/build/src/x86_64-linux-gnu
# which does not exist; pkg-config still resolves dav1d but the link test fails,
# and FFmpeg's configure reports the misleading
#     "dav1d >= 1.0.0 not found using pkg-config".
#
# NOTE ON THE DETECTION GREP: build.sh contains the literal text
#     libdir=\${prefix}/lib|libdir=\${prefix}/build/src
# with a BACKSLASH before each $. The previous version of this script gated on
#     grep -q 'libdir=\${prefix}/lib|libdir=\${prefix}/build/src'
# but in a basic regex `\$` means a literal `$`, so the pattern searched for the
# string WITHOUT the backslash and never matched. The whole patch block was
# skipped in silence -- not even its own "pattern not found" warning printed,
# since that echo lives inside the block -- and the build died 15s later in
# FFmpeg. Hence grep -F everywhere below, and a hard exit on no-match.
set -euo pipefail

# Distinctive substring of the PATCHED form, used to detect an already-patched
# tree (the repo is bind-mounted, so a previous run's patch persists).
NEW_MARKER='sed -i "s|^libdir=.*|libdir=\${prefix}/build/src|" "/tmp/dav1d.pc"'
# Distinctive substring of the UPSTREAM form.
OLD_MARKER='libdir=\${prefix}/lib|libdir=\${prefix}/build/src'

if [ ! -f ./build.sh ]; then
    echo "ERROR: no ./build.sh in $(pwd) -- is the xav repo mounted at the workdir?" >&2
    exit 1
fi

if grep -qF "${NEW_MARKER}" ./build.sh; then
    echo ">>> dav1d multiarch libdir patch already present, skipping"
elif grep -qF "${OLD_MARKER}" ./build.sh; then
    cp -n ./build.sh ./build.sh.orig 2>/dev/null || true
    python3 - <<'PY'
import sys

path = './build.sh'
src = open(path).read()

old_lib64 = 'sed -i "s|libdir=\\${prefix}/lib64|libdir=\\${prefix}/build/src|g" "/tmp/dav1d.pc"'
old_lib   = 'sed -i "s|libdir=\\${prefix}/lib|libdir=\\${prefix}/build/src|g" "/tmp/dav1d.pc"'
new_cmd   = 'sed -i "s|^libdir=.*|libdir=\\${prefix}/build/src|" "/tmp/dav1d.pc"'

if old_lib64 not in src or old_lib not in src:
    sys.exit("ERROR: expected dav1d sed lines not found in build.sh -- upstream changed")

# Collapse the two suffix-specific rewrites into one whole-line rewrite that is
# indifferent to whatever libdir meson emitted (lib, lib64, lib/<multiarch>).
src = src.replace(old_lib64, new_cmd).replace(old_lib, 'true')
open(path, 'w').write(src)
print(">>> applied dav1d multiarch libdir patch")
PY

    # Verify rather than trust: a patch that silently no-ops is the whole bug
    # this script exists to prevent.
    if ! grep -qF "${NEW_MARKER}" ./build.sh; then
        echo "ERROR: dav1d patch verification failed -- build.sh unchanged" >&2
        exit 1
    fi
    echo ">>> dav1d patch verified in build.sh"
else
    echo "ERROR: build.sh matches neither the upstream nor the patched dav1d" >&2
    echo "       libdir rewrite. Upstream has changed; re-derive the patch." >&2
    exit 1
fi

# Reminders for whoever reads the build log:
#  * an interrupted build leaves a poisoned instrumented libSvtAv1Enc.a that
#    cleanup_existing() mistakes for a finished one -- wipe the component dir
#    (BUILD_DIR is $HOME/.local/src, ephemeral under `docker run --rm`)
#  * cargo does not track libSvtAv1Enc.a, so `cargo clean` is required after
#    changing SVT fork/version or the relink silently does not happen
echo ">>> running: $*"
exec "$@"

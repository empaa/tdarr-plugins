// src/shared/staging.js
'use strict';

// Getting the working file into Tdarr's workDir before xav runs.
//
// This exists because of one xav constraint: xav hashes its input and creates a
// `.<hash>` temp directory NEXT TO THE INPUT FILE, with no flag to relocate it.
// Left pointing at the library that scatters hashed temp dirs across the share,
// and fails outright (os error 30) when the share is mounted read-only.
//
// It used to live in sanitizeFile, which meant a plugin that filters audio
// tracks carried five lines of comment about a different plugin's temp-directory
// behaviour, and staged every already-clean file whether or not an encode
// followed. The requirement belongs to whoever runs xav, so it lives here and
// xavEncode calls it.

const fs = require('fs');
const path = require('path');

// A copy can be tens of GB. Filling the transcode cache mid-flow fails in
// confusing ways much later, so refuse up front with a clear reason.
const COPY_HEADROOM = 1.1;

const freeBytesIn = (dir) => {
  // statfsSync is Node 18.15+; treat "unknown" as "proceed" rather than failing
  // on the check itself.
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) {
    return null;
  }
};

/**
 * Ensure filePath lives inside workDir, hardlinking when possible and copying
 * when not.
 *
 * @param {string} filePath - the current working file
 * @param {string} workDir - Tdarr's per-job working directory
 * @param {function} log - jobLog
 * @returns {{ path: string, staged: boolean }} path to use from here on, and
 *   whether we created it (callers may delete only what they created)
 */
const stageIntoWorkDir = (filePath, workDir, log) => {
  const say = typeof log === 'function' ? log : () => {};

  // realpath both sides: the comparison has to survive symlinks and bind mounts,
  // which is the difference between "already staged" and staging a file on top
  // of itself.
  let sameDir = false;
  try {
    sameDir = fs.realpathSync(path.dirname(filePath)) === fs.realpathSync(workDir);
  } catch (_) {
    sameDir = false;
  }
  if (sameDir) return { path: filePath, staged: false };

  const parsed = path.parse(filePath);
  // Keep the source extension. sanitizeFile only ever staged from its
  // already-clean branch, which guarantees .mkv; xavEncode can be pointed at any
  // container, and naming an mp4 ".staged.mkv" would lie to every tool
  // downstream that sniffs by extension.
  const stagedPath = path.join(workDir, `${parsed.name}.staged${parsed.ext}`);

  // A hardlink is free but only works within one filesystem, and can still fail
  // on one device across a bind mount -- so it is attempted, never assumed.
  try {
    if (fs.statSync(filePath).dev === fs.statSync(workDir).dev) {
      try { fs.unlinkSync(stagedPath); } catch (_) {}
      fs.linkSync(filePath, stagedPath);
      say(`[stage] hardlinked into the working directory: ${stagedPath}`);
      return { path: stagedPath, staged: true };
    }
  } catch (err) {
    say(`[stage] hardlink failed (${err.message}) -- copying instead`);
  }

  const needBytes = fs.statSync(filePath).size * COPY_HEADROOM;
  const free = freeBytesIn(workDir);
  if (free !== null && free < needBytes) {
    throw new Error(
      `Cannot stage ${path.basename(filePath)} into the working directory: needs `
      + `~${(needBytes / 1024 ** 3).toFixed(1)} GiB but only `
      + `${(free / 1024 ** 3).toFixed(1)} GiB is free in ${workDir}.`,
    );
  }

  try { fs.unlinkSync(stagedPath); } catch (_) {}
  fs.copyFileSync(filePath, stagedPath);
  say(`[stage] copied into the working directory: ${stagedPath}`);
  return { path: stagedPath, staged: true };
};

// Only ever called with a path this module returned as staged:true. On the
// hardlink path that drops a link and leaves the library file alone; on the copy
// path it frees the transcode cache early.
const unstage = (stagedPath, log) => {
  try {
    fs.unlinkSync(stagedPath);
    if (typeof log === 'function') log(`[stage] removed the staged working copy: ${stagedPath}`);
  } catch (_) {}
};

module.exports = { stageIntoWorkDir, unstage };

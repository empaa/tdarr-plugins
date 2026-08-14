// src/shared/audioMerge.js
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const findMkvmerge = () => {
  for (const p of ['/usr/local/bin/mkvmerge', '/usr/bin/mkvmerge']) {
    if (fs.existsSync(p)) return p;
  }
  return 'mkvmerge'; // fallback to PATH
};

// Remux everything except video and measure it. These are the exact streams
// mergeAudioVideo will put back afterwards, so the result is a constant to add
// to a projected video size -- not an estimate.
const probeNonVideoSize = async (inputPath, workDir, jobLog, dbg) => {
  const mkvmergeBin = findMkvmerge();
  const tmpAudio = path.join(workDir, 'audio-size-probe.mkv');
  try {
    await new Promise((resolve) => {
      const proc = cp.spawn(mkvmergeBin, ['-q', '-o', tmpAudio, '-D', inputPath]);
      proc.on('close', resolve);
      proc.on('error', resolve);
    });
    if (!fs.existsSync(tmpAudio)) return 0;
    const bytes = fs.statSync(tmpAudio).size;
    try { fs.unlinkSync(tmpAudio); } catch (_) {}
    const mb = bytes / (1024 ** 2);
    jobLog(`[init] audio+subs size: ${mb.toFixed(1)} MiB -- will be added to output estimate`);
    dbg(`probeNonVideoSize: ${bytes} bytes`);
    return bytes;
  } catch (_) {
    try { fs.unlinkSync(tmpAudio); } catch (__) {}
    return 0;
  }
};

// Historical GiB-returning wrapper. The av1an and ab-av1 trackers work in GiB;
// the xav tracker works in bytes.
const probeAudioSize = async (inputPath, workDir, jobLog, dbg) => {
  const bytes = await probeNonVideoSize(inputPath, workDir, jobLog, dbg);
  return bytes / (1024 ** 3);
};

const mergeAudioVideo = async (videoPath, inputPath, outputPath, processManager, jobLog, dbg) => {
  const mkvmergeBin = findMkvmerge();
  jobLog('[mux] muxing audio + subtitles from original via mkvmerge...');

  // Take ONLY the video track from the encode. xav copies the source's audio,
  // subtitles, chapters and attachments into its own output, so passing that
  // file whole and then adding `--no-video inputPath` muxed TWO complete sets of
  // every non-video stream into the result. Emil found it on the first
  // production encodes (Avatar, Harry Potter): 2 TrueHD tracks and 8 subtitle
  // tracks where the source had 1 and 4. It also inflated every measured output
  // size by a full copy of the audio -- Avatar's 24.1 GB result is ~10 GB of
  // video plus 6.74 GB of audio counted twice.
  //
  // The original is authoritative for everything except the video, so strip all
  // of it from the encoded file and let inputPath supply it once.
  const muxExit = await processManager.spawnAsync(mkvmergeBin, [
    '-o', outputPath,
    '--no-audio', '--no-subtitles', '--no-chapters', '--no-attachments', '--no-buttons',
    videoPath,
    '--no-video', inputPath,
  ], { silent: true });

  if (muxExit >= 2) {
    jobLog(`ERROR: mkvmerge failed (exit ${muxExit})`);
    return false;
  }
  if (muxExit === 1) {
    jobLog('[mux] mkvmerge warnings (exit 1) -- treating as success');
  }
  if (!fs.existsSync(outputPath)) {
    jobLog('ERROR: mux output not found after mkvmerge');
    return false;
  }
  dbg(`[mux] merge complete: ${outputPath}`);
  return true;
};

module.exports = { probeAudioSize, probeNonVideoSize, mergeAudioVideo };

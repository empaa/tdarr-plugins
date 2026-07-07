// src/shared/mezzanine.js
'use strict';

// Lossless "mezzanine" pre-pass. When lsmas cannot decode a source directly
// (e.g. some VC-1 streams), we do ONE linear ffmpeg pass to re-wrap the video
// into FFV1 -- a mathematically lossless, intra-only codec that lsmas decodes
// and seeks cheaply. av1an's chunked workers then seek every frame with no
// pre-roll, instead of making BestSource re-decode a huge span per chunk
// (which made a full-length VC-1 encode take 200h+).
//
// Why lossless: the intermediate feeds the quality-critical AV1 encode, so it
// must not degrade the source at all. FFV1 stores the exact decoded pixels, so
// the encoder sees precisely what it would have seen decoding the original.
// Audio/subtitles are intentionally dropped -- they are muxed back from the
// ORIGINAL file after encoding.

/**
 * ffmpeg args to transcode a source's first video stream into a lossless,
 * intra-only FFV1 mezzanine. Source pixel format (and thus bit depth) is
 * preserved -- no -pix_fmt is forced.
 * @param {object} o
 * @param {string} o.inputPath   source media path
 * @param {string} o.outputPath  mezzanine .mkv path
 * @returns {string[]} ffmpeg argument vector
 */
function buildMezzanineArgs({ inputPath, outputPath }) {
  return [
    '-nostdin', '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-an', '-sn', '-dn',
    '-c:v', 'ffv1',
    '-level', '3',
    '-coder', '1',
    '-context', '1',
    '-g', '1',
    '-slices', '24',
    '-slicecrc', '1',
    outputPath,
  ];
}

module.exports = { buildMezzanineArgs };

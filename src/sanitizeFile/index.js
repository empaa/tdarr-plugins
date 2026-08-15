// src/sanitizeFile/index.js
'use strict';

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif']);

// Lower number = higher quality. Used to break ties when channel count is equal.
const CODEC_RANK = {
  truehd: 1,
  'dts-hd ma': 2,
  dts_hd_ma: 2,
  flac: 3,
  dts: 4,
  eac3: 5,
  ac3: 6,
  aac: 7,
};
const WORST_RANK = 99;

function codecRank(codecName, profile) {
  const name = (codecName || '').toLowerCase();
  // TrueHD detection
  if (name === 'truehd') return CODEC_RANK.truehd;
  // DTS-HD MA: codec is 'dts' but profile contains 'MA'
  if (name === 'dts' && profile && /\bma\b/i.test(profile)) return CODEC_RANK['dts-hd ma'];
  return CODEC_RANK[name] || WORST_RANK;
}

// A track is a commentary if ffprobe flags the comment disposition or its title
// says "commentary". SDH (hearing_impaired) and forced tracks are NOT commentary.
function isCommentary(stream) {
  if (stream && stream.disposition && stream.disposition.comment === 1) return true;
  const title = stream && stream.tags && stream.tags.title;
  return /commentary/i.test(title || '');
}

/**
 * Categorize all streams into video, audio, subtitle, image.
 * @param {Array} streams - ffProbeData.streams
 * @returns {{ video: Array, audio: Array, subtitle: Array, image: Array }}
 */
function categorizeStreams(streams) {
  const video = [];
  const audio = [];
  const subtitle = [];
  const image = [];

  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    const idx = i;
    const codec = (s.codec_name || '').toLowerCase();

    if (s.codec_type === 'video') {
      if (IMAGE_CODECS.has(codec) || (s.disposition && s.disposition.attached_pic === 1)) {
        image.push({ idx, stream: s });
      } else {
        video.push({ idx, stream: s });
      }
    } else if (s.codec_type === 'audio') {
      audio.push({
        idx,
        stream: s,
        lang: (s.tags && s.tags.language || '').toLowerCase(),
        channels: s.channels || 0,
        rank: codecRank(s.codec_name, s.profile),
        commentary: isCommentary(s),
      });
    } else if (s.codec_type === 'subtitle') {
      subtitle.push({
        idx,
        stream: s,
        lang: (s.tags && s.tags.language || '').toLowerCase(),
        commentary: isCommentary(s),
      });
    }
    // data/attachment streams are silently dropped (not mapped)
  }

  return { video, audio, subtitle, image };
}

/**
 * Pick the feature video track and name the bonus ones.
 *
 * Blu-ray remuxes ship extra video: "Harry Potter and the Chamber of Secrets"
 * carries a 720x480 915 kbps "Commentary (PIP function)" track beside the
 * 1920x1080 feature. Left in place, the choice falls to xav, and nothing
 * downstream can catch a wrong one -- validateOutput skips dimensions because
 * xav autocrops, the PIP runs the film's full length so the duration matches,
 * and a 480p output sails through the size gate. Deciding it here makes the
 * choice explicit, logged and testable, and leaves the encoder one stream.
 *
 * Ranked by picture size first: the feature is the big one, and stream ORDER is
 * not a guarantee (which is what "first video stream" quietly assumed). The
 * default flag breaks a size tie, then the lowest index, so the result is
 * deterministic for any input.
 *
 * @param {Array} video - video entries from categorizeStreams
 * @returns {{ keep: object|null, drop: Array }}
 */
function selectPrimaryVideo(video) {
  if (!video || video.length === 0) return { keep: null, drop: [] };

  const pixels = (v) => (Number(v.stream.width) || 0) * (Number(v.stream.height) || 0);
  const isDefault = (v) => ((v.stream.disposition && v.stream.disposition.default) === 1 ? 1 : 0);

  const ranked = video.slice().sort((a, b) => (
    pixels(b) - pixels(a)
    || isDefault(b) - isDefault(a)
    || a.idx - b.idx
  ));

  return { keep: ranked[0], drop: ranked.slice(1).sort((a, b) => a.idx - b.idx) };
}

/**
 * Select the best audio track per wanted language.
 * @param {Array} audioTracks - from categorizeStreams
 * @param {string} originalLang - ISO 639-2 code (lowercase)
 * @param {string[]} additionalLangs - extra language codes (lowercase)
 * @param {boolean} keepCommentary - keep commentary tracks in additionalLangs
 * @returns {Array} selected audio tracks in desired order
 */
function selectAudio(audioTracks, originalLang, additionalLangs, keepCommentary) {
  // Safety: if only one track, always keep it
  if (audioTracks.length <= 1) return audioTracks;

  // Main (non-commentary) tracks: original language is always wanted.
  const mainWanted = [originalLang, ...additionalLangs.filter((l) => l !== originalLang)];

  // Find best MAIN track per language: highest channels, then best codec rank
  function bestForLang(lang) {
    const matches = audioTracks.filter((t) => !t.commentary && t.lang === lang);
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.channels - a.channels || a.rank - b.rank);
    return matches[0];
  }

  const selected = [];
  const seenIdx = new Set();

  for (const lang of mainWanted) {
    const best = bestForLang(lang);
    if (best && !seenIdx.has(best.idx)) {
      selected.push(best);
      seenIdx.add(best.idx);
    }
  }

  // Commentary tracks follow the additional-language list only -- the original
  // language is NOT auto-kept for commentaries.
  if (keepCommentary) {
    const commentaryLangs = new Set(additionalLangs);
    for (const t of audioTracks) {
      if (t.commentary && commentaryLangs.has(t.lang) && !seenIdx.has(t.idx)) {
        selected.push(t);
        seenIdx.add(t.idx);
      }
    }
  }

  // Safety: never emit an audio-less file
  if (selected.length === 0) return audioTracks;

  return selected;
}

/**
 * Select subtitle tracks matching wanted languages.
 * @param {Array} subTracks - from categorizeStreams
 * @param {string} originalLang - ISO 639-2 code (lowercase)
 * @param {string[]} subLangs - extra subtitle language codes (lowercase)
 * @param {boolean} keepCommentary - keep commentary subs in subLangs
 * @returns {Array} selected subtitle tracks in desired order
 */
function selectSubtitles(subTracks, originalLang, subLangs, keepCommentary) {
  // Main subs: original language is always wanted. Commentary subs follow the
  // additional-language list only (original NOT auto-kept for commentaries).
  const mainWanted = new Set([originalLang, ...subLangs]);
  const commentaryLangs = new Set(subLangs);
  const byLang = new Map();

  for (const t of subTracks) {
    const keep = t.commentary
      ? (keepCommentary && commentaryLangs.has(t.lang))
      : mainWanted.has(t.lang);
    if (keep) {
      if (!byLang.has(t.lang)) byLang.set(t.lang, []);
      byLang.get(t.lang).push(t);
    }
  }

  // Order: original language first, then additional in input order
  const ordered = [];
  const langOrder = [originalLang, ...subLangs.filter((l) => l !== originalLang)];
  for (const lang of langOrder) {
    if (byLang.has(lang)) ordered.push(...byLang.get(lang));
  }

  return ordered;
}

const details = () => ({
  name: 'Sanitize File',
  description: [
    'All-in-one pre-encode sanitizer. Determines the original language via',
    'Radarr/Sonarr (falls back to first audio track), keeps the best audio',
    'track per wanted language, filters subtitles, removes image streams',
    '(cover art/thumbnails), keeps only the feature video track (dropping',
    'bonus video such as PIP commentary), reorders streams, and remuxes to',
    'MKV. All in a single ffmpeg call.',
  ].join(' '),
  style: { borderColor: 'green' },
  tags: 'sanitize,audio,subtitle,remux,mkv,radarr,sonarr',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.00.01',
  sidebarPosition: -1,
  icon: 'faBroom',
  inputs: [
    {
      label: 'Radarr URL',
      name: 'radarr_url',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Radarr base URL, e.g. http://radarr:7878. Leave empty to skip.',
    },
    {
      label: 'Radarr API Key',
      name: 'radarr_api_key',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Radarr API key. Required if Radarr URL is set.',
    },
    {
      label: 'Sonarr URL',
      name: 'sonarr_url',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Sonarr base URL, e.g. http://sonarr:8989. Leave empty to skip.',
    },
    {
      label: 'Sonarr API Key',
      name: 'sonarr_api_key',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Sonarr API key. Required if Sonarr URL is set.',
    },
    {
      label: 'Path Mappings',
      name: 'path_mappings',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'JSON array of "tdarrPath:arrPath" mappings, e.g. ["/media:/mnt/media"]. Leave empty if paths match.',
    },
    {
      label: 'Additional Audio Languages',
      name: 'additional_audio_languages',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Comma-separated ISO 639-2 codes for extra audio languages to keep (e.g. eng,swe). The original language from Radarr/Sonarr is always kept.',
    },
    {
      label: 'Subtitle Languages',
      name: 'subtitle_languages',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Comma-separated ISO 639-2 codes for extra subtitle languages to keep (e.g. eng,swe). The original language subtitles are always kept.',
    },
    {
      label: 'Keep Commentary Tracks',
      name: 'keep_commentary_tracks',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Keep commentary audio/subtitle tracks (detected via the comment disposition or a "commentary" title; SDH/forced are not commentary). When off, commentaries are removed even if they are the only track in a wanted language. Commentary tracks follow the additional-language lists only — the original language is not auto-kept for commentaries.',
    },
  ],
  outputs: [
    { number: 1, tooltip: 'File was sanitized (streams filtered, reordered, remuxed to MKV)' },
    { number: 2, tooltip: 'File already clean — no changes needed' },
  ],
});

const plugin = async (args) => {
  const { createPathMapper } = require('../shared/pathMapper');
  const { getOriginalLanguage } = require('../shared/arrApi');
  const { createProcessManager } = require('../shared/processManager');
  const path = require('path');
  const fs = require('fs');

  const inputs = args.inputs || {};
  const radarrUrl = (inputs.radarr_url || '').trim().replace(/\/+$/, '');
  const radarrKey = (inputs.radarr_api_key || '').trim();
  const sonarrUrl = (inputs.sonarr_url || '').trim().replace(/\/+$/, '');
  const sonarrKey = (inputs.sonarr_api_key || '').trim();

  const additionalAudioLangs = (inputs.additional_audio_languages || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const subtitleLangs = (inputs.subtitle_languages || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const keepCommentary = inputs.keep_commentary_tracks === true || inputs.keep_commentary_tracks === 'true';

  const log = (msg) => {
    if (typeof args.jobLog === 'function') args.jobLog(msg);
    else console.log(`[Sanitize] ${msg}`);
  };

  const filePath = args.inputFileObj._id;
  const streams = args.inputFileObj.ffProbeData.streams || [];

  log('==== Sanitize File ====');
  log(`Input: ${filePath}`);

  // --- Step 1: Determine original language ---
  let originalLang = null;

  const hasArr = (radarrUrl && radarrKey) || (sonarrUrl && sonarrKey);
  if (hasArr) {
    let mapper;
    try {
      mapper = createPathMapper(inputs.path_mappings || '');
    } catch (err) {
      log(`Path mapping error: ${err.message} — Arr lookup skipped, falling back to first audio track language`);
    }
    if (mapper) {
      const arrPath = mapper.toArr(filePath);
      originalLang = await getOriginalLanguage({
        radarrUrl, radarrKey, sonarrUrl, sonarrKey, arrPath, log,
      });
    }
  }

  // Fallback: first audio track's language
  if (!originalLang) {
    const firstAudio = streams.find((s) => s.codec_type === 'audio');
    if (firstAudio && firstAudio.tags && firstAudio.tags.language) {
      originalLang = firstAudio.tags.language.toLowerCase();
      log(`Arr unavailable — using track 0 language: ${originalLang}`);
    }
  }

  // If still no language, keep everything
  if (!originalLang) {
    log('WARNING: No original language detected — keeping all audio tracks');
  }

  // --- Step 2: Analyze streams ---
  const { video, audio, subtitle, image } = categorizeStreams(streams);
  log(`Streams: ${video.length} video, ${audio.length} audio, ${subtitle.length} sub, ${image.length} image`);

  // Keep exactly one video track, so the encoder never has to choose.
  const { keep: primaryVideo, drop: droppedVideo } = selectPrimaryVideo(video);
  const selectedVideo = primaryVideo ? [primaryVideo] : [];
  for (const v of droppedVideo) {
    const t = (v.stream.tags && v.stream.tags.title) || '';
    log(
      `  dropping extra video: stream ${v.idx} ${v.stream.width}x${v.stream.height}`
      + `${t ? ` "${t}"` : ''} -- keeping stream ${primaryVideo.idx} `
      + `${primaryVideo.stream.width}x${primaryVideo.stream.height} as the feature`,
    );
  }

  // --- Step 3: Build keep-set ---
  const selectedAudio = originalLang
    ? selectAudio(audio, originalLang, additionalAudioLangs, keepCommentary)
    : audio; // no language = keep all

  const selectedSubs = originalLang
    ? selectSubtitles(subtitle, originalLang, subtitleLangs, keepCommentary)
    : subtitle; // no language = keep all

  log(`Keeping: ${selectedAudio.length} audio, ${selectedSubs.length} subtitle`);
  for (const a of selectedAudio) {
    log(`  audio: [${a.lang}] ${a.stream.codec_name} ${a.channels}ch (stream ${a.idx})`);
  }
  for (const s of selectedSubs) {
    log(`  sub: [${s.lang}] ${s.stream.codec_name} (stream ${s.idx})`);
  }

  // --- Step 4: Check if already clean ---
  const ext = path.extname(filePath).toLowerCase();
  const isMkv = ext === '.mkv';
  const noImages = image.length === 0;
  // A bonus video track makes the file dirty however tidy its audio is --
  // passing it through untouched would hand the encoder both streams.
  const videoMatch = selectedVideo.length === video.length;
  const audioMatch = selectedAudio.length === audio.length
    && selectedAudio.every((a, i) => audio[i] && a.idx === audio[i].idx);
  const subMatch = selectedSubs.length === subtitle.length
    && selectedSubs.every((s, i) => subtitle[i] && s.idx === subtitle[i].idx);

  // Verify stream order: all video indices must come before all audio,
  // and all audio before all subtitle.
  const lastVideoIdx = selectedVideo.length > 0 ? Math.max(...selectedVideo.map((v) => v.idx)) : -1;
  const firstAudioIdx = selectedAudio.length > 0 ? Math.min(...selectedAudio.map((a) => a.idx)) : Infinity;
  const lastAudioIdx = selectedAudio.length > 0 ? Math.max(...selectedAudio.map((a) => a.idx)) : -1;
  const firstSubIdx = selectedSubs.length > 0 ? Math.min(...selectedSubs.map((s) => s.idx)) : Infinity;
  const orderCorrect = lastVideoIdx < firstAudioIdx && lastAudioIdx < firstSubIdx;

  if (isMkv && noImages && videoMatch && audioMatch && subMatch && orderCorrect) {
    log('File already clean — no changes needed, passing through untouched');

    // Deliberately NOT staged into workDir. This used to hardlink-or-copy the
    // file into the working directory to satisfy xav, which creates its temp
    // directory next to its input -- but that is xav's constraint, so xavEncode
    // now stages for itself (src/shared/staging.js). Staging here meant every
    // already-clean file paid for a copy whether or not an encode followed it,
    // and put a five-line comment about another plugin's internals in the
    // middle of an audio-track filter.
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  // --- Step 5: Build mkvmerge args and run ---
  const videoIds = selectedVideo.map((v) => v.idx).join(',');
  const audioIds = selectedAudio.map((a) => a.idx).join(',');
  const subIds = selectedSubs.map((s) => s.idx).join(',');

  // Track order: video → audio (original lang first) → subtitles (original lang first)
  const trackOrder = [
    ...selectedVideo.map((v) => `0:${v.idx}`),
    ...selectedAudio.map((a) => `0:${a.idx}`),
    ...selectedSubs.map((s) => `0:${s.idx}`),
  ].join(',');

  const outputName = `${path.parse(filePath).name}.sanitized.mkv`;
  const outputPath = path.join(args.workDir, outputName);

  const mkvmergeArgs = [
    '-q',
    '-o', outputPath,
    '--no-attachments',
    '-d', videoIds,
    '-a', audioIds,
    ...(selectedSubs.length > 0 ? ['-s', subIds] : ['-S']),
    '--track-order', trackOrder,
    filePath,
  ];

  const totalStreams = selectedVideo.length + selectedAudio.length + selectedSubs.length;
  log(`Running mkvmerge with ${totalStreams} tracks...`);

  const updateWorker = (fields) => {
    if (typeof args.updateWorker === 'function') {
      try { args.updateWorker(fields); } catch (_) {}
    }
  };

  updateWorker({ status: 'Sanitizing' });

  const mkvmergeBin = (() => {
    for (const p of ['/usr/local/bin/mkvmerge', '/usr/bin/mkvmerge']) {
      if (fs.existsSync(p)) return p;
    }
    return 'mkvmerge';
  })();

  const pm = createProcessManager(log, () => {});
  const exitCode = await pm.spawnAsync(mkvmergeBin, mkvmergeArgs, {
    silent: true,
  });
  pm.cleanup();

  updateWorker({ percentage: 100 });

  if (exitCode >= 2 || !fs.existsSync(outputPath)) {
    throw new Error(`mkvmerge failed (exit ${exitCode}) — output not created`);
  }
  if (exitCode === 1) {
    log('mkvmerge warnings (exit 1) — treating as success');
  }

  log(`Output: ${outputPath}`);

  // Hand the sanitized file to the next plugin as the working file by repointing
  // _id AND file to the new output -- the same pattern av1anEncode uses. Do NOT
  // re-probe via scanIndividualFile: it resolves the canonical record and returns
  // _id = the original library path, which orphans the sanitized remux and makes
  // the encoder re-mux every original audio/subtitle track (job asArvTWPg). Tdarr
  // re-scans the working file at each node, so downstream ffProbeData refreshes
  // on its own.
  return {
    outputFileObj: Object.assign({}, args.inputFileObj, { _id: outputPath, file: outputPath }),
    outputNumber: 1,
    variables: args.variables,
  };
};

module.exports = {
  details,
  plugin,
  // exported for unit tests
  categorizeStreams,
  selectPrimaryVideo,
  selectAudio,
  selectSubtitles,
  isCommentary,
};

# sanitizeFile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single Tdarr FlowPlugin that replaces 6 pre-encode nodes — determining original language via Radarr/Sonarr, selecting best audio per language, filtering subtitles, removing image streams, and remuxing to MKV in one ffmpeg call.

**Architecture:** Single plugin `src/sanitizeFile/index.js` using existing shared modules (`arrApi.js`, `pathMapper.js`, `processManager.js`, `logger.js`). All stream analysis uses Tdarr's `ffProbeData` (no extra ffprobe call). One ffmpeg `-c copy` invocation handles remux + stream selection + reorder.

**Tech Stack:** Node.js, ffmpeg (at `/usr/local/bin/ffmpeg`), Radarr/Sonarr v3 API

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/sanitizeFile/index.js` | Plugin: `details()` + `plugin()` exports |
| Create | `src/sanitizeFile/plugin.json` | Category metadata: `{ "category": "video" }` |
| Modify | `src/shared/arrApi.js` | Add `getOriginalLanguage()` helper that wraps find + extract language |

---

### Task 1: Add `getOriginalLanguage()` to arrApi.js

Encapsulates the Arr lookup + original language extraction so the plugin stays clean.

**Files:**
- Modify: `src/shared/arrApi.js`

- [ ] **Step 1: Add the `getOriginalLanguage` function**

Add before the `module.exports` block in `src/shared/arrApi.js`:

```javascript
/**
 * Look up the original language of a media file via Radarr/Sonarr.
 * @param {object} opts
 * @param {string} opts.radarrUrl - Radarr base URL (empty to skip)
 * @param {string} opts.radarrKey - Radarr API key
 * @param {string} opts.sonarrUrl - Sonarr base URL (empty to skip)
 * @param {string} opts.sonarrKey - Sonarr API key
 * @param {string} opts.arrPath   - File path (Arr-side)
 * @param {Function} opts.log     - Logging function
 * @returns {Promise<string|null>} ISO 639-2 language code or null
 */
async function getOriginalLanguage(opts) {
  const { radarrUrl, radarrKey, sonarrUrl, sonarrKey, arrPath, log } = opts;

  if (radarrUrl && radarrKey) {
    try {
      log('Searching Radarr for original language...');
      const match = await findRadarrMatch(radarrUrl, radarrKey, arrPath);
      if (match && match.movie.originalLanguage) {
        const lang = match.movie.originalLanguage.name;
        const iso = match.movie.originalLanguage.iso639_2;
        log(`Radarr: original language = ${lang} (${iso})`);
        return iso || null;
      }
      log('No Radarr match or no originalLanguage field');
    } catch (err) {
      log(`Radarr error: ${err.message}`);
    }
  }

  if (sonarrUrl && sonarrKey) {
    try {
      log('Searching Sonarr for original language...');
      const match = await findSonarrMatch(sonarrUrl, sonarrKey, arrPath, log);
      if (match && match.series.originalLanguage) {
        const lang = match.series.originalLanguage.name;
        const iso = match.series.originalLanguage.iso639_2;
        log(`Sonarr: original language = ${lang} (${iso})`);
        return iso || null;
      }
      log('No Sonarr match or no originalLanguage field');
    } catch (err) {
      log(`Sonarr error: ${err.message}`);
    }
  }

  return null;
}
```

- [ ] **Step 2: Export the new function**

Update the `module.exports` block in `src/shared/arrApi.js`:

```javascript
module.exports = {
  arrFetch,
  pollCommand,
  findRadarrMatch,
  findSonarrMatch,
  radarrRename,
  sonarrRename,
  getOriginalLanguage,
};
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/arrApi.js
git commit -m "feat(arrApi): add getOriginalLanguage for Arr language lookup"
```

---

### Task 2: Create plugin.json

**Files:**
- Create: `src/sanitizeFile/plugin.json`

- [ ] **Step 1: Create the metadata file**

```json
{ "category": "video" }
```

- [ ] **Step 2: Commit**

```bash
git add src/sanitizeFile/plugin.json
git commit -m "feat(sanitizeFile): add plugin category metadata"
```

---

### Task 3: Create sanitizeFile plugin — details() export

**Files:**
- Create: `src/sanitizeFile/index.js`

- [ ] **Step 1: Write the details function and all input definitions**

```javascript
// src/sanitizeFile/index.js
'use strict';

const details = () => ({
  name: 'Sanitize File',
  description: [
    'All-in-one pre-encode sanitizer. Determines the original language via',
    'Radarr/Sonarr (falls back to first audio track), keeps the best audio',
    'track per wanted language, filters subtitles, removes image streams',
    '(cover art/thumbnails), reorders streams, and remuxes to MKV.',
    'All in a single ffmpeg call.',
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
  ],
  outputs: [
    { number: 1, tooltip: 'File was sanitized (streams filtered, reordered, remuxed to MKV)' },
    { number: 2, tooltip: 'File already clean — no changes needed' },
  ],
});
```

- [ ] **Step 2: Add placeholder plugin export so the file is valid**

Append to the same file:

```javascript
const plugin = async (args) => {
  // Implemented in subsequent tasks
  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 2,
    variables: args.variables,
  };
};

module.exports = { details, plugin };
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds, `dist/LocalFlowPlugins/video/sanitizeFile/1.0.0/index.js` is created.

- [ ] **Step 4: Commit**

```bash
git add src/sanitizeFile/index.js
git commit -m "feat(sanitizeFile): scaffold plugin with details and placeholder"
```

---

### Task 4: Implement stream analysis helpers

These are pure functions inside `index.js` that categorize and rank streams from ffProbeData.

**Files:**
- Modify: `src/sanitizeFile/index.js`

- [ ] **Step 1: Add the image codec set and codec ranking**

Add above the `details` function:

```javascript
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
```

- [ ] **Step 2: Add the stream categorization function**

Add after the codec ranking code:

```javascript
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
      });
    } else if (s.codec_type === 'subtitle') {
      subtitle.push({
        idx,
        stream: s,
        lang: (s.tags && s.tags.language || '').toLowerCase(),
      });
    }
    // data/attachment streams are silently dropped (not mapped)
  }

  return { video, audio, subtitle, image };
}
```

- [ ] **Step 3: Add the audio selection function**

```javascript
/**
 * Select the best audio track per wanted language.
 * @param {Array} audioTracks - from categorizeStreams
 * @param {string} originalLang - ISO 639-2 code (lowercase)
 * @param {string[]} additionalLangs - extra language codes (lowercase)
 * @returns {Array} selected audio tracks in desired order
 */
function selectAudio(audioTracks, originalLang, additionalLangs) {
  // Safety: if only one track, always keep it
  if (audioTracks.length <= 1) return audioTracks;

  const wantedLangs = [originalLang, ...additionalLangs.filter((l) => l !== originalLang)];

  // Find best track per language: highest channels, then best codec rank
  function bestForLang(lang) {
    const matches = audioTracks.filter((t) => t.lang === lang);
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.channels - a.channels || a.rank - b.rank);
    return matches[0];
  }

  const selected = [];
  const seenIdx = new Set();

  for (const lang of wantedLangs) {
    const best = bestForLang(lang);
    if (best && !seenIdx.has(best.idx)) {
      selected.push(best);
      seenIdx.add(best.idx);
    }
  }

  // Safety: if nothing matched, keep all audio
  if (selected.length === 0) return audioTracks;

  return selected;
}
```

- [ ] **Step 4: Add the subtitle selection function**

```javascript
/**
 * Select subtitle tracks matching wanted languages.
 * @param {Array} subTracks - from categorizeStreams
 * @param {string} originalLang - ISO 639-2 code (lowercase)
 * @param {string[]} subLangs - extra subtitle language codes (lowercase)
 * @returns {Array} selected subtitle tracks in desired order
 */
function selectSubtitles(subTracks, originalLang, subLangs) {
  const wantedLangs = new Set([originalLang, ...subLangs]);
  const byLang = new Map();

  for (const t of subTracks) {
    if (wantedLangs.has(t.lang)) {
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
```

- [ ] **Step 5: Commit**

```bash
git add src/sanitizeFile/index.js
git commit -m "feat(sanitizeFile): add stream analysis and selection helpers"
```

---

### Task 5: Implement the plugin() function — language detection + analysis

**Files:**
- Modify: `src/sanitizeFile/index.js`

- [ ] **Step 1: Replace the placeholder plugin function with the real implementation**

Replace the placeholder `plugin` function with:

```javascript
const plugin = async (args) => {
  const { createPathMapper } = require('../shared/pathMapper');
  const { getOriginalLanguage } = require('../shared/arrApi');
  const { createProcessManager } = require('../shared/processManager');
  const path = require('path');

  const inputs = args.inputs || {};
  const radarrUrl = (inputs.radarr_url || '').trim().replace(/\/+$/, '');
  const radarrKey = (inputs.radarr_api_key || '').trim();
  const sonarrUrl = (inputs.sonarr_url || '').trim().replace(/\/+$/, '');
  const sonarrKey = (inputs.sonarr_api_key || '').trim();

  const additionalAudioLangs = (inputs.additional_audio_languages || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const subtitleLangs = (inputs.subtitle_languages || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

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
      log(`Path mapping error: ${err.message} — falling back to track 0`);
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

  // --- Step 3: Build keep-set ---
  const selectedAudio = originalLang
    ? selectAudio(audio, originalLang, additionalAudioLangs)
    : audio; // no language = keep all

  const selectedSubs = originalLang
    ? selectSubtitles(subtitle, originalLang, subtitleLangs)
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
  const audioMatch = selectedAudio.length === audio.length
    && selectedAudio.every((a, i) => audio[i] && a.idx === audio[i].idx);
  const subMatch = selectedSubs.length === subtitle.length
    && selectedSubs.every((s, i) => subtitle[i] && s.idx === subtitle[i].idx);

  if (isMkv && noImages && audioMatch && subMatch) {
    log('File already clean — no changes needed');
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  // --- Step 5: Build ffmpeg map args and run ---
  const mapArgs = [];
  for (const v of video) mapArgs.push('-map', `0:${v.idx}`);
  for (const a of selectedAudio) mapArgs.push('-map', `0:${a.idx}`);
  for (const s of selectedSubs) mapArgs.push('-map', `0:${s.idx}`);

  const outputName = `${path.parse(filePath).name}.sanitized.mkv`;
  const outputPath = path.join(args.workDir, outputName);

  const ffmpegArgs = [
    '-y',
    '-i', filePath,
    ...mapArgs,
    '-c', 'copy',
    outputPath,
  ];

  log(`Running ffmpeg with ${mapArgs.length / 2} mapped streams...`);

  const pm = createProcessManager(log, () => {});
  const exitCode = await pm.spawnAsync('/usr/local/bin/ffmpeg', ffmpegArgs, {
    silent: true,
  });
  pm.cleanup();

  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${exitCode}`);
  }

  log(`Output: ${outputPath}`);
  args.inputFileObj._id = outputPath;

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 1,
    variables: args.variables,
  };
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/sanitizeFile/index.js
git commit -m "feat(sanitizeFile): implement full plugin logic"
```

---

### Task 6: Build verification and deploy

**Files:**
- No new files — verification only

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: All plugins build successfully including sanitizeFile.

- [ ] **Step 2: Inspect bundled output**

Run: `head -50 dist/LocalFlowPlugins/video/sanitizeFile/1.0.0/index.js`
Expected: Self-contained bundle with all shared modules inlined.

- [ ] **Step 3: Deploy to test instance**

Run: `npm run deploy`
Expected: Plugin copied to tdarr-av1 test instance.

- [ ] **Step 4: Commit any remaining changes and push**

```bash
git push origin dev
```

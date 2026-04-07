# sanitizeFile Plugin — Design Spec

Replaces a 6-node Tdarr pre-encode pipeline with a single FlowPlugin that analyzes the file once and executes all cleanup in one ffmpeg call.

## What it replaces

1. MkvPropEdit (metadata cleanup — unnecessary, covered by image removal)
2. Migz1Remux (force MKV container)
3. MigzImageRemoval (remove cover art / embedded thumbnails)
4. Migz3CleanAudio + channel-count chain (audio language/quality filtering)
5. Migz4CleanSubs (subtitle filtering)
6. Re-order all streams (stream ordering)

## Plugin metadata

- **Name:** `sanitizeFile`
- **Category:** `video`
- **Icon:** `faBroom`
- **Outputs:** Port 1 (modified), Port 2 (already clean)
- **Errors:** Thrown as exceptions — Tdarr built-in error handler picks them up

## Inputs (Tdarr UI)

| Input | Type | UI | Default | Description |
|-------|------|----|---------|-------------|
| `radarr_url` | string | text | `""` | Radarr base URL (e.g., `http://radarr:7878`) |
| `radarr_api_key` | string | text | `""` | Radarr API key |
| `sonarr_url` | string | text | `""` | Sonarr base URL (e.g., `http://sonarr:8989`) |
| `sonarr_api_key` | string | text | `""` | Sonarr API key |
| `path_mappings` | string | text | `""` | JSON array of `"tdarr:arr"` path pairs |
| `additional_audio_languages` | string | text | `""` | Comma-separated ISO 639-2 codes for extra audio to keep |
| `subtitle_languages` | string | text | `""` | Comma-separated ISO 639-2 codes for extra subtitles to keep |

## Core logic

### Step 1 — Determine original language

1. If `radarr_url` configured: call `findRadarrMatch()` via `arrApi.js`, extract `movie.originalLanguage.iso639_2`
2. If no Radarr match and `sonarr_url` configured: call `findSonarrMatch()`, extract `series.originalLanguage.iso639_2`
3. If both fail or not configured: read `streams[0].tags.language` from the first audio track in `ffProbeData`
4. If track 0 has no language tag: treat as unknown, keep all audio tracks (safe fallback)

Each step is logged via `jobLog()` so the user can see what was detected.

### Step 2 — Analyze streams

Categorize every stream in `ffProbeData.streams`:

- **Video:** `codec_type === 'video'` and not an image codec
- **Audio:** `codec_type === 'audio'`
- **Subtitle:** `codec_type === 'subtitle'`
- **Image:** `codec_type === 'video'` with codec `mjpeg`, `png`, `bmp`, or `gif` (cover art, thumbnails) — also catches attachment-type image streams

For audio, group by language and rank within each group:

1. Highest channel count (8ch > 6ch > 2ch > 1ch)
2. If tied, prefer lossless over lossy: TrueHD > DTS-HD MA > FLAC > DTS > EAC3 > AC3 > AAC > others

### Step 3 — Build keep-set

**Audio:**
- Best track for the original language
- Best track for each additional audio language found in the file
- Safety: if only one audio track exists, always keep it
- Safety: if no tracks match any wanted language, keep all audio

**Subtitles:**
- All tracks matching the original language
- All tracks matching the subtitle language list
- If no matches: all subtitles are removed (not critical)

**Video:**
- All video streams

**Images:**
- None (all removed)

### Step 4 — Determine stream order

1. Video streams (original order)
2. Audio: original language first, then additional languages in input order
3. Subtitles: original language first, then additional languages in input order

### Step 5 — Compare to current state

Skip ffmpeg if ALL of these are true:
- Container is already MKV
- No image streams exist
- Stream count matches the keep-set
- Stream order matches the desired order

If skipped → output Port 2 (no changes).

### Step 6 — Execute ffmpeg

Single call, stream copy only:

```
ffmpeg -i input.{ext} \
  -map 0:{video_idx} \
  -map 0:{audio_idx_1} -map 0:{audio_idx_2} ... \
  -map 0:{sub_idx_1} -map 0:{sub_idx_2} ... \
  -c copy \
  {workDir}/output.mkv
```

- No re-encoding — pure remux with stream selection
- Image streams excluded by not mapping them
- Output written to `workDir`, then `outputFileObj._id` updated to the new path
- On non-zero exit code → `throw new Error(...)` → Tdarr error handler

## Shared modules reused

- `arrApi.js` — `findRadarrMatch()`, `findSonarrMatch()` for original language lookup
- `pathMapper.js` — `createPathMapper()` for Tdarr↔Arr path translation
- `processManager.js` — `spawnAsync()` for ffmpeg execution
- `logger.js` — `createLogger()` for logging

## File structure

```
src/
  sanitizeFile/
    index.js        # Plugin source
    plugin.json     # { "category": "video" }
```

Bundled by esbuild to `dist/LocalFlowPlugins/video/sanitizeFile/1.0.0/index.js`.

## Audio codec ranking

Used for "best format" selection when channel count is tied:

| Rank | Codec | Lossless |
|------|-------|----------|
| 1 | TrueHD (+ Atmos) | Yes |
| 2 | DTS-HD MA | Yes |
| 3 | FLAC | Yes |
| 4 | DTS | No |
| 5 | EAC3 (E-AC-3 / DD+) | No |
| 6 | AC3 (AC-3 / DD) | No |
| 7 | AAC | No |
| 8 | Everything else | No |

## Edge cases

| Situation | Behavior |
|-----------|----------|
| Only 1 audio track | Always kept, regardless of language |
| No audio matches wanted languages | Keep all audio tracks |
| No subtitles match wanted languages | Remove all subtitles |
| No subtitle streams in file | No-op for subtitle logic |
| Input already clean MKV | Port 2, no ffmpeg call |
| Non-MKV input (MP4, AVI, etc.) | Always runs ffmpeg to remux |
| Multiple video streams | All kept |
| ffmpeg non-zero exit | Throw error → Tdarr error handler |
| Arr unreachable + track 0 has no language | Keep all audio, log warning |

# Arr Rename FlowPlugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a FlowPlugin that triggers Radarr/Sonarr to rename files after encoding, placed after the Replace Original node in the Tdarr flow.

**Architecture:** Single plugin (`src/arrRename/index.js`) with two shared modules (`src/shared/pathMapper.js` for mount translation, `src/shared/arrApi.js` for Arr API interactions). Build script updated to support per-plugin category overrides.

**Tech Stack:** Node.js (CJS), esbuild bundling, Radarr/Sonarr v3 API, Tdarr FlowPlugin SDK

**Spec:** `docs/superpowers/specs/2026-04-06-arr-rename-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/shared/pathMapper.js` | Create | Bidirectional path translation between mount points |
| `src/shared/arrApi.js` | Create | Arr API client: fetch, poll, match, rename |
| `src/arrRename/index.js` | Create | FlowPlugin entry: details() + plugin() wiring shared modules |
| `build.sh` | Modify | Support per-plugin category via `plugin.json` |
| `src/arrRename/plugin.json` | Create | `{"category": "file"}` |
| `test/smoke.js` | Modify | Add `arrRename` to PLUGIN_NAMES |

---

### Task 1: Path Mapper Module

**Files:**
- Create: `src/shared/pathMapper.js`

- [ ] **Step 1: Create `src/shared/pathMapper.js`**

```js
// src/shared/pathMapper.js
'use strict';

/**
 * Creates a bidirectional path mapper from a JSON array of "from:to" strings.
 * "from" is the Tdarr-side mount, "to" is the Arr-side mount.
 *
 * @param {string} mappingsJson - JSON array like '["/media:/mnt/media"]', or empty string
 * @returns {{ toArr: (p: string) => string, fromArr: (p: string) => string }}
 */
function createPathMapper(mappingsJson) {
  const mappings = [];

  if (mappingsJson && mappingsJson.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(mappingsJson);
    } catch (err) {
      throw new Error(`Invalid path_mappings JSON: ${err.message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('path_mappings must be a JSON array of "from:to" strings');
    }

    for (const entry of parsed) {
      const parts = String(entry).split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid path mapping "${entry}" — expected "from:to" format`);
      }
      mappings.push({ from: parts[0], to: parts[1] });
    }
  }

  function toArr(p) {
    for (const m of mappings) {
      if (p.startsWith(m.from)) {
        return m.to + p.slice(m.from.length);
      }
    }
    return p;
  }

  function fromArr(p) {
    for (const m of mappings) {
      if (p.startsWith(m.to)) {
        return m.from + p.slice(m.to.length);
      }
    }
    return p;
  }

  return { toArr, fromArr };
}

module.exports = { createPathMapper };
```

- [ ] **Step 2: Verify it works with a quick manual check**

Run: `node -e "const {createPathMapper}=require('./src/shared/pathMapper.js'); const m=createPathMapper('[\"\/media:\/mnt\/media\"]'); console.log(m.toArr('/media/movies/foo.mkv')); console.log(m.fromArr('/mnt/media/movies/foo.mkv')); console.log(m.toArr('/other/path.mkv'));"`

Expected output:
```
/mnt/media/movies/foo.mkv
/media/movies/foo.mkv
/other/path.mkv
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/pathMapper.js
git commit -m "feat(shared): add pathMapper module for Arr mount translation"
```

---

### Task 2: Arr API Module

**Files:**
- Create: `src/shared/arrApi.js`

- [ ] **Step 1: Create `src/shared/arrApi.js`**

```js
// src/shared/arrApi.js
'use strict';

/**
 * Generic fetch wrapper for Radarr/Sonarr v3 APIs.
 */
async function arrFetch(url, apiKey, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Arr API ${res.status} at ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Poll a Radarr/Sonarr command until completed, failed, or timed out.
 * @param {Function} log - logging function
 */
async function pollCommand(baseUrl, apiKey, commandId, label, timeoutMs, log) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const cmd = await arrFetch(`${baseUrl}/api/v3/command/${commandId}`, apiKey);
    log(`${label}: ${cmd.status}`);
    if (cmd.status === 'completed') return;
    if (cmd.status === 'failed') throw new Error(`${label} command failed`);
  }
  log(`${label}: timed out after ${timeoutMs / 1000}s, proceeding`);
}

/**
 * Find a Radarr movie + movie file matching the given file path.
 * @returns {{ movie, movieFile } | null}
 */
async function findRadarrMatch(baseUrl, apiKey, arrPath) {
  const folder = arrPath.substring(0, arrPath.lastIndexOf('/'));
  const movies = await arrFetch(`${baseUrl}/api/v3/movie`, apiKey);

  const movie = movies.find((m) => {
    const mp = m.path.replace(/\/$/, '');
    return folder === mp || folder.startsWith(mp + '/');
  });
  if (!movie) return null;

  const files = await arrFetch(
    `${baseUrl}/api/v3/moviefile?movieId=${movie.id}`,
    apiKey,
  );
  const movieFile = files.find((f) => f.path === arrPath);
  if (!movieFile) return null;

  return { movie, movieFile };
}

/**
 * Find a Sonarr series + episode file matching the given file path.
 * @returns {{ series, episodeFile } | null}
 */
async function findSonarrMatch(baseUrl, apiKey, arrPath) {
  const parts = arrPath.split('/');
  parts.pop(); // filename
  parts.pop(); // season folder
  const seriesFolder = parts.join('/');

  const seriesList = await arrFetch(`${baseUrl}/api/v3/series`, apiKey);

  const series = seriesList.find((s) => {
    const sp = s.path.replace(/\/$/, '');
    return seriesFolder === sp || seriesFolder.startsWith(sp + '/');
  });
  if (!series) return null;

  const files = await arrFetch(
    `${baseUrl}/api/v3/episodefile?seriesId=${series.id}`,
    apiKey,
  );
  const episodeFile = files.find((f) => f.path === arrPath);
  if (!episodeFile) return null;

  return { series, episodeFile };
}

/**
 * Trigger Radarr rescan + rename for a specific movie file.
 * @returns {string} new file path (Arr-side)
 */
async function radarrRename(baseUrl, apiKey, movie, movieFile, timeoutMs, log) {
  log(`Calling RescanMovie for "${movie.title}" (id: ${movie.id})...`);
  const rescanCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ name: 'RescanMovie', movieId: movie.id }),
  });
  await pollCommand(baseUrl, apiKey, rescanCmd.id, 'RescanMovie', timeoutMs, log);

  log(`Calling RenameMovie...`);
  const renameCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ name: 'RenameMovie', movieIds: [movie.id] }),
  });
  await pollCommand(baseUrl, apiKey, renameCmd.id, 'RenameMovie', timeoutMs, log);

  const updated = await arrFetch(
    `${baseUrl}/api/v3/moviefile/${movieFile.id}`,
    apiKey,
  );
  return updated.path;
}

/**
 * Trigger Sonarr refresh + rename for a specific episode file.
 * @returns {string} new file path (Arr-side)
 */
async function sonarrRename(baseUrl, apiKey, series, episodeFile, timeoutMs, log) {
  log(`Calling RefreshSeries for "${series.title}" (id: ${series.id})...`);
  const refreshCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ name: 'RefreshSeries', seriesId: series.id }),
  });
  await pollCommand(baseUrl, apiKey, refreshCmd.id, 'RefreshSeries', timeoutMs, log);

  log(`Calling RenameFiles for episode file id: ${episodeFile.id}...`);
  const renameCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      name: 'RenameFiles',
      seriesId: series.id,
      files: [episodeFile.id],
    }),
  });
  await pollCommand(baseUrl, apiKey, renameCmd.id, 'RenameFiles', timeoutMs, log);

  const updated = await arrFetch(
    `${baseUrl}/api/v3/episodefile/${episodeFile.id}`,
    apiKey,
  );
  return updated.path;
}

module.exports = {
  arrFetch,
  pollCommand,
  findRadarrMatch,
  findSonarrMatch,
  radarrRename,
  sonarrRename,
};
```

- [ ] **Step 2: Verify module loads without syntax errors**

Run: `node -e "const m = require('./src/shared/arrApi.js'); console.log(Object.keys(m).join(', '));"`

Expected output:
```
arrFetch, pollCommand, findRadarrMatch, findSonarrMatch, radarrRename, sonarrRename
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/arrApi.js
git commit -m "feat(shared): add arrApi module for Radarr/Sonarr integration"
```

---

### Task 3: Plugin Entry Point

**Files:**
- Create: `src/arrRename/index.js`
- Create: `src/arrRename/plugin.json`

- [ ] **Step 1: Create `src/arrRename/plugin.json`**

```json
{ "category": "file" }
```

- [ ] **Step 2: Create `src/arrRename/index.js`**

```js
// src/arrRename/index.js
'use strict';

const details = () => ({
  name: 'Arr Rename',
  description: [
    'Triggers Radarr/Sonarr to rename files according to their naming schemes.',
    'Place after the Replace Original node. Automatically detects which service',
    'owns the file by querying both APIs.',
  ].join(' '),
  style: { borderColor: 'green' },
  tags: 'radarr,sonarr,rename,arr',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.00.01',
  sidebarPosition: -1,
  icon: 'faFileSignature',
  inputs: [
    {
      label: 'Radarr URL',
      name: 'radarr_url',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Radarr base URL, e.g. http://radarr:7878. Leave empty to skip Radarr.',
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
      tooltip: 'Sonarr base URL, e.g. http://sonarr:8989. Leave empty to skip Sonarr.',
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
      tooltip: 'JSON array of "tdarrPath:arrPath" mappings, e.g. ["/media:/mnt/media"]. Leave empty if paths are the same.',
    },
    {
      label: 'Poll Timeout (s)',
      name: 'poll_timeout',
      type: 'number',
      defaultValue: '120',
      inputUI: { type: 'text' },
      tooltip: 'Max seconds to wait for Arr rescan/rename commands to complete.',
    },
  ],
  outputs: [
    { number: 1, tooltip: 'File renamed successfully by Radarr or Sonarr' },
    { number: 2, tooltip: 'No match found or no rename needed' },
  ],
});

const plugin = async (args) => {
  const { createPathMapper } = require('../shared/pathMapper');
  const {
    findRadarrMatch,
    findSonarrMatch,
    radarrRename,
    sonarrRename,
  } = require('../shared/arrApi');

  const inputs = args.inputs || {};
  const radarrUrl = (inputs.radarr_url || '').trim();
  const radarrKey = (inputs.radarr_api_key || '').trim();
  const sonarrUrl = (inputs.sonarr_url || '').trim();
  const sonarrKey = (inputs.sonarr_api_key || '').trim();
  const timeoutMs = (Number(inputs.poll_timeout) || 120) * 1000;

  const log = (msg) => {
    if (typeof args.jobLog === 'function') args.jobLog(msg);
    else console.log(`[ArrRename] ${msg}`);
  };

  const noChange = () => ({
    outputFileObj: args.inputFileObj,
    outputNumber: 2,
    variables: args.variables,
  });

  const hasRadarr = radarrUrl && radarrKey;
  const hasSonarr = sonarrUrl && sonarrKey;

  if (!hasRadarr && !hasSonarr) {
    log('No Radarr or Sonarr configured — skipping');
    return noChange();
  }

  const filePath = args.inputFileObj._id;
  log(`==== Arr Rename ====`);
  log(`Input file: ${filePath}`);

  let mapper;
  try {
    mapper = createPathMapper(inputs.path_mappings || '');
  } catch (err) {
    log(`Path mapping error: ${err.message}`);
    return noChange();
  }

  const arrPath = mapper.toArr(filePath);
  if (arrPath !== filePath) {
    log(`Arr-side path: ${arrPath}`);
  }

  try {
    // Try Radarr
    if (hasRadarr) {
      log('Searching Radarr...');
      const match = await findRadarrMatch(radarrUrl, radarrKey, arrPath);
      if (match) {
        log(`Matched movie: ${match.movie.title} (file id: ${match.movieFile.id})`);
        const newArrPath = await radarrRename(
          radarrUrl, radarrKey, match.movie, match.movieFile, timeoutMs, log,
        );
        const newPath = mapper.fromArr(newArrPath);
        log(`Renamed: ${newPath}`);
        args.inputFileObj._id = newPath;
        return {
          outputFileObj: args.inputFileObj,
          outputNumber: 1,
          variables: args.variables,
        };
      }
      log('No Radarr match');
    }

    // Try Sonarr
    if (hasSonarr) {
      log('Searching Sonarr...');
      const match = await findSonarrMatch(sonarrUrl, sonarrKey, arrPath);
      if (match) {
        log(`Matched series: ${match.series.title} (file id: ${match.episodeFile.id})`);
        const newArrPath = await sonarrRename(
          sonarrUrl, sonarrKey, match.series, match.episodeFile, timeoutMs, log,
        );
        const newPath = mapper.fromArr(newArrPath);
        log(`Renamed: ${newPath}`);
        args.inputFileObj._id = newPath;
        return {
          outputFileObj: args.inputFileObj,
          outputNumber: 1,
          variables: args.variables,
        };
      }
      log('No Sonarr match');
    }

    log('No Arr service matched this file');
    return noChange();

  } catch (err) {
    log(`Arr rename error: ${err.message}`);
    return noChange();
  }
};

module.exports = { details, plugin };
```

- [ ] **Step 3: Commit**

```bash
git add src/arrRename/index.js src/arrRename/plugin.json
git commit -m "feat(arrRename): add Arr Rename FlowPlugin entry point"
```

---

### Task 4: Update Build Script for Per-Plugin Categories

**Files:**
- Modify: `build.sh:46-64`

The build script currently hardcodes `video/` as the output category. We need it to read an optional `plugin.json` for a category override, defaulting to `video/`.

- [ ] **Step 1: Modify `build.sh`**

Replace the section that sets `out_dir` (lines 49-51):

```bash
  # Old:
  version="1.0.0"
  out_dir="${DIST_DIR}/video/${plugin_name}/${version}"
  mkdir -p "$out_dir"
```

With:

```bash
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
```

Also update the echo line (line 53) from:

```bash
  echo "  bundle: ${plugin_name} -> dist/LocalFlowPlugins/video/${plugin_name}/${version}/index.js"
```

To:

```bash
  echo "  bundle: ${plugin_name} -> dist/LocalFlowPlugins/${category}/${plugin_name}/${version}/index.js"
```

- [ ] **Step 2: Test the build**

Run: `npm run build`

Expected: all 4 plugins build successfully. `arrRename` should output to `dist/LocalFlowPlugins/file/arrRename/1.0.0/index.js`, encoders still go to `video/`.

- [ ] **Step 3: Verify output paths**

Run: `find dist/LocalFlowPlugins -name index.js | sort`

Expected:
```
dist/LocalFlowPlugins/file/arrRename/1.0.0/index.js
dist/LocalFlowPlugins/video/abAv1Encode/1.0.0/index.js
dist/LocalFlowPlugins/video/av1anEncode/1.0.0/index.js
dist/LocalFlowPlugins/video/crfSearchEncode/1.0.0/index.js
```

- [ ] **Step 4: Commit**

```bash
git add build.sh src/arrRename/plugin.json
git commit -m "feat(build): support per-plugin category via plugin.json"
```

---

### Task 5: Add to Smoke Tests

**Files:**
- Modify: `test/smoke.js:6`

- [ ] **Step 1: Add `arrRename` to `PLUGIN_NAMES`**

Change line 6 in `test/smoke.js` from:

```js
const PLUGIN_NAMES = ['av1anEncode', 'abAv1Encode'];
```

To:

```js
const PLUGIN_NAMES = ['av1anEncode', 'abAv1Encode', 'arrRename'];
```

- [ ] **Step 2: Deploy and run smoke test**

Run: `npm run deploy && npm run test:smoke`

Expected: all 3 plugins pass (name, requiresVersion, inputs, outputs checks).

- [ ] **Step 3: Commit**

```bash
git add test/smoke.js
git commit -m "test: add arrRename to smoke tests"
```

---

### Task 6: Integration Test — Verify `_id` Propagation

This is the key open question from the spec. We need to test whether setting `args.inputFileObj._id` in the plugin return is sufficient for Tdarr to track a file rename, or whether the `cruddb` fallback is needed.

**Files:**
- No new files — manual test against the running test container

- [ ] **Step 1: Deploy to test instance**

Run: `npm run deploy`

- [ ] **Step 2: Create a test flow in Tdarr UI**

In the Tdarr web UI at `http://localhost:8265`:
1. Create a new flow or modify an existing one
2. Add the Arr Rename plugin after Replace Original
3. Configure with Radarr/Sonarr URL + API key for the test instance
4. Set path mappings if needed for the test environment

- [ ] **Step 3: Run a file through the flow and verify**

1. Queue a file for processing
2. Watch the Tdarr job log for the `==== Arr Rename ====` output
3. Verify that Radarr/Sonarr renames the file
4. Check if Tdarr correctly tracks the renamed file (doesn't re-queue it, doesn't show it as missing)

- [ ] **Step 4: Document the result**

If `_id` propagation works: the spec's open question is resolved, no `cruddb` fallback needed.

If it doesn't work: add a Tdarr URL input and implement the `cruddb` DB update as a follow-up task, using the same pattern from the original `tdarr_rename.js` (lines 65-126).

---

### Task 7: Version Bump

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump version**

Ask the user whether this is a minor or patch bump (new plugin = likely minor).

Change version in `package.json` from current to the new version.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to <new-version>"
```

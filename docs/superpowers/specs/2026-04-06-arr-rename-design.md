# Arr Rename FlowPlugin Design

## Overview

A Tdarr FlowPlugin that triggers Radarr/Sonarr to rename files according to their built-in naming schemes after encoding. Placed after the "Replace Original" node in the flow — so the encoded file is already in its final location when Radarr/Sonarr rescans and renames it.

## Plugin Identity

- **Name:** Arr Rename
- **Category:** `file/arrRename`
- **Icon:** `faFileSignature`
- **Build output:** `dist/LocalFlowPlugins/file/arrRename/1.0.0/index.js`
- **Outputs:**
  - Output 1: File renamed successfully
  - Output 2: No match found or no rename needed (not an error)

## Inputs

| Input | Name | Type | Default | Required | Notes |
|---|---|---|---|---|---|
| Radarr URL | `radarr_url` | string | `` | No | e.g. `http://radarr:7878` |
| Radarr API Key | `radarr_api_key` | string | `` | No | Required if Radarr URL is set |
| Sonarr URL | `sonarr_url` | string | `` | No | e.g. `http://sonarr:8989` |
| Sonarr API Key | `sonarr_api_key` | string | `` | No | Required if Sonarr URL is set |
| Path Mappings | `path_mappings` | string | `` | No | JSON array: `["/media:/mnt/media"]` — Tdarr path : Arr path |
| Poll Timeout (s) | `poll_timeout` | number | `120` | No | Max seconds to wait for rescan/rename commands |

At least one of Radarr or Sonarr must be configured for the plugin to do anything.

Tdarr URL input is deferred — we will first test whether setting `args.inputFileObj._id` to the new path is sufficient for Tdarr to track the rename. If it is not, a Tdarr URL input will be added and the plugin will update the DB entry via the `cruddb` API as a fallback.

## Flow Logic

1. **Validate config** — at least one Arr service configured, otherwise exit output 2
2. **Apply path mappings** — translate `args.inputFileObj._id` from Tdarr's mount to the Arr's mount
3. **Try Radarr** (if configured):
   - `GET /api/v3/movie` — fetch all movies
   - Find the movie whose path matches the file's parent folder
   - `GET /api/v3/moviefile?movieId={id}` — find the exact file record matching the input path
   - `POST /api/v3/command` `RescanMovie` — poll until completed
   - `POST /api/v3/command` `RenameMovie` — poll until completed
   - `GET /api/v3/moviefile/{fileId}` — fetch updated file record to get new path
4. **Try Sonarr** (if configured, and Radarr didn't match):
   - `GET /api/v3/series` — fetch all series
   - Match by series folder (file path minus filename minus season folder)
   - `GET /api/v3/episodefile?seriesId={id}` — find the exact episode file
   - `POST /api/v3/command` `RefreshSeries` — poll until completed
   - `POST /api/v3/command` `RenameFiles` for the specific file ID — poll until completed
   - `GET /api/v3/episodefile/{fileId}` — fetch updated record for new path
5. **No match** — neither service claimed the file, exit output 2
6. **Update Tdarr** — reverse-map the new Arr path back to Tdarr's mount, set `args.inputFileObj._id`, exit output 1

Errors are logged but non-fatal. If a rename API call fails, the file still exists at its original path, so we exit output 2 rather than crashing the flow.

## Shared Modules

### `src/shared/arrApi.js`

Generic Arr API client and rename orchestration.

- `api(url, apiKey, options)` — fetch wrapper with `X-Api-Key` header, JSON response parsing, error handling
- `pollCommand(baseUrl, apiKey, commandId, label, timeoutMs)` — polls `GET /api/v3/command/{id}` every 3s until status is `completed`, `failed`, or timeout
- `findRadarrMatch(baseUrl, apiKey, filePath)` — queries all movies, finds one whose path matches the file's folder, then finds the specific movie file record. Returns `{ movie, movieFile }` or `null`
- `findSonarrMatch(baseUrl, apiKey, filePath)` — queries all series, matches by series folder, finds the specific episode file record. Returns `{ series, episodeFile }` or `null`
- `radarrRename(baseUrl, apiKey, movie, movieFile)` — executes RescanMovie + RenameMovie + fetches new path. Returns the new file path
- `sonarrRename(baseUrl, apiKey, series, episodeFile)` — executes RefreshSeries + RenameFiles + fetches new path. Returns the new file path

### `src/shared/pathMapper.js`

Bidirectional path translation between Tdarr and Arr mount points.

- `createPathMapper(mappingsJson)` — parses the JSON array of `"from:to"` strings
  - Returns `{ toArr(path), fromArr(path) }` — `toArr` translates Tdarr paths to Arr paths, `fromArr` does the reverse
  - If no mappings provided, both functions return the path unchanged

## Build Integration

The build script (`build.sh`) already discovers plugins by iterating directories under `src/` (skipping `shared/`). The new `src/arrRename/index.js` will be picked up automatically. The only change needed is that the build currently hardcodes the output category to `video/` — this needs to support `file/` for the new plugin.

Options:
- A convention file (e.g. `src/arrRename/plugin.json` with `{"category": "file"}`)
- Or a default of `video/` with an override mechanism

This will be resolved during implementation planning.

## Testing Plan

1. **Unit-testable shared modules** — `pathMapper` is pure logic, `arrApi` functions can be tested with mocked fetch
2. **Integration test against test container** — deploy to the tdarr-av1 test instance, run a flow that encodes a file, and verify the rename triggers correctly
3. **Test `_id` propagation** — specifically verify whether setting `args.inputFileObj._id` in the plugin return is sufficient for Tdarr to track the rename, or whether the `cruddb` fallback is needed

## Resolved Questions

- **Tdarr DB update:** `args.inputFileObj._id` propagation is sufficient. Tested 2026-04-06 against the interactive test container — Tdarr correctly tracks the new path in its DB. No `cruddb` fallback needed.
- **Build category:** Resolved via `plugin.json` with `{"category": "file"}`, read by `build.sh`.

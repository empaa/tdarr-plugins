# Plugin Test Automation

Test infrastructure for validating Tdarr FlowPlugins against a live test instance via the Tdarr REST API. Local-only — no CI integration.

## Overview

Two test levels:

- **Smoke test** — verifies plugins load in Tdarr with correct metadata (fast, no encoding)
- **E2E test** — creates temporary flows, encodes a sample file, validates output (slow, real encode)

Both talk to the Tdarr test instance (sibling repo `tdarr-av1`) over its REST API.

## File Structure

```
test/
  lib/tdarrApi.js        Thin wrapper around Tdarr REST API
  smoke.js               Plugin load/metadata verification
  e2e.js                 Flow creation, encode, output validation
  genSample.sh           Generates synthetic test clip if samples/ is empty

src/<pluginName>/
  e2e-tests.json         Array of test scenarios with input configurations
```

## Tdarr API Client

`test/lib/tdarrApi.js` — async module wrapping the endpoints we need. Base URL defaults to `http://localhost:8265`, configurable via `TDARR_URL` env var.

Methods:

| Method | Purpose |
|--------|---------|
| `searchFlowPlugins(type)` | List plugins by source ("Local" / "Community") |
| `cruddb(collection, mode, docID, obj)` | Generic CRUD for flows, libraries, files |
| `scanFile(libraryId, filePath)` | Scan a single file into a library |
| `requeueFile(fileId)` | Set file's TranscodeDecisionMaker to "Queued" |
| `getNodes()` | Get connected worker nodes and status |
| `syncPlugins()` | Push plugins from server to nodes |
| `pollJobStatus(fileId, timeout)` | Poll until job completes or times out |

All methods return parsed JSON. Errors throw with status code and response body.

## Smoke Test

`test/smoke.js` — fast validation that plugins registered correctly in Tdarr.

Steps:
1. Call `syncPlugins()` to ensure nodes have latest plugin files
2. Call `searchFlowPlugins("Local")` to get all local plugins
3. For each plugin (or a specified plugin), assert:
   - Plugin exists in the response
   - `name` is a non-empty string
   - `requiresVersion` is a valid version string
   - `inputs` array is present and non-empty
   - `outputs` array is present and non-empty
4. Print pass/fail per plugin, exit 1 on any failure

Accepts optional plugin name argument to test a single plugin.

## Sample File Generation

`test/genSample.sh` — creates a synthetic test clip only if `test/samples/` is empty.

- 5 seconds of SMPTE color bars + 1kHz tone
- 720p, h264 + aac in MKV container
- Output: `test/samples/synthetic.mkv`
- Requires `ffmpeg` on the host
- `test/samples/` is gitignored — never pushed to remote

If `test/samples/` already contains video files (e.g. a real sample for manual testing), the generator does nothing.

## E2E Test Scenarios

Each plugin defines its test scenarios in `src/<pluginName>/e2e-tests.json`:

```json
[
  {
    "name": "svt-av1 default",
    "inputs": {
      "encoder": "svt-av1",
      "target_vmaf": "93"
    }
  },
  {
    "name": "aomenc q28",
    "inputs": {
      "encoder": "aom",
      "target_vmaf": "93"
    }
  }
]
```

- `name` — label for test output (e.g. "av1anEncode: svt-av1 default")
- `inputs` — maps to the plugin's `inputsDB` in the flow node. Omitted inputs use plugin defaults.

The e2e runner discovers all `src/*/e2e-tests.json` files automatically.

## E2E Test Runner

`test/e2e.js` — runs test scenarios against live Tdarr. Accepts optional plugin name argument.

### Per scenario:

1. **Setup:**
   - Check `test/samples/` — if empty, run `genSample.sh`
   - Pick the first video file found
   - Copy sample to a temp working directory inside `test/output/` (must be accessible to the Tdarr container; original is preserved)

2. **Execute:**
   - Create a temp library via cruddb pointing at the temp dir
   - Create a minimal flow: `inputFile` -> `<plugin under test>` -> `replaceOriginalFile`
   - Plugin node gets `inputsDB` from the scenario's `inputs`
   - Assign flow to the library
   - Scan the temp file into the library
   - Queue for transcode
   - Poll job status with timeout (configurable, default ~5 min)

3. **Assert:**
   - Job completed successfully
   - Output file exists
   - Output is valid video (ffprobe exit 0)
   - Output video codec is AV1

4. **Teardown** (always, even on failure):
   - Delete temp flow
   - Delete temp library
   - Remove temp working directory

### Output:

```
smoke: av1anEncode .............. ok
smoke: abAv1Encode ............. ok
e2e:   av1anEncode: svt-av1 default ... ok (42s)
e2e:   av1anEncode: aomenc q28 ....... ok (58s)
e2e:   abAv1Encode: default .......... ok (51s)
```

Exit 0 if all pass, exit 1 with failure details.

## npm Scripts

| Command | Runs |
|---------|------|
| `npm test` | smoke + e2e, all plugins |
| `npm test -- <plugin>` | smoke + e2e, specified plugin only |
| `npm run test:smoke` | smoke only, all plugins |
| `npm run test:smoke -- <plugin>` | smoke only, specified plugin |
| `npm run test:e2e` | e2e only, all plugins |
| `npm run test:e2e -- <plugin>` | e2e only, specified plugin |

## Pre-merge Workflow

```
npm run deploy          # build + copy to test instance
npm test                # smoke + e2e against live Tdarr
# if green -> merge to main
```

## Prerequisites

- Tdarr test instance running (from sibling repo `tdarr-av1`)
- `ffmpeg` available on host (for sample generation)
- Plugins deployed via `npm run deploy`

## Sibling Coordination

The tdarr-av1 repo needs to generate the synthetic sample clip too. A message will be sent to the sibling inbox requesting this.

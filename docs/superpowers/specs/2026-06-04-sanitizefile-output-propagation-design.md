# sanitizeFile output propagation — design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)

## Problem

When `sanitizeFile` runs before an encoder in a Tdarr flow, it correctly remuxes a
cleaned MKV (best audio per language + filtered subtitles) but the encoded output
still contains **all original audio and subtitle tracks**.

### Evidence (job `asArvTWPg`, "The Lord of the Rings: Fellowship", on `10.0.0.3`)

Pulled the real job report via the Tdarr API (`search-job-reports` → `read-job-file`).

- Sanitizer ran correctly:
  - `Streams: 1 video, 6 audio, 56 sub, 0 image`
  - `Keeping: 1 audio, 8 subtitle`
  - `Running mkvmerge with 10 tracks...`
  - `Output: /temp/tdarr-workDir2-asArvTWPg/...FraMeSToR.sanitized.mkv`
- But the value the Sanitize node **returned** had `_id` = the **original** library path,
  not the `.sanitized.mkv`. The sanitized file appears exactly once in the 1471-line log
  (at creation) and is never read again — it was orphaned in `/temp`.
- Every downstream node ran on the original. The encoder logged
  `input : /mnt/media/movies/.../...FraMeSToR.mkv` and
  `[mux] muxing audio + subtitles from original via mkvmerge` → all 62 streams carried through.
- Across the whole job, every logged ffProbeData dump (including `av1-output.mkv`) showed the
  original `{video:1, audio:6, subtitle:56}` — the ffProbeData was never refreshed to 10 streams.

## Root cause

`src/sanitizeFile/index.js` success path:

```js
args.inputFileObj._id = outputPath;                          // points _id at sanitized file ✓
const scannedFile = await args.scanIndividualFile(scanArgs); // re-probe
return { outputFileObj: scannedFile, ... };                  // ✗ discards the repointed _id
```

`scanIndividualFile()` resolves the canonical record by `footprintId`/`file` and returns a
file object whose `_id` is the **original** library path — ignoring the `_id: outputPath`
passed in `scanArgs`. Returning `scannedFile` as `outputFileObj` therefore:

1. resets `_id` back to the original (sanitized file orphaned), and
2. never delivers fresh ffProbeData (it re-probed the original, which has 62 streams).

This was introduced by commit `01c3a28` ("re-probe file after remux so downstream gets fresh
ffProbeData"). The re-probe accomplishes nothing useful and breaks propagation; it is pure
liability. This is the 6th touch on this area (`3bff798`, `d9cfcd9`, `a51c258` revert,
`01c3a28`, `249bd25`), so we fix it deliberately rather than patch again.

## Fix

### Change 1 — `src/sanitizeFile/index.js`, success path only

Delete the `scanIndividualFile` re-probe (the `args.inputFileObj._id = outputPath` line,
`scanArgs`, `scanTypes`, the `scanIndividualFile` call, and the conditional return). Replace
with the proven pattern from `av1anEncode.js:303`:

```js
log(`Output: ${outputPath}`);
return {
  outputFileObj: Object.assign({}, args.inputFileObj, { _id: outputPath, file: outputPath }),
  outputNumber: 1,
  variables: args.variables,
};
```

- The encoder reads `file._id`, which is now the sanitized file → `mergeAudioVideo` muxes only
  the kept tracks.
- Tdarr re-scans the working file at each node boundary (observed in the log), so downstream
  ffProbeData refreshes for free when `file` points at the sanitized output. No explicit probe.
- The "already clean" path (`outputNumber: 2`) is unchanged — it returns `args.inputFileObj`
  with no new file, which is correct.

Why setting `file` to a `/temp` path is safe: `av1anEncode` does exactly this and the flow
completed correctly — "Replace Original" resolves the true library destination via
`footprintId`/`DB`, not the `file` field.

### Change 2 — regression test (`--unit` mode, no live Tdarr required)

- Add `test/unit.js` exporting `unitTest(filter)`; wire a `--unit` mode into `test/run.js`
  (alongside `--smoke` / `--e2e`) and add a `"test:unit": "node test/run.js --unit"` script to
  `package.json`. Unit tests must run with **no** Tdarr server.
- First test exercises the real `sanitizeFile.plugin(args)`:
  - `inputFileObj` with `ffProbeData.streams` = 1 video + several audio (first audio
    `tags.language = 'eng'`, plus non-eng) + several subs, `_id`/`file` = an original path,
    plus `footprintId`/`DB`.
  - `args.workDir` = a real temp dir.
  - Stub `../shared/processManager` (via `require.cache` injection before requiring the plugin)
    so `createProcessManager` returns a fake `pm` whose `spawnAsync(bin, mkvArgs)` writes the
    `-o <outputPath>` file and returns `0`, with no-op `cleanup`/`installCancelHandler`.
  - `args.scanIndividualFile` mock that returns `{ _id: <original path> }` — present on purpose,
    to prove the result no longer depends on it.
  - Assert: `result.outputNumber === 1` **and**
    `result.outputFileObj._id === <workDir>/<name>.sanitized.mkv` (not the original).
- This test fails against current code and passes after Change 1.

## Behavior changes / risks

- Between the Sanitize and Rename nodes the working file's name carries `.sanitized` and lives
  in `/temp`. The HQ router (`av1an_hq_filter`, `includeFileDirectory:false`) matches on the
  basename, which still contains the quality tag; the final `[AV1]` filename is produced by the
  Rename node via `footprintId`, so `.sanitized` never reaches the library. Low risk, but real.

## Out of scope

- **Deploy to `10.0.0.3`:** `build.sh --deploy` targets the sibling test instance, not
  `10.0.0.3`. Deploying the rebuilt bundle to `10.0.0.3` is a manual step owned by the user.
- **Already-affected files:** ~35 AV1 files retain extra audio, ~2549 retain extra subtitles.
  Their originals were replaced by the bloated AV1 outputs. Remediation (re-acquire source, or a
  track-strip pass over the existing AV1s) is a separate effort.

## Verification

- `npm run test:unit` (new) passes; the new test fails if reverted to the old return.
- Manual: rebuild, deploy to `10.0.0.3`, run a multi-track file through the flow, confirm the
  output has only the kept audio/subtitle tracks and the encoder log shows
  `input : /temp/...sanitized.mkv`.

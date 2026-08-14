# Deprecate the legacy encoders, refocus on xav — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire `av1anEncode`, `abAv1Encode` and `crfSearchEncode`, leaving a repo that ships
only what is actually maintained — the two xav encoders, `sanitizeFile` and `arrRename` — and
credits xav's author properly.

**Architecture:** Pure subtraction plus a rename. The three legacy plugins are the only users
of five shared modules, so removing them removes roughly half the `src/shared/` surface and a
large share of the test suite. Nothing is rewritten; nothing new is built.

**Tech Stack:** Node 18+, esbuild bundling via `build.sh`, plain-Node test runner (`test/run.js`).

**Spec:** No separate spec. The driver is the sibling's deprecation notice,
`~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-plugins/inbox/processed/2026-08-14-from-tdarr-av1-project-deprecated-images-frozen.md`,
plus Emil's instruction on 2026-08-14 to "deprecate the legacy plugins on our side and push
focus on xav … and give proper credit to xav author".

## Why now

`tdarr-av1` is deprecated and its images are frozen. Production is moving to official
`ghcr.io/haveagitgat` images. The sibling verified against `tdarr_node:latest`:

| present upstream | absent upstream |
|---|---|
| `ffmpeg`, `ffprobe`, `mkvmerge`, `script` | `vspipe`, `av1an`, `ab-av1`, the libvmaf model JSON |

So `av1anEncode`, `abAv1Encode` and `crfSearchEncode` **cannot run on the images production is
moving to**, and Emil has confirmed no production flow still uses them. The xav plugins,
`sanitizeFile` and `arrRename` are unaffected.

## Global Constraints

- **Node 18+**; no new runtime dependencies. Plugins stay self-contained single files.
- **Never `git add .` or `-A`** — stage explicit paths ([[git-staging-safety]]).
- **Never stage `test/samples/` or `test/output/`** — gitignored, and `test/samples/` holds
  ~24 GB.
- **Merge `dev` → `main` via PR**, always. Bump `package.json` **before** merging or the
  release workflow retags an existing version.
- Full suite must stay green: `npm test` → the unit count must not drop below the count of
  tests that survive removal (see Task 5).
- xav's author is **`emrakyz`**, upstream <https://github.com/emrakyz/xav>. Deployed binaries
  were built from **`6896aeb`**. Do not paraphrase these; they are verified.

---

## Decisions needed before Task 6 (ask Emil)

Tasks 1–5 are safe under either answer. Do not start Task 6 until these are settled.

### D1 — Rename the project to `tdarr-xav`?

Emil said "perhaps". **Recommendation: rename the GitHub repo and the npm package name, but
NOT the local directory.**

Renaming the GitHub repo is cheap: GitHub redirects the old URL, and `git remote` keeps
working. Renaming the **local directory** is not cheap, and the cost is invisible until it
bites:

- Claude's memory, inbox and agent-runs are keyed by path —
  `~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-plugins/`. Renaming the directory
  orphans all of it, including the gating facts in `memory/`.
- The MemPalace wing is `tdarr-plugins`.
- `CLAUDE.md` hardcodes those paths in two places (lines ~52, ~79).

Decoupling them gets the benefit without the risk. If Emil wants the local directory renamed
too, that is a separate chore: move the `~/.claude/projects/…` directory alongside it and
update `CLAUDE.md`, and expect the MemPalace wing to need remapping.

### D2 — Delete the legacy plugins, or keep them marked deprecated?

**Recommendation: delete.** They cannot run on the target images, nothing uses them, and git
history keeps them recoverable. Marking them deprecated leaves ~1,400 lines of source and five
shared modules that no test exercises and no one maintains — the state that let five bugs hide
in the xav path.

If Emil prefers to keep them: skip Tasks 3–5, and instead add `"DEPRECATED — requires the
frozen empaa images"` to the front of each plugin's `description` in `details()`. That is a
one-task change and the rest of the plan still applies.

### D3 — Version number

**Recommendation: `3.0.0`.** Removing plugins is breaking for anyone whose flows reference
them. Note `dev` is currently 4 commits ahead of `origin/main` with docs-only changes that
have never been released; they ride along with this.

---

## File Structure

**Deleted** (assuming D2 = delete):

| path | lines | why |
|---|---|---|
| `src/av1anEncode/` (incl. `e2e-tests.json`) | 477 | cannot run upstream |
| `src/abAv1Encode/` | 255 | cannot run upstream |
| `src/crfSearchEncode/` | 651 | cannot run upstream |
| `src/shared/downscale.js` | — | used **only** by the three |
| `src/shared/encoderFlags.js` | — | used **only** by the three |
| `src/shared/mezzanine.js` | — | used **only** by av1an + crfSearch |
| `src/shared/progressTracker.js` | — | used **only** by the three |
| `src/shared/vsSource.js` | — | used **only** by av1an + crfSearch |
| `tools/validate-scoped-runup.sh` | — | exists solely to gate `vsSource` changes |
| `tools/gen-vpy.js` | — | generates VapourSynth scripts for `vsSource` |
| `test/benchmark.js` | — | thread-strategy benchmark for av1an/ab-av1 |

**Kept** — verified still in use:

| module | used by |
|---|---|
| `shared/xav.js` | xavEncode, xavPipeEncode |
| `shared/audioMerge.js` | xavEncode, xavPipeEncode (also the deleted three) |
| `shared/processManager.js` | all survivors |
| `shared/logger.js` | xavEncode, xavPipeEncode |
| `shared/arrApi.js`, `shared/pathMapper.js` | sanitizeFile, arrRename |

**Modified:** `README.md`, `package.json`, `CLAUDE.md`, `.github/workflows/release.yml`,
`test/unit.js`, `test/smoke.js`, `test/e2e.js`.

`build.sh` needs **no change** — it discovers plugins by iterating `src/*/` (line 40), so
deleting a directory removes it from the build automatically. Verify this rather than assume.

---

### Task 1: Credit emrakyz and xav properly

Safe under every decision above; do it first so the credit lands even if the rest stalls.

**Files:**
- Modify: `README.md:1-3` (header), and the `### AV1 Encode (xav)` section
- Modify: `src/xavEncode/index.js` — `details().description`
- Modify: `src/xavPipeEncode/index.js` — `details().description`

- [ ] **Step 1: Rewrite the README header to credit xav**

Replace lines 1–3 with:

```markdown
# tdarr-plugins

AV1 encoding FlowPlugins for [Tdarr](https://tdarr.io), built on
**[xav](https://github.com/emrakyz/xav) by [emrakyz](https://github.com/emrakyz)** — a
scene-chunked AV1 encoder with a built-in SSIMULACRA2 target-quality search. These plugins are
a Tdarr integration around xav; the encoder, its chunking, its metric search and the hard parts
are emrakyz's work.
```

- [ ] **Step 2: Add an attribution section near the top of the xav plugin docs**

Insert immediately after the `### AV1 Encode (xav)` heading:

```markdown
> **Upstream:** [emrakyz/xav](https://github.com/emrakyz/xav). The binaries in production were
> built from `6896aeb`. This repo contains no encoder code — see
> [`tools/xav-build/`](tools/xav-build/) for the build container.
```

- [ ] **Step 3: Credit xav in both plugin descriptions**

In `src/xavEncode/index.js`, the first line of the `description` array is currently
`'Encodes video to AV1 using xav with per-scene SSIMULACRA2 target-quality search.'`. Change to:

```js
    'Encodes video to AV1 using xav (github.com/emrakyz/xav) with per-scene SSIMULACRA2',
    'target-quality search.',
```

Make the equivalent change in `src/xavPipeEncode/index.js`, whose first line is
`'Downscales with ffmpeg and pipes Y4M into xav for AV1 encoding.'`:

```js
    'Downscales with ffmpeg and pipes Y4M into xav (github.com/emrakyz/xav) for AV1 encoding.',
```

- [ ] **Step 4: Verify the plugin metadata still loads**

Run: `npm run build && npm test 2>&1 | grep -c "\.\.\. ok"`
Expected: build succeeds, unit count unchanged (60 at time of writing).

- [ ] **Step 5: Commit**

```bash
git add README.md src/xavEncode/index.js src/xavPipeEncode/index.js
git commit -m "docs: credit emrakyz/xav as the encoder these plugins wrap"
```

---

### Task 2: Prove the three legacy plugins are genuinely unused

Do not delete on the strength of a claim. Confirm it, and record the evidence in the commit.

**Files:** none modified — this task produces evidence only.

- [ ] **Step 1: Confirm no production flow references them**

```bash
curl -s -m 20 -X POST http://10.0.0.3:8265/api/v2/cruddb \
  -H 'Content-Type: application/json' \
  -d '{"data":{"collection":"FlowsJSONDB","mode":"getAll"}}' -o /tmp/prodflows.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/prodflows.json'))
for f in d:
    for n in (f.get('flowPlugins') or []):
        if n.get('pluginName') in ('av1anEncode','abAv1Encode','crfSearchEncode'):
            print('STILL IN USE:', f.get('name'), n.get('pluginName'))
print('flows checked:', len(d))
PY
```

Expected: no `STILL IN USE` lines. **If any appear, stop and tell Emil** — the premise is
wrong and the plan needs revisiting.

- [ ] **Step 2: Confirm the shared-module ownership map still holds**

```bash
for m in downscale encoderFlags mezzanine progressTracker vsSource audioMerge logger \
         processManager arrApi pathMapper xav; do
  printf "%-16s -> " "$m"
  grep -l "shared/$m'" src/*/index.js | xargs -n1 dirname | xargs -n1 basename | tr '\n' ' '
  echo
done
```

Expected: `downscale`, `encoderFlags`, `mezzanine`, `progressTracker`, `vsSource` list **only**
`av1anEncode`, `abAv1Encode`, `crfSearchEncode`. If any survivor appears against those, that
module must be kept — adjust Task 4.

---

### Task 3: Delete the three plugins

**Files:**
- Delete: `src/av1anEncode/`, `src/abAv1Encode/`, `src/crfSearchEncode/`

- [ ] **Step 1: Delete the plugin directories**

```bash
git rm -r src/av1anEncode src/abAv1Encode src/crfSearchEncode
```

- [ ] **Step 2: Verify build.sh drops them without modification**

Run: `npm run build`
Expected: `Built 4 plugin(s)` — xavEncode, xavPipeEncode, sanitizeFile, arrRename.
If it still reports 7, `build.sh` has a hardcoded list after all; find it near line 40 and
remove the three entries.

- [ ] **Step 3: Confirm the dist tree**

```bash
find dist/LocalFlowPlugins -name index.js | sort
```

Expected exactly:
```
dist/LocalFlowPlugins/file/arrRename/1.0.0/index.js
dist/LocalFlowPlugins/video/sanitizeFile/1.0.0/index.js
dist/LocalFlowPlugins/video/xavEncode/1.0.0/index.js
dist/LocalFlowPlugins/video/xavPipeEncode/1.0.0/index.js
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat!: remove av1anEncode, abAv1Encode, crfSearchEncode

They require av1an, ab-av1, vspipe and the libvmaf model. Upstream Tdarr
images ship none of those, production is moving to upstream images, and no
production flow references them (verified against FlowsJSONDB). Recoverable
from git history if ever needed."
```

---

### Task 4: Delete the five now-orphaned shared modules and their tooling

**Files:**
- Delete: `src/shared/{downscale,encoderFlags,mezzanine,progressTracker,vsSource}.js`
- Delete: `tools/validate-scoped-runup.sh`, `tools/gen-vpy.js`, `test/benchmark.js`
- Modify: `package.json` — remove the `benchmark` script

- [ ] **Step 1: Delete them**

```bash
git rm src/shared/downscale.js src/shared/encoderFlags.js src/shared/mezzanine.js \
       src/shared/progressTracker.js src/shared/vsSource.js \
       tools/validate-scoped-runup.sh tools/gen-vpy.js test/benchmark.js
```

- [ ] **Step 2: Remove the now-dangling npm script**

In `package.json`, delete the `"benchmark"` line from `scripts`.

- [ ] **Step 3: Verify nothing still imports them**

```bash
grep -rn "downscale\|encoderFlags\|mezzanine\|progressTracker\|vsSource" src/ tools/ \
  --include=*.js | grep -v node_modules
```

Expected: no output. Any hit is a real dependency the map missed — restore that module.

- [ ] **Step 4: Build must still succeed**

Run: `npm run build`
Expected: `Built 4 plugin(s)`, no unresolved-import errors.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "chore: drop shared modules orphaned by the legacy plugin removal

downscale, encoderFlags, mezzanine, progressTracker and vsSource had no
consumer left. vsSource going means the lsmas cold-seek grey-frame code is now
historical -- its gate (tools/validate-scoped-runup.sh) and generator
(tools/gen-vpy.js) go with it."
```

> **Note for the executor:** deleting `vsSource` retires the entire grey-frame/lsmas
> cold-seek saga. The memory `lsmas-coldseek-runup` calls
> `tools/validate-scoped-runup.sh` a mandatory gate — that becomes false here. Task 9 updates it.

---

### Task 5: Prune the test suite

Deleting the modules breaks `test/unit.js`, which references `vsSource` 47 times, `mezzanine`
13, `downscale` 10, `encoderFlags` 4.

**Files:**
- Modify: `test/unit.js`, `test/smoke.js`, `test/e2e.js`

- [ ] **Step 1: See the damage**

Run: `npm test 2>&1 | tail -20`
Expected: failures — `Cannot find module '../src/shared/vsSource'` or similar.

- [ ] **Step 2: Record the surviving baseline**

Before editing, note the current count so the target is explicit:

```bash
git stash && npm test 2>&1 | grep -c "\.\.\. ok" && git stash pop
```

At time of writing the suite is **60 passing**. Tests for the five deleted modules go with
them; the xav, sanitizeFile, arrRename, audioMerge, processManager and logger tests must all
survive. **If a test for a surviving module fails, that is a real regression — fix it, do not
delete it.**

- [ ] **Step 3: Remove the dead test functions and their registry entries**

In `test/unit.js`, delete every test whose subject is one of the five modules, and its entry in
the test-list array. Search for `vsSource:`, `mezzanine`, `downscale`, `encoderFlags`,
`av1an`, `abAv1`, `crfSearch` in test names.

- [ ] **Step 4: Prune smoke and e2e references**

```bash
grep -n "av1anEncode\|abAv1Encode\|crfSearchEncode" test/smoke.js test/e2e.js test/lib/*.js
```

Remove the matching entries. `test/smoke.js` validates plugin metadata by iterating built
plugins, so it may need nothing.

- [ ] **Step 5: Suite green**

Run: `npm test 2>&1 | grep -c "\.\.\. FAIL"`
Expected: `0`. Then record the new passing count in the commit message.

- [ ] **Step 6: Commit**

```bash
git add test/
git commit -m "test: drop coverage for the removed plugins and shared modules

<N> passing, down from 60. Every remaining test belongs to a shipped plugin."
```

---

### Task 6: Rewrite the README around the four shipped plugins

**Blocked on D1.** Do not start until the rename question is answered.

**Files:** Modify `README.md`

- [ ] **Step 1: Delete the Performance Tuning chapter**

Lines ~80–181 (`## Performance Tuning` through the end of `### Finding Your Optimal Config`)
are entirely av1an/ab-av1 thread-strategy material — presets, SVT thread limits, custom
overrides, the benchmark grid. All of it describes deleted plugins. Delete the whole chapter,
including its links from the plugin tables.

- [ ] **Step 2: Delete the two legacy plugin sections**

`### AV1 Encode (av1an)` and `### AV1 Encode (ab-av1)`.

- [ ] **Step 3: Document sanitizeFile and arrRename**

They ship and are maintained but have never been documented. Add a section for each, in the
same table format as the xav section, listing their inputs from
`src/sanitizeFile/index.js` and `src/arrRename/index.js` `details().inputs`.

- [ ] **Step 4: Fix the Install section**

The "Which plugins run where" subsection added on 2026-08-14 explains a distinction that no
longer exists once the legacy plugins are gone. Replace with a single statement that all four
plugins run on stock upstream Tdarr images, with xav additionally needing its binary mounted
and GPU access.

- [ ] **Step 5: Apply the rename, if D1 said yes**

```bash
sed -i 's|empaa/tdarr-plugins|empaa/tdarr-xav|g' README.md
sed -i 's|"name": "tdarr-plugins"|"name": "tdarr-xav"|' package.json package-lock.json
sed -i 's|tdarr-plugins-v|tdarr-xav-v|g' .github/workflows/release.yml
```

Then rename the GitHub repo in Settings, and note in the README that the old name redirects.
**Do not rename the local directory** — see D1.

- [ ] **Step 6: Verify no stale references**

```bash
grep -rn "av1anEncode\|abAv1Encode\|crfSearchEncode\|Thread Strategy" README.md
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add README.md package.json package-lock.json .github/workflows/release.yml
git commit -m "docs: README covers only the four plugins we actually ship"
```

---

### Task 7: Mark the historical docs rather than deleting them

`docs/` holds real measurement work about the removed plugins — 19 files reference
`av1anEncode` alone. That evidence is still true and was expensive to produce; it just no
longer describes shipped code.

**Files:** Modify the affected files in `docs/`

- [ ] **Step 1: List them**

```bash
grep -rl "av1anEncode\|abAv1Encode\|crfSearchEncode\|vsSource" docs/ | sort
```

- [ ] **Step 2: Add a banner to each, immediately under its H1**

```markdown
> **HISTORICAL (2026-08-14).** Describes plugins removed in v3.0.0 — av1anEncode,
> abAv1Encode, crfSearchEncode — and/or the `vsSource` VapourSynth path that went with them.
> The measurements are still valid; the code they describe is no longer shipped. Kept because
> the reasoning is reusable.
```

Do **not** edit `docs/tier-validation-2026-08-13.md`, `docs/encoder-recommendations.md` or
anything under `docs/data/` that describes xav — those remain current.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: mark the legacy-plugin research historical, not wrong"
```

---

### Task 8: Release v3.0.0

**Files:** Modify `package.json`

- [ ] **Step 1: Bump**

```bash
npm version 3.0.0 --no-git-tag-version
```

- [ ] **Step 2: Final gate**

```bash
npm run build && npm test 2>&1 | grep -c "\.\.\. FAIL"
```
Expected: `Built 4 plugin(s)` and `0`.

- [ ] **Step 3: Commit, PR, merge**

```bash
git add package.json package-lock.json
git commit -m "chore: 3.0.0 -- legacy encoders removed"
git push origin dev
gh pr create --base main --head dev --title "v3.0.0 - retire the legacy encoders, focus on xav" --body "<summary>"
gh pr merge <N> --merge
```

- [ ] **Step 4: Verify the release artifact**

Wait for the workflow, then **download and inspect it** rather than trusting the build:

```bash
gh release download v3.0.0 --pattern '*.zip' --clobber -D /tmp/rel
unzip -q -o /tmp/rel/*.zip -d /tmp/rel && find /tmp/rel/LocalFlowPlugins -name index.js
```
Expected: exactly the four plugins.

---

### Task 9: Update memory, MemPalace and the sibling

**Files:**
- Modify: `~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-plugins/memory/{MEMORY.md,project-status.md,lsmas-coldseek-runup.md}`
- Create: `~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-av1/inbox/2026-XX-XX-from-tdarr-plugins-legacy-plugins-retired.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Retire the now-false gating fact**

`memory/lsmas-coldseek-runup.md` says to gate any `vsSource`/stack change with
`tools/validate-scoped-runup.sh`. Both are deleted. Either delete the memory or rewrite it as
historical — a gating fact that points at a missing file is worse than none.

- [ ] **Step 2: Update `project-status.md` and the `MEMORY.md` index line**

Four plugins, v3.0.0, legacy encoders retired.

- [ ] **Step 3: Update `CLAUDE.md`**

Its "What is this?" section names av1anEncode and abAv1Encode as the two plugins, and the
Sibling Protocol section describes `../tdarr-av1` as an active sibling. Both are now wrong.
Consider the `claude-md-management:revise-claude-md` skill.

- [ ] **Step 4: Tell the sibling**

Their deprecation notice asked us to decide on the three plugins. Close the loop: they are
removed as of v3.0.0, and this repo now ships four plugins that all run on upstream images.

- [ ] **Step 5: MemPalace diary entry**

One `mempalace_diary_write` recording the decision and its rationale.

---

## Self-Review

**Spec coverage.** Emil's four asks: deprecate legacy plugins (Tasks 2–5), focus on the
maintained set (Tasks 5–6), rename to `tdarr-xav` (Task 6 Step 5, gated on D1), credit the xav
author (Task 1). All covered.

**Placeholders.** One deliberate: Task 8's PR body is `<summary>`, written at execution time
from the actual diff. Task 5 Step 6 carries `<N>` because the surviving test count cannot be
known until the deletions are made — Step 2 establishes the baseline to compare against.

**Consistency.** Module names in Task 4 match the verified map from Task 2 Step 2. Plugin
directory names match `src/`. Test counts (60 passing) and reference counts (vsSource 47,
mezzanine 13, downscale 10, encoderFlags 4) were measured on 2026-08-14 — re-measure rather
than trust them if time has passed.

**Risk worth naming.** Task 3 is irreversible in the working tree but not in history. The
single check that matters is Task 2 Step 1: if any production flow still references the three
plugins, the whole premise collapses. Do that step first and do not skip it.

# sanitizeFile commentary-track handling — design

**Date:** 2026-06-04
**Status:** Implemented + verified

## Verification results

- `npm run test:unit`: 6/6 pass (RED→GREEN), incl. Oldboy off/on, subtitle off/on, and the
  detection guard (title/flag yes; SDH/forced no).
- Live test instance, Input → Sanitize → Replace on a synthetic clip with a `Main Audio` + a
  `Commentary by director` track (default option OFF): output kept **Main Audio only**.

## Goal

Add a `keep_commentary_tracks` option to the Sanitize node. By default, drop commentary
audio/subtitle tracks, fixing multi-commentary discs (e.g. Oldboy) where a commentary in a
wanted language was kept as if it were a real track.

## Background

`sanitizeFile` selects audio "best per wanted language" and subtitles "all wanted-language",
where wanted = original language (Radarr/Sonarr) + configured additional languages. It does not
distinguish commentary tracks, so a wanted language whose only tracks are commentaries keeps a
commentary. Example — Oldboy (original `kor`; `audio_language = eng,swe,nor,nob`) has 1 Korean
main DTS-HD MA + 5 Korean commentaries + 2 English commentaries; today it keeps the Korean main
**plus one English commentary**.

## Decisions (from brainstorming)

- New boolean input `keep_commentary_tracks`, **default OFF**.
- **Commentary detection:** `disposition.comment === 1` OR title matches `/commentary/i`. SDH
  (`hearing_impaired`) and forced (`forced`) are **not** commentary.
- **Scope:** audio **and** subtitles.
- **Original-language always-keep applies to MAIN (non-commentary) tracks only.** Commentary
  tracks are governed solely by the additional-languages list (`audio_language` / `subs_language`);
  the original language is **not** auto-added for commentaries.

## Selection rules

Per stream type, with `configuredLangs` = `audio_language` (audio) or `subs_language` (subs):

- `mainWanted = [originalLang, ...configuredLangs]`
- `commentaryWanted = configuredLangs`  (original NOT added)

**Audio (`selectAudio`):**
- Split into `main` (non-commentary) and `commentary` tracks.
- For each lang in `mainWanted`, keep the best **main** track (highest channels, then codec rank) —
  the existing best-per-language logic, restricted to main tracks.
- If `keep_commentary_tracks`: append every **commentary** track whose lang ∈ `commentaryWanted`,
  in input order.
- Output order: video → [main audio in `mainWanted` order, then kept commentaries] → subtitles.
- Safety: if there is ≤1 audio track total, keep it; if the final selection is empty (no main
  track in any wanted language — pathological for a real film, since the original-language main is
  always wanted) fall back to keeping all audio rather than emit an audio-less file. This whole-file
  guard does not override the per-language rule (a wanted language with only commentaries still
  keeps nothing).

**Subtitles (`selectSubtitles`):**
- Keep all **non-commentary** subs with lang ∈ `{originalLang} ∪ subs_language` (as today).
- If `keep_commentary_tracks`: also keep **commentary** subs with lang ∈ `subs_language`
  (not original).
- Subtitles may legitimately end up empty.

**Oldboy outcomes** (original `kor`; `audio_language = eng,swe,nor,nob`):
- **OFF →** Korean main only (1 audio). All 7 commentaries dropped.
- **ON →** Korean main + the 2 English commentaries (3 audio). The 5 Korean commentaries are
  dropped because `kor` ∉ `audio_language` and original-keep doesn't extend to commentaries.

## Commentary detection helper

```js
const isCommentary = (s) =>
  (s.disposition && s.disposition.comment === 1)
  || /commentary/i.test((s.tags && s.tags.title) || '');
```

Applied to audio and subtitle streams; surfaced as a `commentary` boolean on the track objects
built in `categorizeStreams` so the selection functions don't re-derive it.

## "Already clean" check

Unchanged. With the option OFF, a file carrying commentaries no longer matches as clean
(`selectedAudio`/`selectedSubs` < all), so it remuxes. No special handling needed.

## Files changed

- `src/sanitizeFile/index.js`: add `isCommentary`; add a `commentary` flag in `categorizeStreams`;
  extend `selectAudio` and `selectSubtitles` with a `keepCommentary` arg and the split logic; add
  the `keep_commentary_tracks` switch to `details().inputs`; read `inputs.keep_commentary_tracks`
  and thread it through.

## Testing (`--unit`, no live Tdarr)

- Oldboy-style multi-commentary file, option **OFF** → main only.
- Same, option **ON** → main + additional-language commentaries; original-language commentaries
  dropped.
- Subtitle commentary: OFF drops commentary subs; ON keeps `subs_language` commentary subs.
- Detection: an untagged `"Commentary by …"` title is detected; a `comment`-disposition track is
  detected; SDH (`hearing_impaired`) and forced tracks are **not** treated as commentary.
- Original-language main is always kept regardless of `audio_language`; an original-language
  commentary is dropped unless the original language is also in `audio_language`.

## Version

Feature → **2.1.0**.

## Out of scope

Re-running the existing library through this (to retroactively strip commentaries) is an
operational follow-up, not part of this change.

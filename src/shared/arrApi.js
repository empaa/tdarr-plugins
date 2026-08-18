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
 * Poll a Radarr/Sonarr command until it resolves.
 * @returns {string} 'completed', or 'timeout' if the window ran out
 * @throws if the command reports failure
 */
async function pollCommand(baseUrl, apiKey, commandId, label, timeoutMs, log, opts = {}) {
  const intervalMs = opts.intervalMs || 3000;
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const cmd = await arrFetch(`${baseUrl}/api/v3/command/${commandId}`, apiKey);
    if (cmd.status !== last) {
      log(`${label}: ${cmd.status}`);
      last = cmd.status;
    }
    if (cmd.status === 'completed') return 'completed';
    if (cmd.status === 'failed') throw new Error(`${label} command failed`);
  }
  log(`${label}: still "${last || 'unknown'}" after ${Math.round(timeoutMs / 1000)}s`);
  return 'timeout';
}

/**
 * Wait for a rename to actually land, and return the path it landed on.
 *
 * Command status is advisory only. Radarr/Sonarr can hold a rename in "queued"
 * for minutes behind another command, and a queued command still renames the
 * file once it runs -- so the FILE RECORD, not the queue, decides. A completed
 * command with an unchanged path is the legitimate no-op: the name already
 * matches the naming scheme.
 *
 * Never report a path the rename has not been confirmed against. Tdarr stores
 * whatever we return; if the Arr renames the file afterwards, Tdarr's DB points
 * at a path that no longer exists and the next library scan files the renamed
 * file as a new one -- re-queueing an already-encoded file (job ctkumSFxY,
 * Balls Up 2026, 2026-08-17).
 *
 * @param {Function} opts.readPath - resolves the file's current path, or null
 * @returns {string} the confirmed path (unchanged only when the command completed)
 */
async function waitForRename(opts) {
  const {
    baseUrl, apiKey, readPath, commandId, label, beforePath, timeoutMs, log,
  } = opts;
  const intervalMs = opts.intervalMs || 3000;
  const start = Date.now();
  let lastStatus = '';
  let nextHeartbeat = 30000;

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const current = await readPath();
    if (current && current !== beforePath) {
      log(`${label}: confirmed, file record now at ${current}`);
      return current;
    }

    const cmd = await arrFetch(`${baseUrl}/api/v3/command/${commandId}`, apiKey);
    if (cmd.status !== lastStatus) {
      log(`${label}: ${cmd.status}`);
      lastStatus = cmd.status;
    }
    if (cmd.status === 'failed') throw new Error(`${label} command failed`);
    if (cmd.status === 'completed') {
      // The command updates the record before reporting completion, but read
      // once more so a same-tick ordering cannot cost us the new path.
      const settled = await readPath();
      if (settled && settled !== beforePath) {
        log(`${label}: confirmed, file record now at ${settled}`);
        return settled;
      }
      log(`${label}: completed with no rename needed -- the name already matches the naming scheme`);
      return beforePath;
    }

    const elapsed = Date.now() - start;
    if (elapsed >= nextHeartbeat) {
      log(`${label}: still "${lastStatus}" after ${Math.round(elapsed / 1000)}s, waiting`);
      nextHeartbeat = elapsed + 30000;
    }
  }

  throw new Error(
    `${label} was never confirmed within ${Math.round(timeoutMs / 1000)}s `
    + `(last status: ${lastStatus || 'unknown'}; file still at ${beforePath}). `
    + 'Refusing to report an unrenamed path: Tdarr would store a path the Arr is '
    + 'about to change, then rescan the renamed file as a new one.',
  );
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
async function findSonarrMatch(baseUrl, apiKey, arrPath, log) {
  const parts = arrPath.split('/');
  parts.pop(); // filename
  parts.pop(); // season folder
  const seriesFolder = parts.join('/');

  const seriesList = await arrFetch(`${baseUrl}/api/v3/series`, apiKey);

  if (log) log(`Sonarr: comparing folder "${seriesFolder}" against ${seriesList.length} series`);

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
 * @returns {string} confirmed file path (Arr-side)
 */
async function radarrRename(baseUrl, apiKey, movie, movieFile, timeoutMs, log, opts = {}) {
  log(`Calling RescanMovie for "${movie.title}" (id: ${movie.id})...`);
  const rescanCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ name: 'RescanMovie', movieId: movie.id }),
  });
  await pollCommand(baseUrl, apiKey, rescanCmd.id, 'RescanMovie', timeoutMs, log, opts);

  // A rescan can replace the movieFile row outright. A movie holds one file, so
  // fall back to whatever file it holds now rather than tracking a dead id.
  const readPath = async () => {
    const f = await arrFetch(`${baseUrl}/api/v3/moviefile/${movieFile.id}`, apiKey)
      .catch(() => null);
    if (f && f.path) return f.path;
    const files = await arrFetch(`${baseUrl}/api/v3/moviefile?movieId=${movie.id}`, apiKey)
      .catch(() => []);
    return files.length === 1 ? files[0].path : null;
  };

  log('Calling RenameMovie...');
  const renameCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ name: 'RenameMovie', movieIds: [movie.id] }),
  });
  return waitForRename({
    baseUrl,
    apiKey,
    readPath,
    commandId: renameCmd.id,
    label: 'RenameMovie',
    beforePath: movieFile.path,
    timeoutMs,
    log,
    intervalMs: opts.intervalMs,
  });
}

/**
 * Trigger Sonarr refresh + rename for a specific episode file.
 * @returns {string} confirmed file path (Arr-side)
 */
async function sonarrRename(baseUrl, apiKey, series, episodeFile, timeoutMs, log, opts = {}) {
  log(`Calling RefreshSeries for "${series.title}" (id: ${series.id})...`);
  const refreshCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ name: 'RefreshSeries', seriesId: series.id }),
  });
  await pollCommand(baseUrl, apiKey, refreshCmd.id, 'RefreshSeries', timeoutMs, log, opts);

  // A series holds many files, so there is no safe fallback here: if the id is
  // gone we cannot tell which file was ours, and an unconfirmed rename must fail.
  const readPath = async () => {
    const f = await arrFetch(`${baseUrl}/api/v3/episodefile/${episodeFile.id}`, apiKey)
      .catch(() => null);
    return f && f.path ? f.path : null;
  };

  log(`Calling RenameFiles for episode file id: ${episodeFile.id}...`);
  const renameCmd = await arrFetch(`${baseUrl}/api/v3/command`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      name: 'RenameFiles',
      seriesId: series.id,
      files: [episodeFile.id],
    }),
  });
  return waitForRename({
    baseUrl,
    apiKey,
    readPath,
    commandId: renameCmd.id,
    label: 'RenameFiles',
    beforePath: episodeFile.path,
    timeoutMs,
    log,
    intervalMs: opts.intervalMs,
  });
}

// Radarr/Sonarr API only returns language name, not ISO codes.
// Map to ISO 639-2 (3-letter) codes used by ffprobe stream tags.
const ARR_LANG_TO_ISO = {
  afrikaans: 'afr',
  albanian: 'sqi',
  arabic: 'ara',
  bengali: 'ben',
  bosnian: 'bos',
  bulgarian: 'bul',
  catalan: 'cat',
  chinese: 'chi',
  croatian: 'hrv',
  czech: 'ces',
  danish: 'dan',
  dutch: 'dut',
  english: 'eng',
  estonian: 'est',
  finnish: 'fin',
  flemish: 'dut',
  french: 'fre',
  georgian: 'kat',
  german: 'ger',
  greek: 'gre',
  hebrew: 'heb',
  hindi: 'hin',
  hungarian: 'hun',
  icelandic: 'ice',
  indonesian: 'ind',
  italian: 'ita',
  japanese: 'jpn',
  kannada: 'kan',
  korean: 'kor',
  latvian: 'lav',
  lithuanian: 'lit',
  macedonian: 'mac',
  malayalam: 'mal',
  marathi: 'mar',
  mongolian: 'mon',
  norwegian: 'nor',
  persian: 'per',
  polish: 'pol',
  portuguese: 'por',
  'portuguese (brazil)': 'por',
  romanian: 'rum',
  romansh: 'roh',
  russian: 'rus',
  serbian: 'srp',
  slovak: 'slo',
  slovenian: 'slv',
  spanish: 'spa',
  'spanish (latino)': 'spa',
  swedish: 'swe',
  tagalog: 'tgl',
  tamil: 'tam',
  telugu: 'tel',
  thai: 'tha',
  turkish: 'tur',
  ukrainian: 'ukr',
  urdu: 'urd',
  vietnamese: 'vie',
};

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
        const name = match.movie.originalLanguage.name;
        const iso = ARR_LANG_TO_ISO[(name || '').toLowerCase()];
        log(`Radarr: original language = ${name} (${iso || 'unknown'})`);
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
        const name = match.series.originalLanguage.name;
        const iso = ARR_LANG_TO_ISO[(name || '').toLowerCase()];
        log(`Sonarr: original language = ${name} (${iso || 'unknown'})`);
        return iso || null;
      }
      log('No Sonarr match or no originalLanguage field');
    } catch (err) {
      log(`Sonarr error: ${err.message}`);
    }
  }

  return null;
}

module.exports = {
  arrFetch,
  pollCommand,
  waitForRename,
  findRadarrMatch,
  findSonarrMatch,
  radarrRename,
  sonarrRename,
  getOriginalLanguage,
};

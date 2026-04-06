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

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
      defaultValue: '600',
      inputUI: { type: 'text' },
      tooltip: 'Max seconds to wait for the Arr rename to be confirmed on the file record. '
        + 'A busy Radarr/Sonarr can leave a rename queued for minutes; if the wait runs out '
        + 'the plugin fails rather than reporting an unrenamed path.',
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
  const radarrUrl = (inputs.radarr_url || '').trim().replace(/\/+$/, '');
  const radarrKey = (inputs.radarr_api_key || '').trim();
  const sonarrUrl = (inputs.sonarr_url || '').trim().replace(/\/+$/, '');
  const sonarrKey = (inputs.sonarr_api_key || '').trim();
  const timeoutMs = (Number(inputs.poll_timeout) || 600) * 1000;

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
  log(`Arr-side path: ${arrPath}${arrPath === filePath ? ' (no mapping applied)' : ''}`);

  // Only reached once a rename has been CONFIRMED against the Arr's file record,
  // so the path here is real. Carry it on both _id and file: the two must not
  // diverge or the next node works on a path that no longer exists.
  const renamed = (newArrPath, m, logFn) => {
    const newPath = m.fromArr(newArrPath);
    if (newPath === filePath) logFn('No rename needed -- name already matches the Arr naming scheme');
    else logFn(`Renamed: ${newPath}`);
    return {
      outputFileObj: Object.assign({}, args.inputFileObj, { _id: newPath, file: newPath }),
      outputNumber: 1,
      variables: args.variables,
    };
  };

  // Try Radarr
  //
  // A lookup failure is recoverable -- the file may belong to the other service,
  // so fall through. A rename failure on a file we DID match is not: returning
  // an unconfirmed path makes Tdarr store a path the Arr is about to change,
  // and the renamed file then rescans as a new one (job ctkumSFxY, 2026-08-17).
  // Let it throw, per this repo's "throw for Tdarr's own error handler" rule.
  if (hasRadarr) {
    let match = null;
    try {
      log('Searching Radarr...');
      match = await findRadarrMatch(radarrUrl, radarrKey, arrPath);
      if (!match) log('No Radarr match');
    } catch (err) {
      log(`Radarr lookup error: ${err.message}`);
    }

    if (match) {
      log(`Matched movie: ${match.movie.title} (file id: ${match.movieFile.id})`);
      const newArrPath = await radarrRename(
        radarrUrl, radarrKey, match.movie, match.movieFile, timeoutMs, log,
      );
      return renamed(newArrPath, mapper, log);
    }
  }

  // Try Sonarr -- same split: tolerate a failed lookup, never a failed rename.
  if (hasSonarr) {
    let match = null;
    try {
      log('Searching Sonarr...');
      match = await findSonarrMatch(sonarrUrl, sonarrKey, arrPath, log);
      if (!match) log('No Sonarr match');
    } catch (err) {
      log(`Sonarr lookup error: ${err.message}`);
    }

    if (match) {
      log(`Matched series: ${match.series.title} (file id: ${match.episodeFile.id})`);
      const newArrPath = await sonarrRename(
        sonarrUrl, sonarrKey, match.series, match.episodeFile, timeoutMs, log,
      );
      return renamed(newArrPath, mapper, log);
    }
  }

  log('No Arr service matched this file');
  return noChange();
};

module.exports = { details, plugin };

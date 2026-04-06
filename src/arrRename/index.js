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
  const radarrUrl = (inputs.radarr_url || '').trim().replace(/\/+$/, '');
  const radarrKey = (inputs.radarr_api_key || '').trim();
  const sonarrUrl = (inputs.sonarr_url || '').trim().replace(/\/+$/, '');
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
  log(`Arr-side path: ${arrPath}${arrPath === filePath ? ' (no mapping applied)' : ''}`);

  // Try Radarr
  if (hasRadarr) {
    try {
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
    } catch (err) {
      log(`Radarr error: ${err.message}`);
    }
  }

  // Try Sonarr
  if (hasSonarr) {
    try {
      log('Searching Sonarr...');
      const match = await findSonarrMatch(sonarrUrl, sonarrKey, arrPath, log);
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
    } catch (err) {
      log(`Sonarr error: ${err.message}`);
    }
  }

  log('No Arr service matched this file');
  return noChange();
};

module.exports = { details, plugin };

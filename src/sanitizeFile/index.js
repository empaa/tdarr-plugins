// src/sanitizeFile/index.js
'use strict';

const details = () => ({
  name: 'Sanitize File',
  description: [
    'All-in-one pre-encode sanitizer. Determines the original language via',
    'Radarr/Sonarr (falls back to first audio track), keeps the best audio',
    'track per wanted language, filters subtitles, removes image streams',
    '(cover art/thumbnails), reorders streams, and remuxes to MKV.',
    'All in a single ffmpeg call.',
  ].join(' '),
  style: { borderColor: 'green' },
  tags: 'sanitize,audio,subtitle,remux,mkv,radarr,sonarr',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.00.01',
  sidebarPosition: -1,
  icon: 'faBroom',
  inputs: [
    {
      label: 'Radarr URL',
      name: 'radarr_url',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Radarr base URL, e.g. http://radarr:7878. Leave empty to skip.',
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
      tooltip: 'Sonarr base URL, e.g. http://sonarr:8989. Leave empty to skip.',
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
      tooltip: 'JSON array of "tdarrPath:arrPath" mappings, e.g. ["/media:/mnt/media"]. Leave empty if paths match.',
    },
    {
      label: 'Additional Audio Languages',
      name: 'additional_audio_languages',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Comma-separated ISO 639-2 codes for extra audio languages to keep (e.g. eng,swe). The original language from Radarr/Sonarr is always kept.',
    },
    {
      label: 'Subtitle Languages',
      name: 'subtitle_languages',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Comma-separated ISO 639-2 codes for extra subtitle languages to keep (e.g. eng,swe). The original language subtitles are always kept.',
    },
  ],
  outputs: [
    { number: 1, tooltip: 'File was sanitized (streams filtered, reordered, remuxed to MKV)' },
    { number: 2, tooltip: 'File already clean — no changes needed' },
  ],
});

const plugin = async (args) => {
  // Implemented in subsequent tasks
  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 2,
    variables: args.variables,
  };
};

module.exports = { details, plugin };

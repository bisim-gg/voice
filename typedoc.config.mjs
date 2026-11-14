// The API reference of @bisim/voice, generated from the TSDoc in src/ into site/ (published to GitHub Pages by
// .github/workflows/docs.yml). The guide lives with bisim.js.

/** @type {Partial<import('typedoc').TypeDocOptions>} */
export default {
  entryPoints: ['src/index.ts'],
  out: 'site',
  tsconfig: 'tsconfig.json',
  name: '@bisim/voice',
  includeVersion: true,
  readme: 'README.md',
  excludeInternal: true,
  excludePrivate: true,
  excludeProtected: true,
  sort: ['kind', 'instance-first', 'alphabetical-ignoring-documents'],
  githubPages: true,
  hideGenerator: true,
  customCss: './docs/typedoc.css',
  favicon: './docs/logo.svg',
  disableSources: true,
  searchInComments: true,
  highlightLanguages: ['diff', 'sh', 'bash', 'javascript', 'js', 'typescript', 'ts', 'json'],
  navigationLinks: {
    Guide: 'https://bisim-gg.github.io/bisim.js/guide/voice/',
    'راهنمای فارسی': 'https://bisim-gg.github.io/bisim.js/fa/guide/voice/',
    'bisim.js': 'https://bisim-gg.github.io/bisim.js/api/index.html',
    GitHub: 'https://github.com/bisim-gg/voice',
  },
  validation: { notExported: false, invalidLink: true, notDocumented: false },
  logLevel: 'Warn',
};

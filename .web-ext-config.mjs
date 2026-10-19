export default {
  sourceDir: '.',
  ignoreFiles: [
    'README.md',
    'AGENTS.md',
    'BUILD.md',
    'PRIVACY.md',
    'affiche-sondage-kyara.png',
    'updates.json',
    'package.json',
    'package-lock.json',
    '.gitignore',
    '.web-ext-config.mjs',
    'node_modules/**',
    'web-ext-artifacts/**',
    'scripts',
    'scripts/**',
    'test',
    'test/**',
    '*.xpi'
  ],
  build: {
    overwriteDest: true
  }
};

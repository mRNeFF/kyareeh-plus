export default {
  sourceDir: '.',
  ignoreFiles: [
    'README.md',
    'BUILD.md',
    'PRIVACY.md',
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

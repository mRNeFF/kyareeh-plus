export default {
  sourceDir: '.',
  ignoreFiles: [
    'README.md',
    'package.json',
    'package-lock.json',
    '.gitignore',
    '.web-ext-config.mjs',
    'node_modules/**',
    'web-ext-artifacts/**',
    'test',
    'test/**',
    '*.xpi'
  ],
  build: {
    overwriteDest: true
  }
};

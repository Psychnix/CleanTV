// Development only: check ES5 grammar and common runtime mistakes. The editor's fixed Samsung
// mirror expression runs in CleanTV on the TV (Chrome 47), so it follows the same rules.
export default [{ ignores: ['app/vendor/**'] }, {
  files: ['app/**/*.js', 'scripts/editor-tizen-mirror.js'],
  languageOptions: {
    ecmaVersion: 5,
    sourceType: 'script',
    globals: {
      window: 'readonly', document: 'readonly', Image: 'readonly', localStorage: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', Promise: 'readonly',
      FrameDevice: 'readonly', tizen: 'readonly'
    }
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': 'error',
    'no-dupe-args': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-func-assign': 'error',
    'no-global-assign': 'error',
    'no-unexpected-multiline': 'error',
    'valid-typeof': 'error',
    eqeqeq: ['error', 'always']
  }
}];

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginJest from 'eslint-plugin-jest';
import pluginGithub from 'eslint-plugin-github'

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  pluginGithub.getFlatConfigs().recommended,
  ...pluginGithub.getFlatConfigs().typescript,
  {
    files: ['src/**/*.ts'],
    rules: {
      'i18n-text/no-en': 'off',
      'importPlugin/no-namespace': 'off',
      'github/array-foreach': 'error',
      'github/async-preventdefault': 'warn',
      'github/no-then': 'error',
      'github/no-blur': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    plugins: { jest: pluginJest },
    languageOptions: {
      globals: pluginJest.environments.globals.globals,
    },
    rules: {
      'jest/no-disabled-tests': 'warn',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/prefer-to-have-length': 'warn',
      'jest/valid-expect': 'error',
    },
  },
  {
    ignores: ['dist/', 'lib/', 'node_modules/']
  }
);

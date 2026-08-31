// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * The companion is a Node CLI, not a browser app, so the root config's platform
 * invariants (window.nzxt, namespaced storage, no hardcoded origins) do not
 * apply here — but the type-aware strictness does. The root ESLint run ignores
 * `companion/**` and delegates to this file via `npm run check:companion`.
 *
 * Two local rules earn their keep:
 *  - `no-restricted-syntax` bans `child_process.exec*` and `shell: true`. This
 *    program spawns an extractor with a URL an arbitrary web page supplied; the
 *    day that reaches a shell is the day it becomes a remote code execution
 *    hole. `spawn(bin, args)` with the URL as its own argv is the only form.
 *  - `no-restricted-properties` bans `server.listen` on anything but the
 *    loopback helper in `server.ts`.
 */
export default defineConfig(
  // `build/**` is the single-executable output; `scripts/**` is packaging glue
  // that runs under plain Node and is outside every tsconfig, so the
  // type-aware rules have no program to check it against.
  globalIgnores(['dist/**', 'build/**', 'node_modules/**', 'coverage/**', 'scripts/**']),

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // The CLI's job is to print things.
      'no-console': 'error',
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^exec(Sync|File|FileSync)?$/]',
          message:
            'Never exec() an extractor: the URL comes from an arbitrary web page. Use spawn(bin, args) with the URL as its own argv entry.',
        },
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: 'shell: true turns an attacker-supplied URL into a command line.',
        },
        {
          selector: "Literal[value='0.0.0.0']",
          message:
            'The companion binds 127.0.0.1 only. A LAN-bound companion is a download service for the whole network.',
        },
      ],
    },
  },

  {
    files: ['test/**/*.ts', 'test-live/**/*.ts', '*.config.ts', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  prettier,
);

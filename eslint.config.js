// @ts-check
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import playwright from 'eslint-plugin-playwright';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Platform invariants (docs/design/design-ossDx.md §4.3). Each rule below exists
 * because a human forgetting it produces a black LCD that is hard to debug.
 */

const DOCS = 'docs/design/design-architecture.md';

/** @typedef {{ selector: string; message: string }} SyntaxRule */

/** Invariant 1: never reassign `window.nzxt` (it destroys CAM's injected geometry). */
const noNzxtAssignment = [
  {
    selector: "AssignmentExpression > MemberExpression[object.name='window'][property.name='nzxt']",
    message: `Never assign to window.nzxt — it destroys CAM's injected width/height/shape/targetFps. Use property assignment via src/platform/nzxt.ts. See ${DOCS}#platform-layer`,
  },
  {
    selector:
      "AssignmentExpression > MemberExpression[object.object.name='window'][object.property.name='nzxt'][property.name='v1']",
    message: `Never assign to window.nzxt.v1 — assign onto it instead (window.nzxt.v1.onMonitoringDataUpdate = handler). See ${DOCS}#platform-layer`,
  },
];

/**
 * Invariant 1, second half: the *aliasing* escape hatch.
 *
 * `noNzxtAssignment` only sees `window.nzxt` written as a literal member
 * expression, so `const w = window; w.nzxt = {}` — which is the house style in
 * `src/platform/nzxt.ts` — sailed through untouched. These two selectors flag
 * any read or write of a `.nzxt` property, and any cast that names `nzxt`,
 * anywhere outside the allowlisted platform files.
 */
const noNzxtAliasing = [
  {
    selector: "MemberExpression[property.name='nzxt']",
    message: `Only src/platform/nzxt.ts and src/platform/simulator.ts may touch a .nzxt property — aliasing window first (const w = window; w.nzxt) does not make it safe. Import peekNzxt()/whenNzxt() instead. See ${DOCS}#platform-layer`,
  },
  {
    selector: "TSAsExpression:has(TSPropertySignature[key.name='nzxt'])",
    message: `Casting to a type with an \`nzxt\` property ((window as unknown as { nzxt })) is the same invariant violation with a type assertion in front of it. Use src/platform/nzxt.ts. See ${DOCS}#platform-layer`,
  },
  {
    selector: 'TSAsExpression:has(TSTypeReference[typeName.name=/[Nn]zxt/])',
    message: `Casting through an nzxt-shaped type is the same invariant violation with a type assertion in front of it. Use src/platform/nzxt.ts. See ${DOCS}#platform-layer`,
  },
];

/** Invariant 2: the Kraken Browser never follows a navigation. */
const noNavigationSyntax = [
  {
    selector: "AssignmentExpression > MemberExpression[property.name='href']",
    message:
      'No navigation: the Kraken Browser does not follow navigations. Use an <a href="#/…"> link; the hash router (src/app/config/router.ts) only ever READS location.hash.',
  },
];

const noNavigationProperties = [
  { object: 'history', property: 'pushState', message: 'No navigation: use hash routing.' },
  { object: 'history', property: 'replaceState', message: 'No navigation: use hash routing.' },
  { object: 'location', property: 'assign', message: 'No navigation: use hash routing.' },
  { object: 'location', property: 'replace', message: 'No navigation: use hash routing.' },
  { object: 'window', property: 'open', message: 'No navigation from display code.' },
];

/** Invariant 3: storage is namespaced, and only the platform wrappers touch it. */
const restrictedStorageGlobals = [
  {
    name: 'localStorage',
    message:
      'Use src/platform/storage.ts — every key must carry the kraken-hub:v1: namespace so forks sharing github.io do not collide.',
  },
  {
    name: 'sessionStorage',
    message: 'Use src/platform/storage.ts — storage access is namespaced and centralised.',
  },
];

/**
 * Invariant 3, second half: `no-restricted-globals` only matches the bare
 * identifier, so `window.localStorage.setItem('unprefixed', …)` and
 * `const ls = window.localStorage` both linted clean. Match the property too.
 */
const noStorageAliasing = [
  {
    selector: 'MemberExpression[property.name=/^(localStorage|sessionStorage)$/]',
    message:
      'Use src/platform/storage.ts — reaching web storage through window/globalThis bypasses the kraken-hub:v1: namespace just as surely as the bare global does.',
  },
];

const restrictedStorageProperties = [
  {
    object: 'indexedDB',
    property: 'open',
    message: 'Use src/platform/idb.ts — the database name (kraken-hub.v1) is namespaced there.',
  },
];

/** Invariant 4: no hardcoded origins — a fork must work from its own hostname. */
const noHardcodedOrigins = [
  {
    selector:
      'Literal[value=/github\\.io|githubusercontent|https?:\\/\\/(?!127\\.0\\.0\\.1|localhost)[a-z0-9]/]',
    message:
      'No hardcoded origins: derive from location.origin / location.hostname. Provider hosts live in src/config/knownHosts.ts, broker URLs in src/sync/endpoints.ts.',
  },
];

/** Invariant 8: nothing is loaded from a CDN — strict CSP and offline demo depend on it. */
const noRemoteScripts = [
  {
    selector: 'Literal[value=/<script[^>]*src=["\']?https?:/]',
    message: "No CDN scripts: everything on the display path must be bundled (script-src 'self').",
  },
  {
    selector: 'ImportExpression > Literal[value=/^https?:/]',
    message: 'No remote dynamic imports: bundle the dependency instead.',
  },
];

/**
 * Every `no-restricted-syntax` entry that applies to `src/**`, in one list.
 *
 * Overrides are written as `syntaxExcept(group)` so an override waives exactly
 * the group it names and keeps every other invariant. Spelling the survivors
 * out by hand is how `src/config/knownHosts.ts` silently lost the navigation
 * rules and `src/platform/nzxt.ts` silently lost the origin rule.
 */
const allSyntaxRules = [
  ...noNzxtAssignment,
  ...noNzxtAliasing,
  ...noNavigationSyntax,
  ...noStorageAliasing,
  ...noHardcodedOrigins,
  ...noRemoteScripts,
];

/**
 * `['error', ...everything except the waived groups]` — identity-based, so a
 * typo cannot silently waive nothing.
 *
 * @param {SyntaxRule[][]} waived
 * @returns {['error', ...SyntaxRule[]]}
 */
function syntaxExcept(...waived) {
  const drop = new Set(waived.flat());
  for (const rule of drop) {
    if (!allSyntaxRules.includes(rule)) {
      throw new Error(
        `syntaxExcept(): waived a rule that is not in allSyntaxRules: ${rule.selector}`,
      );
    }
  }
  return ['error', ...allSyntaxRules.filter((rule) => !drop.has(rule))];
}

export default defineConfig(
  globalIgnores([
    'dist/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'node_modules/**',
    'docs/**',
    // The companion is a Node CLI in its own npm workspace, with its own
    // type-aware config (`companion/resolver/eslint.config.js`) and its own
    // invariants — `npm run check:companion` runs it. Linting it from here
    // would need its files in the root tsconfig projects, which would in turn
    // drag Node-only code into the web app's type graph.
    'companion/**',
  ]),

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Both projects, so the tooling files (vite/vitest/playwright configs,
        // eslint.config.js, scripts/*.mjs) are type-aware too.
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: ['./tsconfig.json'] })],
    },
    rules: {
      'import-x/no-cycle': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      // Invariant 7: no default exports except module manifests and config files.
      'import-x/no-default-export': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ---- src/** : the platform invariants -----------------------------------
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    rules: {
      'no-restricted-syntax': syntaxExcept(),
      'no-restricted-properties': [
        'error',
        ...noNavigationProperties,
        ...restrictedStorageProperties,
      ],
      'no-restricted-globals': ['error', ...restrictedStorageGlobals],
    },
  },

  // Invariant 1 override: the only two files allowed to touch window.nzxt.
  // design-ossDx.md §3.2 also planned `tests/support/nzxtInject.ts`; it was never
  // needed — the simulator IS the injection harness (`?sim=`, `?inject=late`),
  // and the e2e suite drives it through the URL rather than through page script.
  {
    files: ['src/platform/nzxt.ts', 'src/platform/simulator.ts'],
    rules: { 'no-restricted-syntax': syntaxExcept(noNzxtAssignment, noNzxtAliasing) },
  },

  // Invariant 2 has NO override, deliberately. design-ossDx.md §4.3 reserved one
  // for `src/routing/hash.ts`; M1 shipped the router (`src/app/config/router.ts`)
  // without it, because reading `location.hash` and subscribing to `hashchange`
  // is not navigation — every route change is an ordinary `<a href="#/…">`. So
  // there is no file anywhere that is allowed to write `location.href`.

  // Invariant 2, hard form: display code may never navigate, at all.
  {
    files: ['src/app/display/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...noNavigationProperties,
        ...restrictedStorageProperties,
        { object: 'location', property: 'hash', message: 'Display mode never routes.' },
      ],
    },
  },

  // Invariant 3 override: the storage wrappers themselves.
  {
    files: ['src/platform/storage.ts', 'src/platform/idb.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': syntaxExcept(noStorageAliasing),
      'no-restricted-properties': ['error', ...noNavigationProperties],
    },
  },

  // Invariant 4 override: the two files that are *allowed* to name hosts.
  // `src/sync/endpoints.ts` lands in M2 (the broker URL table).
  {
    files: ['src/config/knownHosts.ts', 'src/sync/endpoints.ts'],
    rules: { 'no-restricted-syntax': syntaxExcept(noHardcodedOrigins) },
  },

  // Invariant 5: device sizes come from props, never from a literal.
  {
    files: ['src/modules/**/*.{ts,tsx}', 'src/app/display/**/*.{ts,tsx}'],
    rules: {
      // `error`, not `warn`: `npm run lint` runs with --max-warnings 0, so a
      // warning already fails CI — saying `error` makes that honest.
      'no-magic-numbers': [
        'error',
        { ignore: [0, 1, 2, -1, 100, 360], ignoreArrayIndexes: true, enforceConst: true },
      ],
    },
  },

  // Invariant 6: import layering zones.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/platform',
              from: './src/modules',
              message: 'platform may not import modules.',
            },
            {
              target: './src/platform',
              from: './src/providers',
              message: 'platform may not import providers.',
            },
            {
              target: './src/platform',
              from: './src/app',
              message: 'platform may not import app.',
            },
            {
              target: './src/providers',
              from: './src/modules',
              message: 'providers may not import modules.',
            },
            { target: './src/sync', from: './src/app', message: 'sync may not import app.' },

            /*
             * Invariant 8 (the one that ships the config UI to the LCD when it
             * breaks). The bundle-graph half of the enforcement lives in
             * scripts/check-bundle-size.mjs — this half fails the PR earlier
             * and points at the offending line.
             *
             * Module *display* code is `.ts` and is covered; a module's `.tsx`
             * config panel is config-only code, is chunked away from the
             * display graph by vite.config.ts, and may use the UI kit.
             */
            {
              target: './src/app/display',
              from: './src/ui',
              message:
                'I8: display code must not import the configuration UI kit — it would drag config-ui onto the LCD critical path.',
            },
            {
              target: './src/app/display',
              from: './src/app/config',
              message: 'I8: display code must not import the configuration app.',
            },
            {
              target: './src/modules/**/*.ts',
              from: './src/ui',
              message:
                "I8: a module's display code must not import the UI kit. Put it in the module's *Config.tsx panel instead.",
            },
            {
              target: './src/modules/**/*.ts',
              from: './src/app/config',
              message: "I8: a module's display code must not import the configuration app.",
            },
          ],
        },
      ],
    },
  },

  // Invariant 7 overrides: manifests and config files legitimately default-export.
  // `.d.ts` too — an ambient re-declaration of a third-party module (e.g.
  // `hls.js/light`, whose `exports` map ships no `types` condition) has to
  // mirror that package's default export; the invariant is about OUR modules.
  {
    files: ['**/manifest.ts', '*.config.{ts,js}', 'eslint.config.js', 'src/main.tsx', '**/*.d.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },

  // ---- config / remote UI: accessibility applies to real UI only -----------
  // `src/app/remote/**` lands in M2 (the phone remote surface).
  {
    files: ['src/app/config/**/*.tsx', 'src/app/remote/**/*.tsx', 'src/ui/**/*.tsx'],
    extends: [jsxA11y.flatConfigs.recommended],
  },

  // ---- unit tests ---------------------------------------------------------
  {
    files: ['src/**/*.test.{ts,tsx}', 'tests/live/**/*.test.ts', 'tests/support/**/*.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Invariant 5 bans device sizes as literals in `src/modules/**`. A test
      // that reproduces a worked example from the design docs is nothing BUT
      // those literals — asserting `translate(-248.889px, …)` is the point.
      'no-magic-numbers': 'off',
      /*
       * A revert is not something one `expect()` can catch.
       *
       * The bug this exists for held the right value for about a second and
       * then flipped, so the only useful assertion SAMPLES a reading across a
       * window — which means it lives in a helper, and the rule cannot see
       * through a helper. Naming the helpers is what the rule is configured
       * for; turning it off would lose the check everywhere else.
       */
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'holdsFor'] }],
    },
  },

  // ---- e2e ----------------------------------------------------------------
  {
    files: ['tests/e2e/**/*.spec.ts', 'tests/e2e-live/**/*.spec.ts'],
    extends: [playwright.configs['flat/recommended']],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-properties': 'off',
    },
  },

  // ---- build tooling ------------------------------------------------------
  // These files run in Node, default-export config objects, and hand-parse JSON
  // (budgets.json, the Vite manifest), so type-aware rules produce only noise.
  {
    files: ['*.config.{ts,js}', 'scripts/**/*.mjs', 'types/**/*.d.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: {
      'import-x/no-default-export': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },

  prettier,
);

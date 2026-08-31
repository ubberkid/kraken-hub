/**
 * Ambient declarations for build-tooling packages that ship no types.
 * Scoped to the tooling TS project (tsconfig.node.json) only.
 */
declare module 'eslint-plugin-jsx-a11y' {
  import type { Linter } from 'eslint';
  const plugin: {
    flatConfigs: { recommended: Linter.Config; strict: Linter.Config };
    configs: Record<string, unknown>;
    rules: Record<string, unknown>;
  };
  export default plugin;
}

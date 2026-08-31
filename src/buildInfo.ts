/**
 * Build identity, injected by Vite `define` (see vite.config.ts).
 *
 * Surfaced in the config UI footer and in the diagnostics report, so a bug
 * report can be tied to an exact deploy.
 */
export interface BuildInfo {
  version: string;
  gitSha: string;
  buildTime: string;
}

export function buildInfo(): BuildInfo {
  return {
    version: __APP_VERSION__,
    gitSha: __GIT_SHA__,
    buildTime: __BUILD_TIME__,
  };
}

/**
 * A link to a file in this build's own repository — the fork's, if this is a
 * fork. Used to reach the docs from inside the app (the hardware checklist from
 * `#/diag`, above all), which a relative link cannot do: `docs/` is not part of
 * the deployed site. Returns `null` when the manifest named no repository, and
 * every caller must render nothing rather than a dead link.
 */
export function docUrl(path: string): string | null {
  return __REPO_URL__ === '' ? null : `${__REPO_URL__}/blob/main/${path}`;
}

/**
 * A link to one of this repository's issue forms, prefilled by GitHub from the
 * named template. Same rule as `docUrl()`: derived from the manifest so a fork
 * points at the fork, `null` when there is no repository to point at, and never
 * a hardcoded origin (invariant 4).
 */
export function issueUrl(template: string): string | null {
  return __REPO_URL__ === '' ? null : `${__REPO_URL__}/issues/new?template=${template}`;
}

/** e.g. `kraken-hub v0.1.0 · a1b2c3d · built 2026-08-30` */
export function buildLabel(info: BuildInfo = buildInfo()): string {
  const day = info.buildTime.slice(0, 10);
  return `kraken-hub v${info.version} · ${info.gitSha} · built ${day}`;
}

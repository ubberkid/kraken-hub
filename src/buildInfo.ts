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

/**
 * `package.json`'s `repository.url` as a browsable https URL.
 *
 * Exported so the Vite config that injects `__REPO_URL__` and the unit test that
 * checks what the app links to are running the SAME normalization — a manifest
 * may spell the same repository `git+https://….git`, `git://…` or plainly, and
 * a release link that works on one spelling and 404s on another is the kind of
 * bug nobody notices until a fork files it.
 */
export function normalizeRepoUrl(raw: string): string {
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:/, 'https:')
    .replace(/\.git$/, '');
}

/**
 * A download link for one of this repository's **latest-release** assets.
 *
 * `/releases/latest/download/<asset>` is GitHub's stable redirect: it always
 * resolves to the newest published release, so the app never has to know a
 * version number and a page shipped today keeps working after every future
 * release. Same rule as `docUrl()` — derived from the manifest so a fork points
 * at the fork's own releases, `null` when there is no repository at all, and the
 * caller renders nothing rather than a dead link (invariant I4).
 */
export function releaseAssetUrl(asset: string, repo: string = __REPO_URL__): string | null {
  return repo === '' ? null : `${normalizeRepoUrl(repo)}/releases/latest/download/${asset}`;
}

/**
 * The companion, as a double-clickable Windows program.
 *
 * Windows only, and not for lack of ambition: NZXT CAM is a Windows
 * application, so the PC with a Kraken plugged into it is a Windows PC by
 * definition. Every other platform is a developer, and developers get the npm
 * one-liner.
 */
export const RESOLVER_WINDOWS_ASSET = 'kraken-hub-resolver-win-x64.exe';

/** e.g. `kraken-hub v0.1.0 · a1b2c3d · built 2026-08-30` */
export function buildLabel(info: BuildInfo = buildInfo()): string {
  const day = info.buildTime.slice(0, 10);
  return `kraken-hub v${info.version} · ${info.gitSha} · built ${day}`;
}

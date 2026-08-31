import { buildInfo } from '../../buildInfo';

/** Version, sha and build time — so any bug report can name an exact deploy. */
export function Footer() {
  const info = buildInfo();
  return (
    <footer className="kh-footer">
      <span>
        kraken-hub v{info.version} · {info.gitSha} · built{' '}
        {info.buildTime.slice(0, 16).replace('T', ' ')} UTC
      </span>
      <a href="#/about" data-testid="disclosure-about">
        About
      </a>
    </footer>
  );
}

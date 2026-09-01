import { buildInfo } from '../../buildInfo';

/**
 * The version line, and the way to the one page behind it.
 *
 * It used to be a dead string plus a separate `About` link beside it, while
 * `Diagnostics` lived in a different row in a different type style (design
 * audit, F7/F8). Now the string IS the link: About and Diagnostics are one page,
 * and the thing a person clicks to reach it is the exact text a bug report asks
 * them to quote.
 */
export function Footer() {
  const info = buildInfo();
  return (
    <footer className="kh-footer">
      <a href="#/about" data-testid="disclosure-about">
        kraken-hub v{info.version} · {info.gitSha} · built{' '}
        {info.buildTime.slice(0, 16).replace('T', ' ')} UTC
      </a>
    </footer>
  );
}

/**
 * A ~40-line hash router with no dependency.
 *
 * Hash-only, never `pushState`: GitHub Pages has no rewrite rules, and keeping
 * the rule uniform across both pages removes a whole class of navigation
 * mistakes on a device that cannot follow a navigation at all (invariant I1).
 */

export type Route =
  | { name: 'home' }
  | { name: 'module'; id: string }
  | { name: 'library' }
  | { name: 'sources' }
  | { name: 'remote' }
  | { name: 'preview' }
  | { name: 'diag' }
  | { name: 'about' };

/*
 * There is no route TABLE any more.
 *
 * The header used to carry five tabs named after the codebase — Your Kraken,
 * Sources, Remote, Diagnostics, About. The Halo direction (screen 1) replaces
 * them with a wordmark and one quiet disclosure row on the home screen, so the
 * list of sections has exactly one home and it is the home screen itself.
 *
 * Two routes here are deliberately not reachable from any link and exist only
 * so an old bookmark, a doc link or a fork's deep link still resolves:
 *
 *  - `preview` — folded into the home screen's live mirror (stage 1);
 *  - `sources` — renamed to `library`, because "sources" is a word from the
 *    architecture and "library" is the word for a shelf of clips.
 *
 * Both redirect in page, by rewriting the hash. Never `location.replace()`:
 * that IS a navigation, and the Kraken Browser does not follow one (invariant
 * I1/I2). See `ConfigApp`.
 */

export function parseRoute(hash: string): Route {
  const path = hash
    .replace(/^#/, '')
    // The fragment carries its own query string — `#/remote?room=ABCD1234`. It
    // is not part of the route, and before this split `#/remote?room=…` parsed
    // as the unknown head `remote?room=…` and fell through to the home screen,
    // which meant a scanned pairing QR opened the wrong page entirely.
    .replace(/\?.*$/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (path.length === 0) return { name: 'home' };
  const [head, tail] = path.split('/');
  switch (head) {
    case 'module':
      return tail === undefined || tail.length === 0
        ? { name: 'home' }
        : { name: 'module', id: tail };
    case 'library':
      return { name: 'library' };
    case 'sources':
      return { name: 'sources' };
    case 'remote':
      return { name: 'remote' };
    case 'preview':
      return { name: 'preview' };
    case 'diag':
      return { name: 'diag' };
    case 'about':
      return { name: 'about' };
    default:
      return { name: 'home' };
  }
}

/**
 * The query string carried INSIDE the fragment — `#/remote?room=ABCD1234` →
 * `room=ABCD1234`.
 *
 * This is where the pairing link puts the room code, and the reason is worth
 * writing down: a fragment is never sent to a server. It does not appear in an
 * access log, a CDN log, a proxy, a `Referer` header or an analytics hit, on our
 * origin or on anybody's fork. The room code derives both the MQTT topic and the
 * AES-GCM key, so it is the one secret in the whole sync design — putting it in
 * the real query string would mean handing it to every hop between the phone and
 * the static host. See `remoteLinkUrl` in `qr.ts`, which is the only thing that
 * builds this link, and `qr.test.ts`, which pins it.
 */
export function hashQuery(hash: string): string {
  const i = hash.indexOf('?');
  return i === -1 ? '' : hash.slice(i + 1);
}

/** `useSyncExternalStore`-compatible subscription to `hashchange`. */
export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

export function currentHash(): string {
  return window.location.hash;
}

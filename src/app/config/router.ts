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
  | { name: 'sources' }
  | { name: 'remote' }
  | { name: 'preview' }
  | { name: 'diag' }
  | { name: 'about' };

export const ROUTES: readonly { href: string; label: string }[] = [
  { href: '#/', label: 'Setup' },
  { href: '#/sources', label: 'Sources' },
  { href: '#/remote', label: 'Remote' },
  { href: '#/preview', label: 'Preview' },
  { href: '#/diag', label: 'Diagnostics' },
  { href: '#/about', label: 'About' },
];

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.length === 0) return { name: 'home' };
  const [head, tail] = path.split('/');
  switch (head) {
    case 'module':
      return tail === undefined || tail.length === 0
        ? { name: 'home' }
        : { name: 'module', id: tail };
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

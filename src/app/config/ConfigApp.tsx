import { Suspense, lazy, useEffect, useSyncExternalStore } from 'react';

import { Footer } from './Footer';
import { currentHash, parseRoute, subscribeRoute } from './router';
import { AboutView } from './views/AboutView';
import { CamSetupCard } from './views/CamSetupCard';
import { HomeView } from './views/HomeView';
import { LibraryView } from './views/LibraryView';
import { ModuleSettingsView } from './views/ModuleSettingsView';
import { RemoteView } from './views/RemoteView';

import type { ConfigRuntime } from './runtime';
import type { ReactNode } from 'react';

/** Diagnostics probe a lot of APIs; keep them off the first paint. */
const DiagView = lazy(async () => {
  const m = await import('../../diag/DiagView');
  return { default: m.DiagView };
});

/**
 * The two renamed routes, resolved in place.
 *
 * `#/preview` folded into the home screen's mirror in stage 1; `#/sources`
 * became `#/library` in stage 2, because "sources" is a word from the
 * architecture and "library" is the word for a shelf of clips. Old links must
 * not 404 — a bookmark, a doc link, a fork's deep link — so both render the new
 * screen immediately and rewrite the hash underneath.
 *
 * A hash rewrite, never a navigation (invariant I1/I2). `location.replace` is
 * not used precisely because it IS a navigation API; assigning the hash leaves
 * the router the only thing that decides what is on screen, and fires no `load`.
 */
function HashRedirect({ from, to, children }: { from: string; to: string; children: ReactNode }) {
  useEffect(() => {
    if (parseRoute(window.location.hash).name === from) window.location.hash = to;
  }, [from, to]);
  return children;
}

export function ConfigApp({ runtime }: { runtime: ConfigRuntime }) {
  const hash = useSyncExternalStore(subscribeRoute, currentHash, () => '#/');
  // Re-render on every state commit so the views always show the stored truth.
  useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const route = parseRoute(hash);

  return (
    <div className="kh-app">
      <div className="kh-shell">
        {/*
          No tab bar (prototype screen 1: "six tabs → zero").
          The wordmark is a link home; the sections live behind the home
          screen's own quiet `Remote · Library · Diagnostics ⌄` row, and About
          sits in the footer next to the version line.
        */}
        <header className="kh-header">
          <a className="kh-wordmark" href="#/" data-testid="wordmark">
            <h1>kraken-hub</h1>
          </a>
        </header>

        {/*
          Keyed on the route so a navigation genuinely REPLACES the element:
          `.kh-shell > main` carries the prototype's one enter animation, and a
          CSS animation only re-runs on a node that was actually created. Without
          the key React would reuse this `<main>` and only the first paint would
          rise. Nothing here holds state across routes — each branch below is
          already mounted and unmounted by the route it belongs to.
        */}
        <main key={route.name}>
          {route.name === 'home' && <HomeView runtime={runtime} />}
          {route.name === 'module' && <ModuleSettingsView runtime={runtime} id={route.id} />}
          {route.name === 'library' && <LibraryView runtime={runtime} />}
          {route.name === 'sources' && (
            <HashRedirect from="sources" to="#/library">
              <LibraryView runtime={runtime} />
            </HashRedirect>
          )}
          {route.name === 'remote' && <RemoteView runtime={runtime} />}
          {route.name === 'preview' && (
            <HashRedirect from="preview" to="#/">
              <HomeView runtime={runtime} />
            </HashRedirect>
          )}
          {/*
            "Add to CAM" lives here for good once a display has ever connected —
            the home screen shows it prominently until then (see
            `displaySeen.ts`). Somebody reinstalling CAM or setting up a second
            machine looks under About; nobody with a working cooler should be
            shown step one again.
          */}
          {route.name === 'about' && (
            <>
              <AboutView runtime={runtime} />
              <CamSetupCard runtime={runtime} variant="quiet" />
            </>
          )}
          {route.name === 'diag' && (
            <Suspense fallback={<p className="kh-hint">Running probes…</p>}>
              <DiagView runtime={runtime} />
            </Suspense>
          )}
        </main>

        <Footer />
      </div>
    </div>
  );
}

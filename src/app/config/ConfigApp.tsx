import { useEffect, useSyncExternalStore } from 'react';

import { Footer } from './Footer';
import { currentHash, parseRoute, subscribeRoute } from './router';
import { AboutView } from './views/AboutView';
import { HomeView } from './views/HomeView';
import { LibraryView } from './views/LibraryView';
import { RemoteView } from './views/RemoteView';

import type { ConfigRuntime } from './runtime';
import type { ReactNode } from 'react';

/**
 * The three renamed routes, resolved in place.
 *
 * (Four now, counting `#/diag`.)
 *
 * `#/preview` folded into the home screen's mirror in stage 1; `#/sources`
 * became `#/library` in stage 2, because "sources" is a word from the
 * architecture and "library" is the word for a shelf of clips. `#/module/<id>`
 * joined them after the design audit: it was a settings page with **zero
 * inbound links anywhere in the product** (F1) and no way back, and options are
 * contextual now — so it lands on home with that module active and its panel
 * open, which is where its content actually lives. Old links must not 404 — a
 * bookmark, a doc link, a fork's deep link — so all three render the new screen
 * immediately and rewrite the hash underneath.
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

/**
 * The name each sub-page answers to, and the proof that it HAS a way back.
 *
 * A zero-tab app leans on one thing: every screen that is not home says where
 * home is. The Library, Diagnostics, About and Remote screens shipped without
 * that, so a CAM window — which has no browser chrome, no back button and no
 * keyboard shortcut for one — could reach them and then only leave by editing
 * the URL. The map is exhaustive over the sub-routes on purpose: adding a route
 * without a title is a compile error rather than a dead end.
 */
const SUBPAGE_TITLE: Readonly<Record<string, string>> = {
  library: 'Library',
  sources: 'Library',
  remote: 'Remote',
  // About and Diagnostics are ONE page now (F7): `#/diag` rewrites to `#/about`
  // and renders the same screen, so it has to carry the same name — a title
  // that said "Diagnostics" over a page called About would be the split all
  // over again, in the one place the user can see both.
  diag: 'About',
  about: 'About',
};

/**
 * Back chevron, "Your Kraken", page title.
 *
 * An ordinary `<a href="#/">` and nothing else: the hash router is the only
 * thing that decides what is on screen, and a navigation API here would be
 * invariant I1/I2 all over again. A link is also keyboard-operable, focusable
 * and openable in a new tab for free, which a `<button>` calling the router
 * would not be.
 */
function SubPageHeader({ route, title }: { route: string; title: string }) {
  return (
    <nav className="kh-subhead" data-route={route} aria-label="Sub-page">
      <a className="kh-subhead__back" href="#/" data-testid="nav-back">
        <span className="kh-subhead__chev" aria-hidden="true">
          ‹
        </span>
        Your Kraken
      </a>
      <span className="kh-subhead__sep" aria-hidden="true">
        /
      </span>
      <h2 className="kh-subhead__title">{title}</h2>
    </nav>
  );
}

/**
 * Which `<main>` element a route belongs to.
 *
 * Two routes are redirects that render the screen they redirect TO, so they
 * must not get a key of their own: a changed key remounts the screen a tick
 * after it mounted, which replays the rise animation and throws away whatever
 * the deep link had just opened.
 */
function mainKey(name: string): string {
  if (name === 'module') return 'home';
  if (name === 'diag') return 'about';
  return name;
}

export function ConfigApp({ runtime }: { runtime: ConfigRuntime }) {
  const hash = useSyncExternalStore(subscribeRoute, currentHash, () => '#/');
  // Re-render on every state commit so the views always show the stored truth.
  useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const route = parseRoute(hash);
  const subTitle = SUBPAGE_TITLE[route.name] ?? null;

  return (
    <div className="kh-app">
      <div className="kh-shell">
        {/*
          No tab bar (prototype screen 1: "six tabs → zero").

          The wordmark is a link home. The two destinations live in the home
          screen's own quiet `Remote · Library` row — Diagnostics was a third
          entry there until round 1 found it was not a destination but an
          errand, and the same errand as About; both are one page behind the
          footer's version line now.
        */}
        <header className="kh-header">
          <a className="kh-wordmark" href="#/" data-testid="wordmark">
            <h1>kraken-hub</h1>
          </a>
        </header>

        {subTitle !== null && <SubPageHeader route={route.name} title={subTitle} />}

        {/*
          Keyed on the route so a navigation genuinely REPLACES the element:
          `.kh-shell > main` carries the prototype's one enter animation, and a
          CSS animation only re-runs on a node that was actually created. Without
          the key React would reuse this `<main>` and only the first paint would
          rise. Nothing here holds state across routes — each branch below is
          already mounted and unmounted by the route it belongs to.
        */}
        {/*
          `module` shares HOME's key on purpose. The redirect below rewrites the
          hash to `#/` one tick after mount, and a changed key would tear the
          home screen down and rebuild it — throwing away the very panel the
          deep link just opened. Same screen, same element, one animation.
        */}
        {/*
          `diag` shares ABOUT's key for the same reason `module` shares home's:
          the redirect below rewrites the hash one tick after mount, and a
          changed key would tear the merged page down and rebuild it — replaying
          the rise animation and re-running every probe on it.
        */}
        <main key={mainKey(route.name)}>
          {/*
            Home and `#/module/<id>` are the SAME element in the same slot, so
            the redirect's hash rewrite does not remount the screen and throw
            away the panel the deep link just opened. `HashRedirect` is inert
            unless the current route is the one it names.
          */}
          {(route.name === 'home' || route.name === 'module') && (
            <HashRedirect from="module" to="#/">
              <HomeView
                runtime={runtime}
                openModule={route.name === 'module' ? route.id : undefined}
              />
            </HashRedirect>
          )}
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
          {/*
            About and Diagnostics are one page (F7). Same element in the same
            slot for both routes, so the redirect's hash rewrite does not
            remount it.
          */}
          {(route.name === 'about' || route.name === 'diag') && (
            <HashRedirect from="diag" to="#/about">
              <AboutView runtime={runtime} />
            </HashRedirect>
          )}
        </main>

        <Footer />
      </div>
    </div>
  );
}

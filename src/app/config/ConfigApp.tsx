import { useEffect, useSyncExternalStore } from 'react';

import { Footer } from './Footer';
import { currentHash, parseRoute, subscribeRoute } from './router';
import { ownsBytes } from './surface';
import { usePhoneOnly } from './useNarrow';
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
 * The four legacy routes are redirects that render the screen they redirect TO,
 * so none of them may get a key of its own: a changed key remounts the screen a
 * tick after it mounted, which replays the rise animation and throws away
 * whatever the deep link had just opened.
 *
 * Round 7's minors — **all four, one behaviour.** Two of them were listed here
 * (`module`, `diag`) and two were not, so `#/preview` and `#/sources` rewrote
 * their hash and then tore the screen down and rebuilt it, while `#/module/x`
 * and `#/diag` cross-faded exactly once. Four routes that exist for the same
 * reason and are described in the same comment behaved two different ways,
 * which is what a hand-maintained pair of `if`s always eventually does.
 *
 * `LEGACY_ROUTES` is the mapping, in one place, and `router.ts`'s doc-comment
 * names the same four. `#/sources` resolves to `library` even when `ConfigApp`
 * sends an unpaired remote to `#/remote` instead: the key only has to keep the
 * element stable across the rewrite, and the branch below renders `RemoteView`
 * under both keys anyway.
 */
const LEGACY_ROUTES: Readonly<Record<string, string>> = {
  module: 'home',
  preview: 'home',
  sources: 'library',
  diag: 'about',
};

function mainKey(name: string): string {
  return LEGACY_ROUTES[name] ?? name;
}

/**
 * The whole page, rewritten to `#/remote` — a phone's one screen.
 *
 * The hash rewrite is the same in-page mechanism `HashRedirect` uses and for the
 * same reason (invariant I1/I2: the Kraken Browser cannot follow a navigation,
 * so the app never performs one anywhere). It is separate from `HashRedirect`
 * because that component redirects ONE named legacy route and this one catches
 * every route there is.
 */
function PhoneRemote({ runtime }: { runtime: ConfigRuntime }) {
  useEffect(() => {
    if (parseRoute(window.location.hash).name !== 'remote') window.location.hash = '#/remote';
  });
  return <RemoteView runtime={runtime} />;
}

export function ConfigApp({ runtime }: { runtime: ConfigRuntime }) {
  const hash = useSyncExternalStore(subscribeRoute, currentHash, () => '#/');
  // Re-render on every state commit so the views always show the stored truth.
  useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const route = parseRoute(hash);
  const subTitle = SUBPAGE_TITLE[route.name] ?? null;

  /**
   * A phone gets the remote, and ONLY the remote.
   *
   * ## The rule
   *
   * The configuration surface is a set of controls for a machine: an install
   * band that says "point CAM at this address", a shelf backed by a file picker,
   * a broker field, a frame-rate instruction. Every one of them is advice about
   * the PC, and a phone is not the PC — the same argument `ownsBytes()` already
   * makes about the Library's file controls, applied one level up to the pages
   * themselves. So a phone-class window that is not CAM's own Configuration
   * Browser resolves every route to the remote, in page, by rewriting the hash.
   *
   * ## Why the two signals, and not the width alone
   *
   * `PHONE_QUERY` is a layout question and is true of a desktop window somebody
   * dragged narrow — and of CAM's 866×537 frame at a high zoom. Gating a whole
   * app on it would mean a resize changed which product you were using.
   * `PHONE_CLASS_QUERY` adds a coarse pointer, which is the difference between
   * "cramped" and "held in a hand".
   *
   * ## What a phone therefore keeps, and what it loses
   *
   * It keeps everything that drives the one Kraken from somewhere else: the
   * ring, the transport, the shelf (the same wire-fed `RemoteLibrary` `#/library`
   * would have shown it), the link field, and the pairing card — join, rotate
   * and unpair all live on this screen. What it loses is the About page's
   * connection plumbing, which is why `RemoteView` stops rendering the link to
   * it here: a link that resolves back to the screen it was pressed on is worse
   * than no link. Somebody who needs a broker URL is at the machine that talks
   * to the broker.
   *
   * CAM is never gated: `ownsBytes()` is the window whose IndexedDB the LCD
   * reads, and a Configuration Browser at any width is still that window.
   * A desktop browser is never gated either — it is the same remote, at a desk
   * (A6), and it can also install CAM, which is the one thing a phone cannot do.
   */
  const phoneOnly = usePhoneOnly(runtime);

  /**
   * A6 — there is no Library to show a window that is not attached to a Kraken.
   *
   * A remote surface draws the shelf from the wire (A2), and with no room there
   * is no wire: the page would be an empty grid claiming to be somebody's
   * library, which is the exact false-second-library impression this wave
   * exists to remove. So an unpaired remote's Library route lands on the one
   * screen that can do something about it, by rewriting the hash — never
   * `location.replace`, which IS a navigation (invariant I1/I2).
   *
   * CAM is never redirected: its shelf is a database it can read with the
   * network unplugged, and pairing has nothing to do with it.
   */
  const state = runtime.store.getSnapshot();
  const reachable = ownsBytes(runtime) || (state.sync.roomCode !== null && state.sync.enabled);

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

        {/*
          No sub-page header on a phone. The remote is the only screen there, so
          "‹ Your Kraken / Remote" would be a breadcrumb back to a page that
          does not exist on this device — and pressing it would land here again.
        */}
        {!phoneOnly && subTitle !== null && <SubPageHeader route={route.name} title={subTitle} />}

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
        {/*
          On a phone the key is CONSTANT — `remote`, whatever the hash said when
          the page opened. The rewrite lands one tick after mount, and a key that
          moved with the route would tear the remote down and rebuild it (and
          re-run its pairing effects) for every deep link that arrives here.
        */}
        <main key={phoneOnly ? 'remote' : mainKey(route.name)}>
          {phoneOnly && <PhoneRemote runtime={runtime} />}
          {!phoneOnly && (
            <>
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
              {route.name === 'library' &&
                (reachable ? (
                  <LibraryView runtime={runtime} />
                ) : (
                  <HashRedirect from="library" to="#/remote">
                    <RemoteView runtime={runtime} />
                  </HashRedirect>
                ))}
              {route.name === 'sources' && (
                <HashRedirect from="sources" to={reachable ? '#/library' : '#/remote'}>
                  {reachable ? <LibraryView runtime={runtime} /> : <RemoteView runtime={runtime} />}
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
            </>
          )}
        </main>

        <Footer />
      </div>
    </div>
  );
}

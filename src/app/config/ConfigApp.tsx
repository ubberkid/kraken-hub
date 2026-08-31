import { Suspense, lazy, useSyncExternalStore } from 'react';

import { Footer } from './Footer';
import { ROUTES, currentHash, parseRoute, subscribeRoute } from './router';
import { AboutView } from './views/AboutView';
import { ModuleSettingsView } from './views/ModuleSettingsView';
import { PreviewView } from './views/PreviewView';
import { RemoteView } from './views/RemoteView';
import { SetupView } from './views/SetupView';
import { SourcesView } from './views/SourcesView';

import type { ConfigRuntime } from './runtime';

/** Diagnostics probe a lot of APIs; keep them off the first paint. */
const DiagView = lazy(async () => {
  const m = await import('../../diag/DiagView');
  return { default: m.DiagView };
});

export function ConfigApp({ runtime }: { runtime: ConfigRuntime }) {
  const hash = useSyncExternalStore(subscribeRoute, currentHash, () => '#/');
  // Re-render on every state commit so the views always show the stored truth.
  useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const route = parseRoute(hash);
  const activeHref = route.name === 'home' ? '#/' : `#/${route.name}`;

  return (
    <div className="kh-app">
      <div className="kh-shell">
        <header className="kh-header">
          <h1>kraken-hub</h1>
          <nav className="kh-nav" aria-label="Sections">
            {ROUTES.map((r) => (
              <a
                key={r.href}
                href={r.href}
                aria-current={r.href === activeHref ? 'page' : undefined}
              >
                {r.label}
              </a>
            ))}
          </nav>
        </header>

        <main>
          {route.name === 'home' && <SetupView runtime={runtime} />}
          {route.name === 'module' && <ModuleSettingsView runtime={runtime} id={route.id} />}
          {route.name === 'sources' && <SourcesView runtime={runtime} />}
          {route.name === 'remote' && <RemoteView runtime={runtime} />}
          {route.name === 'preview' && <PreviewView />}
          {route.name === 'about' && <AboutView runtime={runtime} />}
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

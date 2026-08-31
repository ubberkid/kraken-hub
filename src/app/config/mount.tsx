import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { canonicalAppUrl } from '../../config/knownHosts';
import { createLogger } from '../../lib/log';
import { peekNzxt } from '../../platform/nzxt';
import { resolveState } from '../../state/precedence';
import { readState } from '../../state/storage';
import { createStore } from '../../state/store';
import { parseUrlParams } from '../../state/urlParams';

import { ConfigApp } from './ConfigApp';

import type { ConfigRuntime } from './runtime';

const log = createLogger('boot/config');

/**
 * Config boot (design-architecture.md §7.2).
 *
 * The role split matters: this page is either CAM's Configuration Browser
 * (`window.nzxt` present, or an Electron UA) or an ordinary browser acting as a
 * remote. Everything else here is deliberately identical between the two.
 */
export function mountConfig(container: HTMLElement): void {
  const params = parseUrlParams(window.location.search);
  const persisted = readState();
  if (persisted.future) {
    log.warn('settings were saved by a newer build — they are preserved, not overwritten');
  }
  const resolved = resolveState({ persisted: persisted.state, url: params.patch });

  const camDetected = peekNzxt() !== null || /Electron/i.test(navigator.userAgent);
  const role = camDetected ? 'config' : 'remote';
  const runtime: ConfigRuntime = {
    // `commitBase: 'snapshot'` — an edit here is applied to what the user is
    // actually looking at, so URL parameters survive it. See StoreOptions.
    store: createStore(resolved.state, role, {
      commitBase: 'snapshot',
      overlay: params.patch,
    }),
    role,
    persisted: persisted.state,
    url: params.patch,
    camDetected,
    appUrl: canonicalAppUrl(),
  };

  createRoot(container).render(
    <StrictMode>
      <ConfigApp runtime={runtime} />
    </StrictMode>,
  );
}

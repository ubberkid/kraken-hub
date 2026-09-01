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
  /*
   * Unlock scrolling for this page only.
   *
   * index.html's inline critical CSS pins html/body/#root to the viewport so
   * the LCD can never scroll — mandatory there, fatal here: CAM's Configuration
   * Browser is a ~866x537 Electron window and a phone on `#/remote` is smaller
   * still, so everything below the fold was unreachable. The rules keyed off
   * this class live in `src/ui/ui.css`, which rides the config-ui chunk; the
   * display page loads neither that stylesheet nor this module, so its critical
   * path is untouched (invariant I8).
   */
  document.documentElement.classList.add('kh-config-mode');

  const params = parseUrlParams(window.location.search);
  const persisted = readState();
  if (persisted.future) {
    log.warn('settings were saved by a newer build — they are preserved, not overwritten');
  }
  const resolved = resolveState({ persisted: persisted.state, url: params.patch });

  /*
   * The one signal wave 1 hangs every bytes-owning control on.
   *
   * `?cam=1` / `?cam=0` overrides it, and that is a simulator seam rather than a
   * feature: whether this page is CAM's own window is a property of the browser,
   * so without the override neither side of the gate can be exercised by an
   * automated run or by a contributor with no CAM installed. Same shape, and the
   * same reason, as `?sim=` for the panel geometry.
   */
  const camDetected =
    params.flags.cam ?? (peekNzxt() !== null || /Electron/i.test(navigator.userAgent));
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

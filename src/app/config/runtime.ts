/** Assembled once by `mount.tsx` and handed down to the views. */

import type { AppState, DeepPartial } from '../../state/schema';
import type { Store } from '../../state/store';
import type { Role } from '../../sync/types';

export interface ConfigRuntime {
  store: Store;
  /**
   * `config` inside CAM's Configuration Browser, `remote` in any other browser.
   *
   * Both publish `state` and `cmd` and subscribe to `state` and `tele` — the
   * distinction exists so the display can tell a phone from the CAM window in
   * telemetry, and so only the CAM window offers file-picker flows that a
   * separate browser profile physically cannot perform.
   */
  role: Role;
  /** The layers behind the resolved state, so sync can re-resolve on a remote message. */
  persisted: DeepPartial<AppState>;
  url: DeepPartial<AppState>;
  /**
   * True when this page is CAM's own Configuration Browser rather than an
   * ordinary browser tab: `window.nzxt` is present, or the UA says Electron.
   */
  camDetected: boolean;
  /** Canonical install URL with the trailing slash. */
  appUrl: string;
}

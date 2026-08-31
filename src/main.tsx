/**
 * The single entry point — deliberately tiny.
 *
 * It statically imports NOTHING mode-specific, then `await import()`s exactly
 * one mount module. That is what keeps React, `src/ui`, every config view and
 * every module panel off the hidden Kraken Browser's download path.
 */
import { detectMode } from './boot/detectMode';

const container = document.getElementById('root');
if (!container) throw new Error('kraken-hub: #root is missing from index.html');

if (detectMode(window.location.search) === 'display') {
  void import('./app/display/mount').then((m) => {
    m.mountDisplay(container);
  });
} else {
  void import('./app/config/mount').then((m) => {
    m.mountConfig(container);
  });
}

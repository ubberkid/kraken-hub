/**
 * Which of the two pages are we?
 *
 * CAM opens the SAME url twice: the visible Configuration Browser with no
 * parameters, and the hidden Kraken Browser with `?kraken=1`. That single
 * parameter is the entire mode signal, and it is also the code-splitting seam —
 * the LCD must never download the configuration UI.
 */

export type AppMode = 'display' | 'config';

export function detectMode(search: string): AppMode {
  return new URLSearchParams(search).get('kraken') === '1' ? 'display' : 'config';
}

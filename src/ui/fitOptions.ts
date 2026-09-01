/**
 * The fit vocabulary, in one place.
 *
 * The design audit found the same control written three times in three different
 * wordings — home said "Fill · **Cover**", the remote said "Cover — fill the
 * panel, crop the **edges**", and the video panel said "Cover — fill the panel,
 * crop the **overflow**" — so a user who learned it in one place had to learn it
 * again in the next.
 *
 * One word each; the sentence that used to live inside every `<option>` is the
 * `title`, where it explains without being read aloud every time. It lives in a
 * `.ts` file rather than beside `FitControl` because React Fast Refresh (and the
 * lint rule that guards it) requires a `.tsx` module to export components and
 * nothing else — and this list has three renderings: a segment row on the config
 * surfaces, and a `<select>` on the phone remote, where a segment row is a poor
 * fit for a thumb-width column.
 */

import type { RenderSettings } from '../state/schema';

export const FIT_SEGMENTS: readonly {
  value: RenderSettings['fit'];
  label: string;
  title: string;
}[] = [
  { value: 'cover', label: 'Cover', title: 'Fills the panel and crops the edges.' },
  { value: 'contain', label: 'Contain', title: 'Shows the whole picture, with bars.' },
  { value: 'contain-circle', label: 'Circle', title: 'Fits inside the round bezel.' },
  { value: 'fill', label: 'Stretch', title: 'Stretches to the panel. Distorts.' },
];

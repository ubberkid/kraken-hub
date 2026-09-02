/**
 * The handful of vocabulary terms a DISPLAY-path file is allowed to say.
 *
 * `config/vocabulary.ts` is the app's dictionary and it is a config-surface
 * file in every sense but its import graph: CAM's panels, the remote's cards
 * and the download ladder are what need it. Exactly one eager module on the
 * display path reaches for a word from it — `modules/video/index.ts`, whose
 * one-line `summary` says a copy is kept — and a static import of the whole
 * dictionary put ~0.38 kB gzip of config-only strings into `core`, which is
 * the chunk the hidden Kraken Browser downloads before the LCD shows anything.
 *
 * So the dictionary is split at the line the bundler can actually see. This
 * file holds the terms a display-path file may import; `vocabulary.ts` imports
 * and RE-EXPORTS every one of them, so nothing else in the app has to know the
 * split exists and there is still exactly one spelling of each word.
 *
 * Deliberately dependency-free, like the file it was cut from.
 */

/**
 * Where a kept copy lives — the ONE destination phrase in the product.
 *
 * Not "to your Kraken": the bytes land in CAM's browser storage on the user's
 * PC, which the LCD then reads. "Your Kraken" is who plays it, never where it
 * is kept, and the two were used interchangeably.
 *
 * Owner-only (`OWNER_ONLY_TERMS`): it names a machine the reader may not be
 * sitting at, so only a surface that owns the bytes may say it.
 */
export const COPY_HOME = 'on this PC';

/** A copy that landed. Owner-only, for the same reason as `COPY_HOME`. */
export const KEPT_A_COPY = `kept ${COPY_HOME}`;

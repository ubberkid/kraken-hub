/**
 * The words the product uses for the things it does, written once.
 *
 * Round 3's F7: the round-2 "one voice" pass unified the HOME screen and left
 * the rest of the app speaking its own dialect. `LibraryView` still rendered
 * *"Saving to your Kraken…"* — the exact phrase `HomeView`'s own comment
 * documents as killed — and the destination of a kept copy flipped between
 * *"on this PC"* and *"to your Kraken"* depending on which file you were
 * reading. One concept had three names and one place had two.
 *
 * A vocabulary that lives in prose cannot be kept: the next surface spells it
 * a fourth way and nothing notices. So the terms live HERE, every surface
 * imports them, and `vocabulary.test.ts` greps the tree to prove no literal
 * duplicate survives — including the dead spellings, which are banned outright.
 *
 * The same shape `src/config/camPaths.ts` uses for CAM's menu paths, and for
 * the same reason. Deliberately dependency-free.
 */

// ---------------------------------------------------------------------------
// Keeping a copy — one concept, three tenses
// ---------------------------------------------------------------------------

/** The choice, offered. An imperative, because it is a control. */
export const KEEP_A_COPY = 'Keep a copy';

/** The same thing while it is happening. A stage in a story, not a property. */
export const KEEPING_A_COPY = 'Keeping a copy';

/** The other side of the choice. */
export const STREAM_ONLY = 'Stream only';

/**
 * Where a kept copy lives — the ONE destination phrase in the product.
 *
 * Not "to your Kraken": the bytes land in CAM's browser storage on the user's
 * PC, which the LCD then reads. "Your Kraken" is who plays it, never where it
 * is kept, and the two were used interchangeably.
 */
export const COPY_HOME = 'on this PC';

/** The row that offers the choice. Named by the destination, so the options can be the verbs. */
export const KEEP_A_COPY_LABEL = 'On this PC';

/** A copy in flight, on a tile or in the ladder. */
export const KEEPING_A_COPY_NOW = `${KEEPING_A_COPY} ${COPY_HOME}…`;

/** A copy that landed. */
export const KEPT_A_COPY = `kept ${COPY_HOME}`;

// ---------------------------------------------------------------------------
// The dead spellings
// ---------------------------------------------------------------------------

/**
 * Phrasings that must not come back, enforced by `vocabulary.test.ts`.
 *
 * Each one shipped simultaneously with a term above, saying the same thing in
 * different words on a different screen. They are listed rather than deleted
 * and forgotten so the ban is a test rather than a memory.
 */
export const RETIRED_PHRASES: readonly string[] = [
  'Saving to your Kraken',
  'Saved locally',
  'to this PC',
  'kept in your library',
];

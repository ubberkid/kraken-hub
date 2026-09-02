/**
 * Every way a Look file can disappoint you, as a card — never as a code.
 *
 * `parseLookFile` refuses exactly five ways and `resolveMedia` reports one kind
 * of hole, and all six are typed values because the UI is supposed to say
 * something specific about each. What it must never do is print the value: a
 * person handed `wrong-format` learns that something inside the program noticed
 * something, which is the sound an app makes when it does not want to explain.
 *
 * So the table is here, exhaustively typed (a sixth refusal will not compile
 * until it has words), and `lookCards.test.ts` walks it. Two rules the copy
 * follows:
 *
 *  - **Say what the file is, then what to do.** "This file is from a newer
 *    build" is the fact; "update this copy of kraken-hub and open it again" is
 *    the move. A card with only the fact is a shrug with punctuation.
 *  - **Never blame the file for being unusual.** A Look with a layer this build
 *    has never heard of is not refused at all — it is repaired and noted — and
 *    none of these five is that case.
 */

import { MAX_LOOK_FILE_BYTES } from '../../../../../state/look/file';

import type { LookFileRefusal, LookPlaceholder } from '../../../../../state/look/file';

export interface LookCard {
  /** One line, sentence case, no trailing period on a fragment. */
  title: string;
  /** One or two sentences. What happened, and what to do about it. */
  detail: string;
}

/** How many kB a number of `JSON.stringify` units is, for a sentence. */
function kb(bytes: number): string {
  return `${String(Math.round(bytes / 1024))} kB`;
}

/**
 * A refusal → the card. Total over the union.
 *
 * `switch` on the discriminant rather than a lookup table, because three of the
 * five carry a value the sentence uses, and a table of functions would be the
 * same switch with an indirection in front of it.
 */
export function refusalCard(reason: LookFileRefusal): LookCard {
  switch (reason.code) {
    case 'not-json':
      return {
        title: 'That is not a Look file',
        detail:
          'It could not be read as JSON at all. If you copied it out of a message, some of it was probably left behind — try the file itself.',
      };
    case 'not-an-object':
      return {
        title: 'That is not a Look file',
        detail:
          'It is valid JSON, but not a Look: a Look is an object with a format, a name and a set of layers.',
      };
    case 'wrong-format':
      return {
        title: 'That is not a Look file',
        detail:
          'It does not say it is one. A Look starts with a format line naming this app, and this file names something else — so opening it would be a guess.',
      };
    case 'too-big':
      return {
        title: 'That file is too large to be a Look',
        detail: `A Look is a few kilobytes: an arrangement and its settings, never any video or picture data. This one is ${kb(reason.bytes)}, and the limit is ${kb(reason.max)}.`,
      };
    case 'future-version':
      return {
        title: 'That Look is from a newer build',
        detail: `It was written at version ${String(reason.got)} and this build reads up to ${String(reason.max)}. Guessing at what changed could quietly rearrange it, so nothing was opened and your file is untouched — update this copy of kraken-hub and try again.`,
      };
  }
}

/** The cap, restated where the copy above needs it and nowhere else. */
export const LOOK_FILE_LIMIT_KB = kb(MAX_LOOK_FILE_BYTES);

/**
 * Which window is reading the card — because the REMEDY differs and the fact
 * does not.
 *
 * A missing picture on CAM's window is one press away from being found: the
 * library is on that machine. On a phone the library is somewhere else and the
 * useful move is the one the phone can actually make, which is to send the file
 * over. Same hole, two honest next steps — and a card that offered CAM's button
 * on a phone would be an instruction the reader cannot follow.
 */
export type LookSurface = 'cam' | 'phone';

export interface PlaceholderCard extends LookCard {
  /** The button's words. `null` when this surface has no move to offer. */
  action: string | null;
}

/** What CAM's window offers for a hole. */
export const CHOOSE_FROM_LIBRARY = 'Choose from the library';

/** What a phone offers for the same hole. */
export const SEND_FROM_PHONE = 'Send from your phone';

/**
 * A hole in an applied Look, named.
 *
 * The file name is the whole value of this card: "a picture is missing" is a
 * status light, and "Nebula.mp4 is not here" is something a person can act on.
 * A file that never carried a name gets the layer's own name instead, and the
 * copy stops claiming to know which file it was.
 */
export function placeholderCard(
  placeholder: LookPlaceholder,
  surface: LookSurface,
): PlaceholderCard {
  const named = placeholder.ref.name;
  const subject = named === undefined || named === '' ? 'A picture or clip' : `“${named}”`;
  return {
    title: `${subject} is not here yet`,
    detail:
      surface === 'cam'
        ? 'The rest of the Look was applied and this layer is holding its place. Pick something for it and the arrangement is complete.'
        : 'The rest of the Look was applied and this layer is holding its place. Send the file across and it fills in.',
    action: surface === 'cam' ? CHOOSE_FROM_LIBRARY : SEND_FROM_PHONE,
  };
}

/**
 * The shelf is full.
 *
 * Deliberately not phrased as a failure of the user's: fifty live previews is a
 * limit of the GRID, and the thing that has no limit — a folder of exported
 * files — is named in the same breath.
 */
export const SHELF_FULL: LookCard = {
  title: 'Your Looks is full',
  detail:
    'Fifty is as many as this shelf holds at once. Export one you are done with and delete it — an exported Look is a file, and there is no limit on those.',
};

/** The gallery folder is not in this deployment. */
export const GALLERY_UNAVAILABLE: LookCard = {
  title: 'The gallery is not in this build',
  detail:
    'These Looks live as files in the project’s own repository, under looks/. Templates above are the same ten, shipped inside the app.',
};

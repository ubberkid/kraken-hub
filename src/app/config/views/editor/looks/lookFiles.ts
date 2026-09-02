/**
 * Getting a `.krakenlook` out of the app and back in again.
 *
 * Three ways in, deliberately, because they are the three ways a small file
 * actually reaches somebody: a file picker, a drop on the window, and a paste of
 * the text itself out of a message. All three end at `parseLookFile`, which is
 * total — so the sheet has one code path for a good file and one card table for
 * every bad one, whichever door the bytes came through.
 *
 * One way out: a download of the serialised file. **On CAM's configuration
 * window only.** The display never offers it and neither does the phone: a
 * download on the LCD lands in a folder nobody will ever look in, and the panel
 * has no file manager to look with. That is a rule about the SURFACE, so it is
 * enforced by where this module is called rather than by a flag inside it —
 * nothing under `src/app/display` imports it, and invariant I8's display-graph
 * walk fails the build if that ever changes.
 *
 * DOM-touching and therefore not pure, but the two decisions worth testing —
 * what a file is called, and whether a dropped item is worth reading — are pure
 * functions here rather than inlined into a handler.
 */

import { LOOK_FILE_EXTENSION, serializeLookFile } from '../../../../../state/look/file';

import type { LookFile } from '../../../../../state/look/file';

/** The one MIME type an exported Look is offered as. It is JSON; say so. */
const LOOK_MIME = 'application/json';

/**
 * A Look's name → a file name a file system will accept.
 *
 * Conservative on purpose: the set below is the intersection of what Windows,
 * macOS and Linux all tolerate, because a Look exported on one and opened on
 * another is the ordinary case rather than the exotic one. A name that reduces
 * to nothing gets `look`, which is a name rather than an empty extension.
 */
export function lookFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return `${cleaned === '' ? 'look' : cleaned}${LOOK_FILE_EXTENSION}`;
}

/**
 * Hand the file to the browser as a download.
 *
 * An anchor and an object URL rather than the File System Access API: the
 * latter is a permission prompt and a Chromium-only surface, for a two-kilobyte
 * file the user explicitly asked for. The object URL is revoked on the next
 * frame — immediately is too soon, some builds have not started the read.
 */
export function downloadLookFile(file: LookFile, doc: Document = document): string {
  const name = lookFileName(file.name);
  const blob = new Blob([serializeLookFile(file)], { type: LOOK_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  /*
   * A `download` anchor is not a navigation and the no-navigation rule cannot
   * tell the difference from the assignment alone. Invariant 2 exists because
   * the Kraken Browser does not follow navigations — this element is never in
   * the document long enough to be followed, carries `download`, and points at
   * an object URL this function made and revokes. The alternative the rule wants
   * (an `<a href="#/…">`) cannot express "save these bytes".
   */
  // eslint-disable-next-line no-restricted-syntax -- a download, not a navigation; see above
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  requestAnimationFrame(() => {
    URL.revokeObjectURL(url);
  });
  return name;
}

/**
 * Is this dropped or picked file worth reading?
 *
 * By NAME, not by MIME type: browsers report an unregistered extension as an
 * empty type on some platforms and `application/json` on others, and a Look
 * renamed to `.json` by a mail client is still a Look. So anything that could
 * plausibly be text is read, and `parseLookFile` — which is total — decides.
 * The one thing filtered out is the obviously-not-text drop, because reading a
 * 4 GB video as a string to be told it is not JSON is not a refusal, it is a
 * hang.
 */
export function looksReadable(file: { name: string; type: string; size: number }): boolean {
  if (file.size > MAX_READ_BYTES) return false;
  if (file.type.startsWith('video/') || file.type.startsWith('image/')) return false;
  return true;
}

/**
 * The most this module will read off a disk before deciding.
 *
 * Comfortably above `MAX_LOOK_FILE_BYTES` (64 kB) so an oversized Look still
 * reaches the parser and gets the `too-big` card that names the real limit,
 * rather than being silently ignored by a second, undocumented one.
 */
export const MAX_READ_BYTES = 1_048_576;

/** Read a picked or dropped file as text. Rejects nothing: failure is `null`. */
export async function readLookText(file: File): Promise<string | null> {
  if (!looksReadable(file)) return null;
  try {
    return await file.text();
  } catch {
    return null;
  }
}

/**
 * The first plausible Look in a drop.
 *
 * A drop can carry several items and a folder; the sheet takes one Look at a
 * time, so the rule is "the first thing that reads", and everything else is
 * ignored silently. A drop of ten files is a person being imprecise, not a
 * person asking for ten imports.
 */
export async function readDroppedLook(items: readonly File[]): Promise<string | null> {
  for (const item of items) {
    const text = await readLookText(item);
    if (text !== null) return text;
  }
  return null;
}

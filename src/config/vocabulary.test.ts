import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COPY_HOME,
  FLAT_COLOURS_WHY,
  IN_YOUR_LIBRARY,
  KEEPING_A_COPY,
  KEEPING_A_COPY_NOW,
  KEEP_A_COPY,
  KEEP_A_COPY_LABEL,
  KEPT_A_COPY,
  KEPT_VERB,
  LINK_RECEIPT,
  MACHINE_NOUNS,
  NOTHING_KEPT,
  OWNER_ONLY_TERMS,
  RETIRED_PHRASES,
  SAME_NETWORK_NOTE,
  STREAM_ONLY,
} from './vocabulary';

/**
 * The class assertion behind F7.
 *
 * Round 1 and round 2 each fixed the vocabulary on the screen the audit had
 * photographed, and each time the drift reappeared one file over — round 3
 * found `LibraryView` still saying *"Saving to your Kraken…"*, the exact phrase
 * `HomeView` documents as killed. Fixing the string again would buy one more
 * round.
 *
 * So the rule is mechanical: a term in `vocabulary.ts` may appear in the source
 * tree exactly once — in `vocabulary.ts` — and every surface that says it must
 * import it. A retired spelling may not appear at all. Adding a second literal
 * copy of either is a failing test rather than an audit finding.
 */

const SRC = new URL('..', import.meta.url).pathname;

/** Files that are allowed to hold the literals: the definition, and this test. */
const ALLOWED = new Set(['config/vocabulary.ts', 'config/vocabulary.test.ts']);

/**
 * The file with its commentary removed.
 *
 * The rule is about what the APP says, not about what the code is allowed to
 * discuss: a comment explaining that "Saved locally ✓" was deleted has to be
 * able to name the thing it deleted, and a doc-comment recording why the
 * vocabulary exists is the most useful place the old spelling can appear. What
 * must not survive is a second *rendered* copy.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

function sourceFiles(dir: string, rel = ''): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const here = rel === '' ? name : `${rel}/${name}`;
    if (statSync(abs).isDirectory()) {
      out.push(...sourceFiles(abs, here));
    } else if (/\.tsx?$/.test(name)) {
      out.push({ rel: here, text: withoutComments(readFileSync(abs, 'utf8')) });
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).filter((f) => !ALLOWED.has(f.rel));

/**
 * The terms every surface must import rather than retype.
 *
 * `KEEP_A_COPY_LABEL` and `COPY_HOME` are deliberately absent: "On this PC" and
 * "on this PC" are substrings of the composed constants above them, and a term
 * that cannot fail independently is a test that only looks like one.
 */
const SINGLE_SOURCE: readonly string[] = [
  KEEP_A_COPY,
  KEEPING_A_COPY,
  STREAM_ONLY,
  KEEPING_A_COPY_NOW,
  KEPT_A_COPY,
  // Round 4, F4 — the two families that were hand-written twice.
  NOTHING_KEPT,
  FLAT_COLOURS_WHY,
  // Wave 1, A5 — the sentence the one-Kraken model turns on.
  LINK_RECEIPT,
  // Wave 3 — the one honest line about a transfer that could not be made.
  SAME_NETWORK_NOTE,
];

/**
 * Files allowed to import an owner-only term.
 *
 * Every one of these either renders only inside CAM's Configuration Browser, is
 * gated on `ownsBytes()` at the point of use, or names the PC because the PC is
 * what the sentence is genuinely about — a disk that ran out of room is a fact
 * about one machine, and the remedy is on that machine. The list is deliberately
 * short and deliberately explicit: growing it is the moment to ask whether the
 * sentence really is about a machine the reader is sitting at.
 */
const OWNER_SURFACE_FILES: readonly string[] = [
  'app/config/views/LibraryView.tsx',
  'app/config/views/HomeView.tsx',
  // `failureLine` — "there is no room left on this PC for a copy". The location
  // IS the constraint here, and the tile that renders it is reporting somebody
  // else's disk on purpose.
  'app/config/homeState.ts',
  'modules/video/VideoConfigPanel.tsx',
  'modules/image/ImageConfigPanel.tsx',
  // The module registry's one-line summary, rendered in CAM's own panel list.
  'modules/video/index.ts',
];

describe('the app has one vocabulary', () => {
  it('finds source files to check at all', () => {
    // A directory walk that silently found nothing would make every assertion
    // below vacuously true, which is the one way this file could lie.
    expect(FILES.length).toBeGreaterThan(100);
  });

  for (const term of SINGLE_SOURCE) {
    it(`"${term}" is written once, in vocabulary.ts`, () => {
      const offenders = FILES.filter((f) => f.text.includes(term)).map((f) => f.rel);
      expect(offenders, `import it from src/config/vocabulary.ts instead`).toEqual([]);
    });
  }

  for (const dead of RETIRED_PHRASES) {
    it(`"${dead}" is retired and does not come back`, () => {
      const offenders = FILES.filter((f) => f.text.includes(dead)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  /**
   * Round 4's F4, as a rule rather than three string fixes.
   *
   * The Library said **Kept**, **saved** and **stored** about one act, in three
   * places on one screen. The verb is a constant now, and the two other verbs
   * are banned in the shapes they actually appeared in (`RETIRED_PHRASES`
   * carries "Nothing saved" and "Nothing stored"); this pins the composition so
   * a fourth spelling cannot be introduced by editing the constant alone.
   */
  it('the library keeps things, and only keeps them', () => {
    expect(NOTHING_KEPT).toContain(KEPT_VERB);
    expect(KEPT_A_COPY).toContain(KEPT_VERB);
    // …and the two verbs it replaced cannot come back through the constant.
    expect(NOTHING_KEPT).not.toContain('saved');
    expect(NOTHING_KEPT).not.toContain('stored');
  });

  /** The frame-rate economics: one sentence, and short enough to belong in a panel. */
  it('says why the colours are flat in eight words or fewer', () => {
    expect(FLAT_COLOURS_WHY.split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  /**
   * The second axis (wave 1, A5): WHO is allowed to say it.
   *
   * The first pass unified the words and left the speaker unconstrained, which
   * is how "on this PC" — correct in CAM, referentless on a phone — ended up on
   * every surface that imported it. A term about the machine the bytes live on
   * may only be imported by a file that renders on that machine.
   */
  for (const term of OWNER_ONLY_TERMS) {
    it(`"${term}" is only spoken by the surface that owns the bytes`, () => {
      const used = new RegExp(`\\b${term}\\b`);
      const strays = FILES.filter((f) => used.test(f.text))
        .map((f) => f.rel)
        .filter((rel) => !/\.test\.tsx?$/.test(rel) && !OWNER_SURFACE_FILES.includes(rel));
      expect(
        strays,
        `say "${IN_YOUR_LIBRARY}" instead, or gate the surface — see OWNER_ONLY_TERMS`,
      ).toEqual([]);
    });
  }

  /**
   * The third axis: what a file may SAY, not only what it may import.
   *
   * `OWNER_ONLY_TERMS` above pins the import list, and for a wave that looked
   * like enough. It is not: the remote's pin button carried
   * `title="Allow this to be cleared when the disk fills up"` — a machine noun,
   * on a phone, written as a literal — and no import discipline can see it. So
   * these files are read for the nouns themselves.
   *
   * The whole comment-stripped file is scanned rather than only its `title=`
   * attributes, because a tooltip and a rendered sentence fail identically for
   * the reader and a scanner that knows the difference is a scanner with a gap in
   * it. Comments are stripped by `withoutComments`, so the code may still discuss
   * the wording it removed — including this one. Imported constants are
   * identifiers, so `SAME_NETWORK_NOTE` ("Your phone and PC need to be on the
   * same network.") passes: it is the file naming a term the vocabulary owns,
   * which is the behaviour the whole test is trying to produce.
   */
  const REMOTE_RENDERED_FILES: readonly string[] = [
    'app/config/views/RemoteLibrary.tsx',
    'app/config/views/RemoteAdd.tsx',
    'app/config/views/RemoteView.tsx',
    'app/config/views/RemoteRing.tsx',
    'app/config/views/RemoteQuality.tsx',
    'app/config/views/TileArt.tsx',
    'app/config/libraryItems.ts',
    'app/config/curationOptimistic.ts',
    'app/config/wireLibrary.ts',
    'app/config/showTile.ts',
  ];

  for (const rel of REMOTE_RENDERED_FILES) {
    it(`${rel} is read for machine nouns at all`, () => {
      // A renamed file would make its noun assertion vacuously true, which is
      // the one way this rule could quietly stop being enforced.
      expect(FILES.map((f) => f.rel)).toContain(rel);
    });
  }

  for (const noun of MACHINE_NOUNS) {
    it(`"${noun}" is not spoken to a window that cannot see one`, () => {
      const offenders = FILES.filter(
        (f) => REMOTE_RENDERED_FILES.includes(f.rel) && f.text.includes(noun),
      ).map((f) => f.rel);
      expect(
        offenders,
        `a remote reader has no "${noun}" — say what the act does instead, or import the term`,
      ).toEqual([]);
    });
  }

  /**
   * ── SPINE 2, enumerated ───────────────────────────────────────────────────
   *
   * The vocabulary rules above answer *what do we call this* and *who may say
   * it*. Round 6 needed a third question — **what did you check before saying
   * it?** — because four surfaces asserted the state of the LCD panel without
   * ever asking whether a panel had been heard from: the download ladder's
   * *"On screen now — Playing on your Kraken"* on a first-run window, the
   * remote's video transport over a room whose display had never spoken, the
   * ring's replica at a guessed geometry, and a link receipt promising a tile
   * into an empty room.
   *
   * Fixing four strings buys one round. So the rule is mechanical and it FINDS
   * violations rather than listing them: any file that renders a claim about
   * the panel must consume `panelPresence`, the one derivation that answers the
   * question. The claim is detected by the words themselves — the "on your
   * Kraken" / "On screen" family — over the comment-stripped source, so a
   * sentence typed inline next month is caught exactly as an imported constant
   * is.
   *
   * ## Why the display graph is excluded, and why that is not a hand-list
   *
   * `src/modules`, `src/render` and `src/diag` render ON the Kraken. Invariant
   * I8 forbids them importing `src/app/config` at all, so they *cannot* consume
   * the spine — and they do not need to: a page running on the panel does not
   * have to wonder whether the panel is there. The exclusion is the architecture
   * saying so, not somebody's memory of which files were fine.
   */
  const PANEL_CLAIM_RE = /on your Kraken|On screen/;

  /** The one derivation. A file that claims must name it. */
  const SPINE = 'panelPresence';

  /** Rendered by the DISPLAY, which is the panel — invariant I8. */
  const ON_THE_PANEL = /^(modules|render|diag|platform|state|sync|transfer|lib|boot)\//;

  it('finds panel claims to check at all', () => {
    // The regex silently matching nothing would make the rule below vacuous —
    // the exact way an enumeration test stops enumerating.
    const claiming = FILES.filter((f) => PANEL_CLAIM_RE.test(f.text));
    expect(claiming.length).toBeGreaterThan(0);
  });

  it('every claim about the panel is made through panelPresence', () => {
    const unwired = FILES.filter(
      (f) =>
        !ON_THE_PANEL.test(f.rel) &&
        f.rel !== 'app/config/panelPresence.ts' &&
        PANEL_CLAIM_RE.test(f.text) &&
        !f.text.includes(SPINE),
    ).map((f) => f.rel);
    expect(
      unwired,
      'these say what the panel is showing without asking — import from app/config/panelPresence.ts',
    ).toEqual([]);
  });

  /**
   * …and the derivation itself is reachable from both apps.
   *
   * A spine only one screen consults is the bug this round is about, one level
   * up. CAM's home screen and the phone's remote are the two roots, and both
   * have to be in the set that names it.
   */
  it('both apps consume the presence spine', () => {
    const consumers = FILES.filter((f) => f.text.includes(SPINE)).map((f) => f.rel);
    expect(consumers).toContain('app/config/views/HomeView.tsx');
    expect(consumers).toContain('app/config/views/RemoteView.tsx');
  });

  it('composes the destination into every phrase that names one', () => {
    expect(KEEPING_A_COPY_NOW).toContain(COPY_HOME);
    expect(KEPT_A_COPY).toContain(COPY_HOME);
    // The row label is the destination, sentence-cased — not a second wording.
    expect(KEEP_A_COPY_LABEL.toLowerCase()).toBe(COPY_HOME.toLowerCase());
  });
});

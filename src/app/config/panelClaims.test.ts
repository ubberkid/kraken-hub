import { describe, expect, it } from 'vitest';

import { LINK_RECEIPT, LINK_RECEIPT_UNSEEN, NOTHING_KEPT } from '../../config/vocabulary';

import * as claims from './panelClaims';
import {
  CLAIM_HANDOFF_PICKUP,
  CLAIM_NO_KRAKEN_HERE,
  CLAIM_PLAYS_FROM_LINK,
  CLAIM_STREAMING_HEADLINE,
  CLAIM_STREAMING_NO_COPY,
  CLAIM_YOUTUBE_EMBED,
  handoffHeadline,
  linkReceipt,
  nowShowingBadge,
  panelClaimText,
  panelVerb,
  playingLine,
  settledReceipt,
  showingTile,
  type PanelClaimSpec,
} from './panelClaims';

import type { PanelPresence } from './panelPresence';

/**
 * The claim primitive, as arithmetic.
 *
 * `panelPresence.test.ts` pins the derivation — which of the three states two
 * facts produce. This pins what each state is allowed to SAY, which round 6
 * asserted in the same file and round 7 separated for the same reason the code
 * separated: a file that owns the question and the answers is the file every
 * surface imports for the wrong half.
 */

const ALL: readonly PanelPresence[] = ['never-seen', 'quiet', 'live'];

describe('panelClaimText', () => {
  it('picks the tense from the state and nothing else', () => {
    const spec: PanelClaimSpec = { live: 'L', quiet: 'Q', neverSeen: 'N' };
    expect(panelClaimText(spec, 'live')).toBe('L');
    expect(panelClaimText(spec, 'quiet')).toBe('Q');
    expect(panelClaimText(spec, 'never-seen')).toBe('N');
  });

  it('has a sentence for every state, so a claim can never render blank', () => {
    for (const spec of exportedSpecs()) {
      for (const presence of ALL) {
        expect(panelClaimText(spec, presence).trim()).not.toBe('');
      }
    }
  });
});

/**
 * Every `PanelClaimSpec` this module exports, found rather than listed.
 *
 * A hand-written list of claims is the enumeration failure round 4 wrote
 * `FLOW_STAGES` to end: the next claim is added and the property below quietly
 * stops covering it. The shape is inspectable precisely so this can walk it.
 */
function exportedSpecs(): PanelClaimSpec[] {
  const isSpec = (v: unknown): v is PanelClaimSpec =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PanelClaimSpec).live === 'string' &&
    typeof (v as PanelClaimSpec).quiet === 'string' &&
    typeof (v as PanelClaimSpec).neverSeen === 'string';
  return Object.values(claims).filter(isSpec);
}

describe('the never-seen form is never a present-tense claim', () => {
  it('finds claims to check at all', () => {
    // The `Object.values` walk silently finding nothing is the one way this
    // property could pass without testing anything.
    expect(exportedSpecs().length).toBeGreaterThanOrEqual(6);
  });

  /**
   * The whole point of the type, as a property over every claim in the file.
   *
   * A window that has never heard from a Kraken may not say a video *is
   * playing* on it. The present progressive is the tell — "is playing",
   * "Playing", "streaming" — so no exported claim's never-seen form may carry
   * one. `showing` is exempted where it names a configured module rather than a
   * frame (see `panelVerb`), and that exemption is one identifier, not a list of
   * files.
   */
  it('carries no "-ing" panel verb in any never-seen sentence', () => {
    const present = /\b(playing|streaming|fetching)\b/i;
    for (const spec of exportedSpecs()) {
      expect(spec.neverSeen, `never-seen must not be present-progressive`).not.toMatch(present);
    }
  });

  it('names the condition instead, wherever it makes a promise', () => {
    // Each of the three new round-7 claims answers "and when?" rather than
    // simply going quiet: a claim that only ever deletes a sentence reads as a
    // missing feature.
    for (const spec of [CLAIM_YOUTUBE_EMBED, CLAIM_STREAMING_HEADLINE, CLAIM_PLAYS_FROM_LINK]) {
      expect(spec.neverSeen).toContain('connects');
    }
    expect(CLAIM_HANDOFF_PICKUP.neverSeen).toContain('connects');
  });
});

describe('round 7, F2 — the two claims the grep could not see', () => {
  /**
   * `<b>Playing through YouTube</b>`, flat, on a first-run window — directly
   * above the card that was at that same moment correctly refusing to claim a
   * screen.
   */
  it('does not put a YouTube video on a panel nobody has seen', () => {
    expect(panelClaimText(CLAIM_YOUTUBE_EMBED, 'live')).toBe('Playing through YouTube');
    expect(panelClaimText(CLAIM_YOUTUBE_EMBED, 'never-seen')).not.toContain('Playing');
  });

  /** …and the CORS sub-line, which asserted playback in its second clause. */
  it('keeps the server fact in every tense and tenses only the panel clause', () => {
    for (const presence of ALL) {
      expect(panelClaimText(CLAIM_STREAMING_NO_COPY, presence)).toContain(
        'does not allow saving a copy',
      );
    }
    expect(CLAIM_STREAMING_NO_COPY.neverSeen).not.toContain('is playing');
  });
});

describe('the composed claims', () => {
  /**
   * C2 — the ladder's last card.
   *
   * The two shapes are asserted as a pair, in both directions: a settled story
   * on a window that has never met a Kraken must not claim a screen, and one
   * that has must not be demoted to a promise.
   */
  it('settles on a screen only when one has been seen', () => {
    expect(settledReceipt('live').headline).toBe('On screen now');
    expect(settledReceipt('quiet').headline).toBe('On screen now');
    const unseen = settledReceipt('never-seen');
    expect(unseen.headline).toBe('Saved');
    expect(unseen.sub).toBe('Plays when your Kraken connects');
    expect(unseen.sub).not.toContain('Playing');
  });

  /** C5 — the link receipt, on all three fields that print one. */
  it('promises a tile only into a room something is listening in', () => {
    expect(linkReceipt('live')).toBe(LINK_RECEIPT);
    expect(linkReceipt('quiet')).toBe(LINK_RECEIPT);
    expect(linkReceipt('never-seen')).toBe(LINK_RECEIPT_UNSEEN);
    // The one word the unseen receipt must never contain: it is the claim the
    // window cannot check.
    expect(LINK_RECEIPT_UNSEEN).not.toContain('shortly');
  });

  /**
   * Round 7's F4 — and the shelf it was rendered above.
   *
   * "Saved to the library" stood 40 px over **Nothing kept here**: an announced
   * library entry and an empty shelf, in one frame. Nothing has been fetched
   * and nothing has been kept; what was saved is the choice.
   */
  it('does not announce a library entry the shelf then denies', () => {
    expect(LINK_RECEIPT_UNSEEN).not.toContain('library');
    expect(NOTHING_KEPT).not.toContain('library');
    // The frame is `SAVED_HEADLINE`'s, shared with the ladder's settled card, so
    // the two receipts cannot drift into two words for one fact.
    expect(LINK_RECEIPT_UNSEEN.startsWith(settledReceipt('never-seen').headline)).toBe(true);
  });

  /** C3 — the remote's sub-line is a claim about this exact second. */
  it('says nothing at all about playback unless telemetry is fresh', () => {
    expect(playingLine('never-seen', false)).toBeNull();
    expect(playingLine('quiet', false)).toBeNull();
    expect(playingLine('live', false)).toBe('Playing on your Kraken');
    expect(playingLine('live', true)).toBe('Holding on your Kraken');
  });

  it('badges the tile with the queue when there is no screen to be on', () => {
    expect(nowShowingBadge('live')).toBe('On screen');
    expect(nowShowingBadge('quiet')).toBe('On screen');
    expect(nowShowingBadge('never-seen')).toBe('Next up');
  });

  it('names a hand-off only when there is somebody to hand it to', () => {
    expect(handoffHeadline('live')).toBe('Sent to your Kraken');
    expect(handoffHeadline('never-seen')).toBe('Saved for your Kraken');
    expect(showingTile('live', 'dunes.mp4')).toContain('is on your Kraken.');
    expect(showingTile('never-seen', 'dunes.mp4')).toContain('is next up');
  });
});

describe('panelVerb', () => {
  /**
   * The status line's one word, written once — it was in three files.
   *
   * The live dot carries the tense (`Status.live`), which is why `quiet` keeps
   * the participle; what the verb may never do is describe a panel nobody has
   * seen, so every playback situation falls back to the idle rung there.
   */
  it('never reaches a playback verb on a window that has seen nothing', () => {
    for (const situation of ['playing', 'holding', 'streaming'] as const) {
      expect(panelVerb('never-seen', situation)).toBe('Ready to play');
    }
  });

  it('keeps the words the two apps already shared', () => {
    expect(panelVerb('live', 'playing')).toBe('Playing');
    expect(panelVerb('quiet', 'playing')).toBe('Playing');
    expect(panelVerb('live', 'holding')).toBe('Holding');
    expect(panelVerb('live', 'streaming')).toBe('Streaming');
    expect(panelVerb('never-seen', 'idle')).toBe('Ready to play');
  });

  /** "Showing Clock" is about the configured module, so it survives first run. */
  it('still names the module a non-video panel is set to', () => {
    for (const presence of ALL) expect(panelVerb(presence, 'showing')).toBe('Showing');
  });
});

describe('the install band', () => {
  it('describes the panel it has not found, without apologising for it', () => {
    expect(panelClaimText(CLAIM_NO_KRAKEN_HERE, 'never-seen')).toBe(
      'No Kraken is showing this page.',
    );
  });
});

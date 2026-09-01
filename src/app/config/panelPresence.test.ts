import { describe, expect, it } from 'vitest';

import { LINK_RECEIPT, LINK_RECEIPT_UNSEEN } from '../../config/vocabulary';

import {
  PRESENCE_FRESH_MS,
  linkReceipt,
  panelIsKnown,
  panelIsLive,
  panelPresence,
  playingLine,
  settledReceipt,
  type PanelPresence,
} from './panelPresence';

/**
 * The presence spine, as arithmetic.
 *
 * Everything the four round-6 findings turn on is decided here, which is the
 * whole point of the file existing: a rule that lives in one pure function can
 * be pinned once instead of being re-asserted on four screens.
 */

const NOW = 1_000_000;

describe('panelPresence', () => {
  it('is never-seen when nothing has ever published anything', () => {
    expect(panelPresence({ everSeen: false, lastSeenAt: null }, NOW)).toBe('never-seen');
  });

  it('is quiet when a display was seen once and has since gone silent', () => {
    expect(panelPresence({ everSeen: true, lastSeenAt: null }, NOW)).toBe('quiet');
    expect(panelPresence({ everSeen: true, lastSeenAt: NOW - PRESENCE_FRESH_MS - 1 }, NOW)).toBe(
      'quiet',
    );
  });

  it('is live while telemetry is fresh', () => {
    expect(panelPresence({ everSeen: true, lastSeenAt: NOW - 1 }, NOW)).toBe('live');
  });

  /**
   * A packet in hand beats a latch that says nothing ever arrived.
   *
   * The remote is the case: it has no `displaySeen` key of its own, so its
   * `everSeen` is derived from the very packet that also makes it live. A rule
   * that required both would leave the phone permanently never-seen.
   */
  it('is live on a fresh packet even with no latched history', () => {
    expect(panelPresence({ everSeen: false, lastSeenAt: NOW - 1 }, NOW)).toBe('live');
  });

  /**
   * `now === 0` is "not sampled yet", not 1970.
   *
   * `RemoteView` samples its clock from an interval rather than during render,
   * so the first frame after a packet genuinely has `now === 0`. Treating that
   * as a 56-year-old packet would tear the whole instrument down for one frame.
   */
  it('does not judge freshness before the clock has been sampled', () => {
    expect(panelPresence({ everSeen: false, lastSeenAt: NOW }, 0)).toBe('live');
  });

  it('takes the freshness window as a parameter rather than owning a clock', () => {
    const facts = { everSeen: true, lastSeenAt: NOW - 500 };
    expect(panelPresence(facts, NOW, 100)).toBe('quiet');
    expect(panelPresence(facts, NOW, 1000)).toBe('live');
  });
});

describe('what each state lets the app say', () => {
  const ALL: readonly PanelPresence[] = ['never-seen', 'quiet', 'live'];

  it('permits the present tense only when telemetry is fresh', () => {
    expect(ALL.filter(panelIsLive)).toEqual(['live']);
  });

  it('permits naming a destination for anything but a Kraken never seen', () => {
    expect(ALL.filter(panelIsKnown)).toEqual(['quiet', 'live']);
  });

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

  /** C3 — the remote's sub-line is a claim about this exact second. */
  it('says nothing at all about playback unless telemetry is fresh', () => {
    expect(playingLine('never-seen', false)).toBeNull();
    expect(playingLine('quiet', false)).toBeNull();
    expect(playingLine('live', false)).toBe('Playing on your Kraken');
    expect(playingLine('live', true)).toBe('Holding on your Kraken');
  });
});

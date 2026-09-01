/**
 * "Is there a Kraken on the other end, and is it saying anything right now?"
 *
 * ## The spine, and the six screenshots that asked for it
 *
 * Round 6 found four separate surfaces asserting the state of the LCD panel
 * without ever consulting whether a panel had been heard from:
 *
 *  - **C2** the home screen's download ladder settled on *"On screen now —
 *    Playing on your Kraken"* on a first-run window, under a card that was at
 *    that same moment explaining how to install CAM.
 *  - **C3** the remote mounted a video transport — title, scrubber, loop
 *    handles, ±10, quality — for a room whose display had never spoken, and did
 *    it whatever module the synced state said was actually on the panel.
 *  - **C4** the remote's ring mounted a real module renderer at a guessed
 *    geometry, so a 640 px dial was laid out in a 132 px box at `scale(1)`.
 *  - **C5** the phone's link receipt promised *"a tile appears here shortly"*
 *    into a room with nobody in it.
 *
 * Each of those had its own private notion of "connected" — `paired`,
 * `displaySeen`, `displayOnline`, `sync.monitor !== null` — and each of them
 * was a different question answered as though it were the same one. Fixing four
 * strings would have bought exactly one round, which is the lesson the previous
 * five rounds are made of. So there is ONE question, asked here, and every
 * claim about the panel is derived from its answer.
 *
 * ## Three states, because there are three
 *
 *  - **`never-seen`** — nothing the display publishes has ever been observed by
 *    this window. A brand-new CAM install; a phone paired into a room whose
 *    Kraken is switched off. The app may say what it has *saved*, and nothing
 *    about what is *showing*.
 *  - **`quiet`** — a display has been seen, but not lately. CAM is closed, the
 *    PC is asleep, the phone has been in a pocket. The configured source is
 *    genuinely what the panel will show; it is not something the app can watch
 *    happening.
 *  - **`live`** — telemetry is fresh. Only here may the app speak in the
 *    present tense about the panel.
 *
 * ## Where the two facts come from
 *
 * Deliberately injected rather than read, because the two apps have different
 * evidence and neither one's is available to the other:
 *
 *  - **CAM** shares the display's origin, so `displaySeen.hasDisplayBeenSeen()`
 *    is a latched fact in `localStorage` and freshness is the video telemetry
 *    mirror's own `ts`.
 *  - **the remote** shares nothing but a room, so "ever seen" means a telemetry
 *    packet has arrived on this connection at all, and freshness is when the
 *    last one landed on THIS device's clock.
 *
 * Keeping the derivation pure is what lets it be one rule: the file has no
 * imports beyond the words, no storage access and no clock of its own.
 */

import {
  HOLDING_ON_KRAKEN,
  IS_NEXT_UP,
  IS_ON_YOUR_KRAKEN,
  LINK_RECEIPT,
  LINK_RECEIPT_UNSEEN,
  NEXT_UP_BADGE,
  ON_SCREEN_BADGE,
  ON_SCREEN_NOW,
  PLAYING_ON_KRAKEN,
  PLAYS_WHEN_CONNECTED,
  SAVED_FOR_KRAKEN,
  SAVED_HEADLINE,
  SENT_TO_KRAKEN,
} from '../../config/vocabulary';

export type PanelPresence = 'never-seen' | 'quiet' | 'live';

/**
 * Older than this and the present tense would be a guess.
 *
 * Twelve seconds is six missed packets at telemetry's slow rate (0.2 Hz in
 * performance mode) — long enough never to flicker on a busy display, short
 * enough that a closed CAM window stops being described as a running one while
 * the person is still looking at the screen. It is the same number
 * `RemoteView`'s transport already greyed itself out on; that constant is this
 * one now.
 */
export const PRESENCE_FRESH_MS = 12_000;

export interface PresenceFacts {
  /**
   * Has ANYTHING the display published ever been observed by this window?
   *
   * Latched in CAM (`displaySeen.ts`), per-connection on the remote. False is a
   * strong statement: it means this window has never had evidence that the
   * other end exists.
   */
  everSeen: boolean;
  /**
   * When the freshest evidence landed, or `null` for none.
   *
   * Compared against `now`, so both must be on the same clock — see the header
   * for which clock each app uses and why they are allowed to differ.
   */
  lastSeenAt: number | null;
}

/**
 * The one derivation.
 *
 * `now === 0` is "the clock has not been sampled yet", which several callers
 * genuinely start at (React may render before the interval's first tick), and
 * it is treated as *do not judge freshness* rather than as 1970 — extrapolating
 * a 56-year-old packet age would make every fresh feed read as quiet for one
 * frame and flicker the entire instrument.
 */
export function panelPresence(
  facts: PresenceFacts,
  now: number,
  freshMs: number = PRESENCE_FRESH_MS,
): PanelPresence {
  const { lastSeenAt } = facts;
  if (lastSeenAt !== null && (now === 0 || now - lastSeenAt < freshMs)) return 'live';
  return facts.everSeen ? 'quiet' : 'never-seen';
}

/**
 * May the app speak in the present tense about the panel?
 *
 * The gate on anything that claims something is happening *right now*: the
 * remote's "Playing on your Kraken ·" sub-line, the halo's live dot.
 */
export function panelIsLive(presence: PanelPresence): boolean {
  return presence === 'live';
}

/**
 * Has a Kraken ever been on the other end of this window?
 *
 * The gate on anything that claims a destination — a receipt that says a link
 * was *sent*, a card that says a video is on a screen. `quiet` passes: the
 * display exists, this window simply is not watching it at this instant, and
 * refusing to name it would be as wrong in the other direction.
 */
export function panelIsKnown(presence: PanelPresence): boolean {
  return presence !== 'never-seen';
}

/**
 * The download ladder's last card — C2.
 *
 * Two lines, so the caller cannot compose a third wording out of them.
 */
export function settledReceipt(presence: PanelPresence): { headline: string; sub: string } {
  return panelIsKnown(presence)
    ? { headline: ON_SCREEN_NOW, sub: PLAYING_ON_KRAKEN }
    : { headline: SAVED_HEADLINE, sub: PLAYS_WHEN_CONNECTED };
}

/**
 * The receipt a link gets, wherever it was handed over — C5.
 *
 * All three link fields (the phone's Add panel, CAM's Library Add panel, the
 * remote's source row) print whichever of the two this returns, so the sentence
 * cannot be right on one surface and wrong on the next.
 */
export function linkReceipt(presence: PanelPresence): string {
  return panelIsKnown(presence) ? LINK_RECEIPT : LINK_RECEIPT_UNSEEN;
}

/**
 * The badge on the highlighted tile, on BOTH shelves.
 *
 * The two shelves each typed "On screen" into their own tile, and neither had
 * asked whether there was a screen: the badge is derived from the configured
 * module and source, which is what the panel WILL show, not evidence that it
 * is showing it. On a window that has never heard from a Kraken the honest
 * word is the queue's.
 */
export function nowShowingBadge(presence: PanelPresence): string {
  return panelIsKnown(presence) ? ON_SCREEN_BADGE : NEXT_UP_BADGE;
}

/**
 * The Library's receipt for pressing a tile.
 *
 * *"“dunes.mp4” is on your Kraken."* is the same assertion the ladder's last
 * card makes, printed by a different file, and it was made with the same
 * evidence: none.
 */
export function showingTile(presence: PanelPresence, name: string): string {
  return `“${name}” ${panelIsKnown(presence) ? IS_ON_YOUR_KRAKEN : IS_NEXT_UP}`;
}

/**
 * The ladder's middle card for an acknowledged link.
 *
 * "Sent to your Kraken" names a hand-off. With nothing ever seen on the other
 * end there has not been one — the URL is in a document waiting to be read.
 */
export function handoffHeadline(presence: PanelPresence): string {
  return panelIsKnown(presence) ? SENT_TO_KRAKEN : SAVED_FOR_KRAKEN;
}

/**
 * The remote's sub-line, which is a claim about this exact second.
 *
 * `null` when the app must not make one — which is every state but `live`, and
 * is why the caller renders nothing rather than a greyed-out sentence.
 */
export function playingLine(presence: PanelPresence, held: boolean): string | null {
  if (!panelIsLive(presence)) return null;
  return held ? HOLDING_ON_KRAKEN : PLAYING_ON_KRAKEN;
}

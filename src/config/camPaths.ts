/**
 * The two places in CAM a user is ever sent, written once.
 *
 * Round 2's R6 counted the variants shipping side by side: *"Lighting → Kraken
 * → Web Integration → Frame Rate"*, *"Web Integration → Frame Rate"*, *"CAM →
 * Lighting → your Kraken → Mode: Web Integration → Frame Rate"*, *"CAM →
 * Kraken → Configure"*, *"CAM → Lighting → Kraken → Configure"* — five spellings
 * of two destinations, across the display's error cards, the config UI, the
 * validators and the docs. A user following one of them and finding a menu
 * whose words do not match concludes the instruction is stale.
 *
 * So there are exactly two constants, and every surface imports them. They are
 * written the way CAM's own menus read, including the possessive **your**
 * Kraken — the one in the machine, not a product category.
 *
 * This file is deliberately dependency-free and lives outside `src/ui` and
 * `src/app/config`, because the display graph needs it too (invariant I8, and
 * `budgets.json`'s `displayGraph.forbidden` list).
 */

/** Where CAM's frame-rate slider lives. It ships at 1 FPS; nothing else matters until it is raised. */
export const CAM_PATH_FRAME_RATE = 'CAM → Lighting → your Kraken → Web Integration → Frame Rate';

/** Where the configuration browser for this card is opened from. */
export const CAM_PATH_CONFIGURE = 'CAM → Lighting → your Kraken → your kraken-hub card → Configure';

/*
 * The frame-rate INSTRUCTION, not just the path (round 3, minors).
 *
 * The path being written once did not stop the sentence around it from being
 * written four ways: the About card said *"drag … to maximum"*, the home banner
 * said *"→ drag it to maximum"*, the display's own banner said *"— drag it to
 * maximum"*, and the first-run band said *"turn CAM → Lighting → your Kraken →
 * Web Integration → Frame Rate up"* — a garden path that puts a five-step menu
 * route between a verb and its particle, so the reader reaches "up" having
 * forgotten what it attaches to.
 *
 * So the grammar is a constant too, and About's is the one that won: a verb, the
 * path, a destination. It is exported in three pieces only because JSX needs to
 * bold the middle one; `CAM_FRAME_RATE_INSTRUCTION` is the same sentence for
 * surfaces that build plain text, and `camPaths.test.ts` pins the two together.
 */

/** The verb, before the path. */
export const CAM_FRAME_RATE_LEAD = 'drag';

/**
 * The same verb, for a surface where the instruction STARTS the sentence.
 *
 * Round 13, M2. Derived, never retyped: change the verb above and this follows.
 * JSX surfaces that bold the path themselves (`HomeView`'s `kh-fps-banner`)
 * pick this or `CAM_FRAME_RATE_LEAD` by grammar; plain-text surfaces get the
 * same choice through `fpsAdvisoryBody({ leadIn: true })`.
 */
export const CAM_FRAME_RATE_LEAD_SENTENCE = `${CAM_FRAME_RATE_LEAD.charAt(0).toUpperCase()}${CAM_FRAME_RATE_LEAD.slice(1)}`;

/** Where to drag it to, after the path. */
export const CAM_FRAME_RATE_TAIL = 'to maximum';

/** The whole instruction, for surfaces that cannot mark up the middle. */
export const CAM_FRAME_RATE_INSTRUCTION = `${CAM_FRAME_RATE_LEAD} ${CAM_PATH_FRAME_RATE} ${CAM_FRAME_RATE_TAIL}`;

/**
 * The low-frame-rate advisory's body, in the video module's own overlay.
 *
 * `maxTargetFps` is the maximum CAM offers **for the panel actually attached**,
 * resolved from `devicePresets` by the caller. The copy used to end with a
 * hardcoded *"(40 on Elite)"*, which is a number a Kraken Z (1) and a Kraken
 * 2023 (25) user can watch their slider fail to reach. `null` — an unrecognised
 * panel — prints the instruction and stops, because a maximum we cannot name is
 * one we must not invent.
 *
 * This file takes the number rather than importing the preset table, so it stays
 * dependency-free for the display graph (invariant I8).
 */
export interface FpsAdvisoryOptions {
  /**
   * `true` when the sentence STARTS a paragraph rather than continuing one.
   *
   * Round 13, M2: the same string is used two ways. On the About card and in
   * `CamSetupCard` it is the tail of a longer sentence, so it must begin
   * mid-sentence in lowercase. On the display's advisory card and the config
   * home banner it is the whole paragraph, and it shipped starting on a
   * lowercase verb — *"drag CAM → …"* — which §6.3 named as a defect. Both
   * forms come from here, so there is still exactly one instruction; only its
   * first letter differs, and only where grammar requires.
   */
  readonly leadIn?: boolean;
}

export function fpsAdvisoryBody(
  maxTargetFps: number | null,
  options: FpsAdvisoryOptions = {},
): string {
  const ceiling =
    maxTargetFps === null || !Number.isFinite(maxTargetFps) || maxTargetFps <= 0
      ? ''
      : ` (${String(Math.round(maxTargetFps))} FPS on this panel)`;
  const instruction =
    options.leadIn === true
      ? `${CAM_FRAME_RATE_LEAD_SENTENCE} ${CAM_PATH_FRAME_RATE} ${CAM_FRAME_RATE_TAIL}`
      : CAM_FRAME_RATE_INSTRUCTION;
  return `${instruction}${ceiling}.`;
}

/**
 * What the step-cards under the paste box are allowed to say — enumerated.
 *
 * The names are outcomes, not failures, because **a download is an enhancement
 * layered on playback and its failure is never a failure of playback**. Four of
 * the six are terminal-and-fine:
 *
 *  - `streaming` — the server sent no `Access-Control-Allow-Origin`, so `fetch`
 *    cannot READ bytes that a plain `<video src>` plays without complaint. Most
 *    of the web is like this. The video is on the panel; only the local copy is
 *    missing.
 *  - `youtube-embed` — no companion, so the geometry engine is playing the
 *    video, exactly as designed (§6.4: *"users never see a hard error for a
 *    resolver miss"*). The card is an invitation, not a diagnosis.
 *  - `unsaved` — something else went wrong while keeping the copy (a 500, no
 *    room on disk). Still not an error card: the display's own fallback chain
 *    has already put something on the panel or shown its own card.
 *  - `accepted` — the link is recognised and configured, and nothing has told us
 *    anything else yet. This is the state a pasted `.mp4` was in for the whole
 *    of the design audit, and it said NOTHING: the same gesture that produced
 *    three cards for a YouTube link produced a blank page for a direct file
 *    (F4). Silence after the primary action is the app's single worst moment,
 *    so the acknowledgement is unconditional now and the *contents* of the
 *    second card are what vary by source.
 *
 * The regression the type exists to prevent: the redesign rendered a browser
 * `TypeError` ("Failed to fetch") as the second step's copy for `streaming`, for
 * the FIRST entry in a mirror nobody prunes — so one CORS-less link left every
 * later paste, YouTube included, looking broken.
 *
 * ## Why this is a LIST, and why it lives in a file of its own (round 4, F1)
 *
 * It was a bare union, which is exactly as much as `homeState.receiptPersists`'s
 * exhaustive `switch` needs and not enough for anything that has to *visit*
 * every stage. So the page-fit suite could only measure the states somebody had
 * thought to write down — and the receipt, a ~180 px object produced by the
 * app's own primary action, was in none of them. It overflowed CAM's window by
 * 179 px for a whole round while a twelve-state fit assertion passed.
 *
 * The list is the source of truth now and the type derives from it, so a new
 * stage is a new tested state by construction. It is in its own dependency-free
 * module — the shape `config/camPaths.ts` and `config/vocabulary.ts` use — so
 * the e2e suite can import the enumeration without pulling the whole config
 * graph (and its `import.meta.env`) into Playwright's TypeScript program.
 */
export const FLOW_STAGES = [
  'downloading',
  'stored',
  'streaming',
  'unsaved',
  'youtube-embed',
  'accepted',
] as const;

export type FlowStage = (typeof FLOW_STAGES)[number];

/**
 * Every present-tense sentence the config surfaces are allowed to say about the
 * LCD panel — as a TYPE, not as a phrase.
 *
 * ## Why this file exists, and why round 6's spine was not enough
 *
 * Round 6 built `panelPresence.ts`: one derivation of *is there a Kraken on the
 * other end, and is it saying anything right now?*, so four screens could stop
 * inventing four private answers. It was enforced by a grep — a file that
 * matched `/on your Kraken|On screen/` had to also contain the word
 * `panelPresence`.
 *
 * Round 7 measured what that buys. The **paste** spine held, because
 * `pasteLink.ts` owns the door: there is no way to submit a link except through
 * `pasteAction`, so a new field cannot bypass the mapping — it is a compile
 * error, not a lint. The **presence** spine leaked, because it was a two-phrase
 * grep satisfied per file by a single import: `HomeView.tsx` imports
 * `panelPresence`, therefore every string in its 1,382 lines passes, including
 * `<b>Playing through YouTube</b>` and *"your Kraken is playing it straight
 * from the web"* — two unconditional present-tense claims about a panel this
 * window may never have heard from, sitting six pixels from a card that asks
 * the question properly.
 *
 * A rule that is satisfied by an import is a rule about imports. So the claim
 * is a type now:
 *
 *  - a claim is a {@link PanelClaimSpec} — the same sentence in three tenses,
 *    one per {@link PanelPresence} state;
 *  - the only way to render one is {@link PanelClaim} or {@link panelClaimText},
 *    and both REQUIRE a presence argument, so there is no signature that
 *    renders a claim without asking;
 *  - the sentences themselves live here and in `config/vocabulary.ts` and
 *    nowhere else, which `vocabulary.test.ts` proves by scanning every config
 *    surface's string literals and JSX text for the panel-verb family. A raw
 *    literal anywhere else is a failing test rather than an audit screenshot.
 *
 * ## The three tenses
 *
 * `panelPresence.ts` documents why there are three states; this is what each
 * one lets the app *say*:
 *
 *  - **live** — telemetry is fresh, so the present progressive is a fact:
 *    *"Playing through YouTube"*.
 *  - **quiet** — a display has been seen but is not talking. The configured
 *    source is genuinely what the panel shows; it is not something this window
 *    can watch happening, so the tense is the habitual present: *"Plays through
 *    YouTube"*.
 *  - **never-seen** — nothing has ever published anything here. The only honest
 *    form is the conditional future: *"Plays through YouTube when your Kraken
 *    connects"*.
 *
 * Some claims collapse two states deliberately, and that is the point of the
 * triple: it makes the collapse an explicit, reviewable decision per sentence
 * instead of an accident of whichever boolean the author reached for. Each one
 * below says which it collapses and why.
 *
 * The RENDERER lives beside this in `PanelClaim.tsx`, and only because Fast
 * Refresh requires a `.tsx` module to export components and nothing else — the
 * same split `ui/fitOptions.ts` makes for the same reason. The words are here;
 * the element that draws them is one import away and cannot be given anything
 * this file did not tense.
 *
 * ## What is NOT here
 *
 * `panelPresence.ts` keeps the derivation and nothing else — it is pure,
 * dependency-free arithmetic over two facts, and it stays that way so it can be
 * unit-tested without a DOM and read on any surface. The words moved here
 * because the words need React, and because a file that owns both the question
 * and the answers is the file everything imports for the wrong half.
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

import { panelIsKnown, panelIsLive, type PanelPresence } from './panelPresence';

/**
 * One claim, in the three tenses the three presence states support.
 *
 * Deliberately a plain record rather than a function: a claim has to be
 * *inspectable* — `panelClaims.test.ts` walks every exported spec and asserts
 * that the never-seen form carries no present progressive, which is a property
 * of the data and would be unreachable behind a closure.
 */
export interface PanelClaimSpec {
  /** Fresh telemetry. The present progressive is a fact. */
  live: string;
  /** Seen, not talking. The habitual present: what the panel shows. */
  quiet: string;
  /** Never seen. The conditional future, naming the condition. */
  neverSeen: string;
}

/**
 * Every claim this module defines, in definition order.
 *
 * Round 8's E: `panelClaims.test.ts` walked `Object.values(claims)` and so
 * checked the six specs that happen to be **exported** — the six composed
 * claims behind `settledReceipt`/`linkReceipt`/… and all five rungs of
 * `SITUATION_VERB` were structurally unreachable, and the guard against the
 * walk finding nothing (`>= 6`) was satisfied by the exports alone however many
 * private claims were added beside them. A private spec is not a lesser claim;
 * it is the same three sentences with a narrower door, and the honesty property
 * is a property of the sentences.
 *
 * So registration happens where a claim is DEFINED rather than where it is
 * exported: {@link claim} is the only constructor, so nothing can be a
 * `PanelClaimSpec` in this file without landing here. The test asserts the
 * property over all of them and asserts the count matches the number of
 * `claim(` calls in the source, so a claim that somehow skipped the
 * constructor is a failing test rather than a silent gap.
 */
const REGISTRY: PanelClaimSpec[] = [];

/**
 * The registry, for the test that walks it.
 *
 * Data, not a door: a spec is three strings, and the only ways to turn one into
 * a sentence are {@link panelClaimText} and `PanelClaim`, both of which require
 * a {@link PanelPresence}. Reading the list cannot render an untensed claim.
 */
export const REGISTERED_CLAIMS: readonly PanelClaimSpec[] = REGISTRY;

/**
 * Build a claim. Module-private on purpose.
 *
 * If a surface could construct a `PanelClaimSpec` it could type its own three
 * sentences at the call site, and the door this file is would have a hole in
 * it. Callers name a claim; they never write one.
 */
function claim(live: string, quiet: string, neverSeen: string): PanelClaimSpec {
  const spec = { live, quiet, neverSeen };
  REGISTRY.push(spec);
  return spec;
}

/**
 * The one resolution — a claim plus a presence gives a sentence.
 *
 * Used directly where the sentence is a string (an `aria-label`, a `title`, a
 * `Notice`'s text, a status verb); {@link PanelClaim} wraps it for the ordinary
 * case of rendering one into the document.
 */
export function panelClaimText(spec: PanelClaimSpec, presence: PanelPresence): string {
  if (panelIsLive(presence)) return spec.live;
  return panelIsKnown(presence) ? spec.quiet : spec.neverSeen;
}

// ---------------------------------------------------------------------------
// The claims
// ---------------------------------------------------------------------------

/**
 * The paste ladder's second card, for a YouTube link with no companion running.
 *
 * Round 7's F2, half one. It was `<b>Playing through YouTube</b>`, flat, on
 * every window — including a first-run one whose card *directly below* was at
 * that moment correctly refusing to claim a screen. The geometry engine's
 * playback is a real, good outcome (§6.4) and the card should say so; what it
 * may not do is assert it is happening on a panel nobody has heard from.
 */
export const CLAIM_YOUTUBE_EMBED = claim(
  'Playing through YouTube',
  'Plays through YouTube',
  'Plays through YouTube when your Kraken connects',
);

/**
 * …and half two: the sub-line for a source whose server refuses a copy.
 *
 * *"…so your Kraken is playing it straight from the web."* The CORS refusal is
 * a permanent property of the server and is stated in every tense; the panel's
 * playback is not, and only the first word of the second clause changes.
 */
export const CLAIM_STREAMING_NO_COPY = claim(
  'This server does not allow saving a copy, so your Kraken is playing it straight from the web.',
  'This server does not allow saving a copy, so your Kraken plays it straight from the web.',
  'This server does not allow saving a copy, so your Kraken plays it straight from the web when it connects.',
);

/**
 * The ladder's second card for a link that has been accepted and nothing more.
 *
 * The `quiet` and `never-seen` forms are identical, deliberately: "straight
 * away" is a claim about a machine that is listening, and a Kraken that has
 * gone quiet is not listening any more than one that has never been seen. The
 * tail is the same clause `LINK_RECEIPT_UNSEEN` uses, because it is the same
 * promise.
 */
export const CLAIM_HANDOFF_PICKUP = claim(
  'Your Kraken picks it up straight away.',
  'Your Kraken picks it up when it connects.',
  'Your Kraken picks it up when it connects.',
);

/** The ladder's second-card headline when there is no copy to keep at all. */
export const CLAIM_STREAMING_HEADLINE = claim(
  'Streaming from the link',
  'Streams from the link',
  'Streams from the link when your Kraken connects',
);

/**
 * The tail of every "the copy could not be kept" sentence.
 *
 * `homeState.failureLine` owns the REASON — which is a fact about this PC's
 * disk and belongs on the surface that owns the bytes — and composes this on
 * the end, so the one clause that is a claim about the panel is tensed by the
 * one thing that may tense it.
 */
export const CLAIM_PLAYS_FROM_LINK = claim(
  'your Kraken is playing it from the link.',
  'your Kraken plays it from the link.',
  'your Kraken plays it from the link when it connects.',
);

/**
 * The install band's resting headline.
 *
 * A resting state describes what IS, without apologising for it — and what it
 * describes is the panel, so it is a claim. In practice the band only mounts on
 * a window that has never seen a display, which is exactly why the other two
 * forms are written down: the version that is unreachable today is the one a
 * future caller reaches for without noticing.
 */
export const CLAIM_NO_KRAKEN_HERE = claim(
  'Your Kraken is showing this page.',
  'Your Kraken is not showing this page right now.',
  'No Kraken is showing this page.',
);

/**
 * The low-frame-rate banner's opening clause — round 8's D.
 *
 * *"Your Kraken **is running at** 1 FPS"*, flat, in the present progressive,
 * from `readDisplayFacts()` — a number this window last saw at some point and
 * then **persisted to `localStorage`**. It therefore outlives the session that
 * observed it: the first paint of a window opened a week later asserts a frame
 * rate the panel is achieving right now, on the strength of a record.
 *
 * The number itself is worth keeping in every tense — it is the last thing the
 * panel actually reported and the CAM setting it names is the remedy either
 * way — so only the verb moves. The banner composes this, the bolded reading,
 * and the consequence, exactly as `failureLine` composes
 * {@link CLAIM_PLAYS_FROM_LINK}.
 */
export const CLAIM_FRAME_RATE = claim(
  'Your Kraken is running at',
  'Your Kraken runs at',
  'Your Kraken is set to run at',
);

/**
 * …and what the banner says INSTEAD of the instruction — round 12's F12-1.
 *
 * The second half of that banner is *drag CAM → … → Frame Rate to maximum*, and
 * on a Kraken Z the maximum is 1 FPS: `devicePresets.ts` records the ceiling per
 * panel, precisely because round 3 found this advisory ending in a hardcoded
 * *"(40 on Elite)"* that is wrong by a factor of forty on a Z. Telling a person
 * to raise a slider that is already at its top, in the one place they came
 * looking for a remedy, is the same failure one rung up: the app claiming
 * something it can check and has not.
 *
 * The three tenses are deliberately identical. A panel's ceiling is a fact about
 * the hardware, not about whether this window has heard from it — the CLAIM
 * beside it (`CLAIM_FRAME_RATE`) is what carries the tense, and a sentence that
 * changed its verb here would be tensing the wrong noun. It is a claim rather
 * than a bare string so it renders through the one door every panel sentence
 * renders through, and so the registry sees it.
 *
 * `gets` and not `runs at`: the never-seen form may carry no present
 * progressive, and this sentence has to hold in all three.
 */
export const CLAIM_FRAME_RATE_AT_MAX = claim(
  'That is the fastest this panel gets, so there is nothing in CAM left to raise.',
  'That is the fastest this panel gets, so there is nothing in CAM left to raise.',
  'That is the fastest this panel gets, so there is nothing in CAM left to raise.',
);

/**
 * The editor's budget meter, when it is reading a MEASURED frame rate.
 *
 * The meter has two voices and they are not the same claim. This one is only
 * ever shown on a number the DISPLAY published (`TelePacket.achievedFps`): the
 * panel is keeping up, or it is not, and both are facts about a machine on the
 * other end of a telemetry packet. `CLAIM_BUDGET_ESTIMATE` below is the other
 * voice — the declared-cost arithmetic, which is available on a window that has
 * never seen a Kraken and is therefore never allowed to sound like a reading.
 */
export const CLAIM_BUDGET_MEASURED = claim(
  'Your Kraken is keeping up with this look',
  'Your Kraken was keeping up with this look',
  'Your Kraken will report how it copes once it connects',
);

/**
 * …and the same meter when the panel is struggling.
 *
 * Split rather than composed with a negation, because the three tenses are not
 * a negation of the three above: "was falling behind" is a fact about the last
 * reading, and the never-seen form has nothing to report at all.
 */
export const CLAIM_BUDGET_BEHIND = claim(
  'Your Kraken is falling behind this look',
  'Your Kraken was falling behind this look',
  'Your Kraken will report how it copes once it connects',
);

/**
 * The estimate — §7.2's word, and the reason the meter has two voices.
 *
 * Declared cost is arithmetic over what each module SAYS it does. Nothing on
 * this page can see CAM's capture and compressor, which is where a busy look
 * actually gets expensive, so the sum is a prediction and the meter says the
 * word. It is presence-independent in substance — the arithmetic is the same on
 * every window — but it still goes through the spine, because the sentence is
 * about what a panel would do and a window that has never seen one may not
 * imply there is a panel to do it.
 */
export const CLAIM_BUDGET_ESTIMATE = claim(
  'Estimated, until your Kraken reports a frame rate',
  'Estimated, from what each layer says it costs',
  'Estimated, from what each layer says it costs',
);

/*
 * ── The same three claims, at the width the meter actually has ──────────────
 *
 * Round 10's F10. `.kh-meter__label` is capped at 22ch beside a 120 px bar and a
 * figure; measured at 866×537 it wanted 275 px and got 182, so every one of the
 * three sentences above rendered as *"Estimated, from what each la…"* — an
 * ellipsis where the honesty was.
 *
 * The long sentence is still the right sentence and it is still said: it is the
 * meter's `title`, beside the attribution. What the LABEL needs is the two or
 * three words that fit, and those are claims too — they are the same assertion
 * about the same panel, so they go through the same door rather than being
 * typed into `EditorHeader.tsx` as literals.
 */

/** The measured voice, short. Paired with {@link CLAIM_BUDGET_MEASURED}. */
export const CLAIM_BUDGET_MEASURED_SHORT = claim('Keeping up', 'Kept up', 'No reading yet');

/** The measured voice when the panel is behind. Pairs with {@link CLAIM_BUDGET_BEHIND}. */
export const CLAIM_BUDGET_BEHIND_SHORT = claim('Falling behind', 'Fell behind', 'No reading yet');

/**
 * …and the declared-cost voice, short.
 *
 * One word in all three tenses, and deliberately: an estimate is arithmetic
 * this window does on its own, so there is no fact about the other end whose
 * tense could move. What the tense would have carried — *until your Kraken
 * reports a frame rate* — is in the long form, which is what the tooltip says.
 */
export const CLAIM_BUDGET_ESTIMATE_SHORT = claim('Estimate', 'Estimate', 'Estimate');

/**
 * The readings in the editor's halo are the simulator's — round 10's F8.
 *
 * The editor mounts the real stats renderer, and on a window with no telemetry
 * `previewMonitoring` feeds it `platform/simulator.ts` rather than leaving the
 * dials on "waiting" forever. That is the right call — an empty gauge teaches a
 * person nothing about the face they are arranging — and it was made silently:
 * the halo read *41 °C · CPU · 16 % load* with nothing anywhere on the surface
 * saying the number was invented. A cooler app showing a made-up temperature
 * without saying so is the single most dishonest thing it can do.
 *
 * One sentence, in one place, and the same one on a Look preview card. All three
 * tenses are identical because the claim is about THIS WINDOW's data source
 * rather than about the panel: the numbers are samples whatever the Kraken is
 * doing, and the condition that ends them — CAM sending real ones — is the same
 * condition in every state.
 */
export const CLAIM_SAMPLE_READINGS = claim(
  'Sample readings — until CAM sends real ones',
  'Sample readings — until CAM sends real ones',
  'Sample readings — until CAM sends real ones',
);

/**
 * The phone editor's standing line — W6, "the phone edits the same Look".
 *
 * The remote's replica ring became a canvas, and a canvas invites exactly one
 * dishonest sentence: *saved to your Kraken*. An arrangement made on a phone is
 * a commit to this window's store, and whether it reaches the panel is a
 * question about the WIRE — which does not carry `look` yet (§5–6; W1c) — not a
 * question about whether a Kraken is on the other end. So the tense is chosen
 * by `views/remote/lookReach.ts`, which demotes a live presence to `quiet` on
 * any window that cannot deliver, and this claim says what is true in each:
 *
 *  - **live** — the look really did land where the panel reads it, and the
 *    panel is talking, so the arrangement is on it.
 *  - **quiet** — a Kraken exists and this edit is not there yet. It is kept
 *    here, which is the whole promise, and the sentence names the condition.
 *  - **never-seen** — the same promise, with "back" replaced by the honest
 *    "connects": nothing has ever connected, so nothing can come back.
 */
export const CLAIM_ARRANGEMENT = claim(
  'Your Kraken has this arrangement.',
  'Kept here until your Kraken is back.',
  'Kept here until your Kraken connects.',
);

// ---------------------------------------------------------------------------
// The composed claims — same rule, shapes a bare string cannot carry
// ---------------------------------------------------------------------------

/**
 * The download ladder's last card — round 6's C2.
 *
 * Two lines, so the caller cannot compose a third wording out of them.
 *
 * `quiet` keeps `live`'s words on purpose, and round 6 argued it: `quiet` means
 * a display exists and this window simply is not watching it at this instant.
 * Demoting it to a promise would be as wrong in the other direction — the
 * source really is on that panel — and the e2e suite pins both halves.
 */
export function settledReceipt(presence: PanelPresence): { headline: string; sub: string } {
  return {
    headline: panelClaimText(SETTLED_HEADLINE, presence),
    sub: panelClaimText(SETTLED_SUB, presence),
  };
}

const SETTLED_HEADLINE = claim(ON_SCREEN_NOW, ON_SCREEN_NOW, SAVED_HEADLINE);
const SETTLED_SUB = claim(PLAYING_ON_KRAKEN, PLAYING_ON_KRAKEN, PLAYS_WHEN_CONNECTED);

/**
 * The receipt a link gets, wherever it was handed over — C5.
 *
 * All three link fields (the phone's Add panel, CAM's Library Add panel, the
 * remote's source row) print whichever of the two this returns, so the sentence
 * cannot be right on one surface and wrong on the next.
 */
export function linkReceipt(presence: PanelPresence): string {
  return panelClaimText(LINK_RECEIPT_CLAIM, presence);
}

const LINK_RECEIPT_CLAIM = claim(LINK_RECEIPT, LINK_RECEIPT, LINK_RECEIPT_UNSEEN);

/**
 * The badge on the highlighted tile, on BOTH shelves.
 *
 * A ten-pixel uppercase label naming which tile the panel's source is — not a
 * sentence, which is why `quiet` keeps the present form: "On screen" is the
 * queue position of a tile, and the tile really is the one the panel shows
 * whenever it is on. On a window that has never heard from a Kraken there is no
 * screen to be on, so the honest word is the queue's.
 */
export function nowShowingBadge(presence: PanelPresence): string {
  return panelClaimText(SHOWING_BADGE, presence);
}

const SHOWING_BADGE = claim(ON_SCREEN_BADGE, ON_SCREEN_BADGE, NEXT_UP_BADGE);

/**
 * The Library's receipt for pressing a tile.
 *
 * *"“dunes.mp4” is on your Kraken."* is the same assertion the ladder's last
 * card makes, printed by a different file, and it was made with the same
 * evidence: none.
 */
export function showingTile(presence: PanelPresence, name: string): string {
  return `“${name}” ${panelClaimText(TILE_RECEIPT, presence)}`;
}

const TILE_RECEIPT = claim(IS_ON_YOUR_KRAKEN, IS_ON_YOUR_KRAKEN, IS_NEXT_UP);

/**
 * The ladder's middle card for an acknowledged link.
 *
 * "Sent to your Kraken" names a hand-off. With nothing ever seen on the other
 * end there has not been one — the URL is in a document waiting to be read.
 */
export function handoffHeadline(presence: PanelPresence): string {
  return panelClaimText(HANDOFF_HEADLINE, presence);
}

const HANDOFF_HEADLINE = claim(SENT_TO_KRAKEN, SENT_TO_KRAKEN, SAVED_FOR_KRAKEN);

/**
 * The remote's sub-line, which is a claim about this exact second.
 *
 * `null` when the app must not make one — which is every state but `live`, and
 * is why the caller renders nothing rather than a greyed-out sentence. The one
 * claim in the file with no quiet or never-seen form, because there is none: a
 * sentence whose whole content is "right now" has nothing to say when "now" is
 * unknown.
 */
export function playingLine(presence: PanelPresence, held: boolean): string | null {
  if (!panelIsLive(presence)) return null;
  return held ? HOLDING_ON_KRAKEN : PLAYING_ON_KRAKEN;
}

/**
 * The status line's verb, under the halo — the shortest claim there is.
 *
 * One word, and the app typed it in three files: `homeState.describeVideoStatus`
 * had *Playing* and *Streaming*, `HomeView.describeStatus` had *Showing*, and
 * `RemoteView`'s module picker had *Showing* again as a control label. Three
 * files, one vocabulary, no shared definition — the ordinary duplication, on
 * the app's most-read line.
 *
 * `quiet` keeps the present participle, and this is the one place the
 * collapse deserves a paragraph. The status line is a verb, a name and a **live
 * dot**, and the dot is what asserts *this second*: `Status.live` is false for
 * anything but fresh telemetry, so a quiet window reads "Playing dunes.mp4"
 * with no dot — a caption of what the panel is set to, not a claim that it is
 * running. The dot carries the tense, so the word does not have to, and round 6
 * pinned that arrangement across both apps.
 *
 * That argument is only sound while the dot is honest, and for four rounds it
 * was not: `HomeView.describeStatus` returned `live: true` as a **literal** for
 * every non-video module, so "Showing Clock" was lit on a first-run window that
 * had never heard from a panel — the presence was threaded into the verb and
 * discarded for the dot, which is precisely the assertion the verb was allowed
 * to skip because the dot was making it. Round 8's A derives it from the same
 * `PanelPresence` for all four modules, so the sentence above is a description
 * of the code rather than of the intention.
 *
 * What the verb must never do is speak at all about a panel nobody has seen,
 * which is why every situation but `showing` falls back to the idle rung. The
 * caller (`describeVideoStatus`) already refuses to reach the playing rungs
 * without `panelIsKnown`; this is the same rule stated where it cannot be
 * skipped.
 */
export type PanelSituation = 'playing' | 'holding' | 'streaming' | 'showing' | 'idle';

const READY_TO_PLAY = 'Ready to play';

const SITUATION_VERB: Readonly<Record<PanelSituation, PanelClaimSpec>> = {
  playing: claim('Playing', 'Playing', READY_TO_PLAY),
  holding: claim('Holding', 'Holding', READY_TO_PLAY),
  streaming: claim('Streaming', 'Streaming', READY_TO_PLAY),
  // The non-video modules render as a live mirror of the panel's own state, and
  // "Showing Clock" is a statement about the configured module rather than about
  // a frame that arrived — true in every state, including the first run.
  showing: claim('Showing', 'Showing', 'Showing'),
  idle: claim(READY_TO_PLAY, READY_TO_PLAY, READY_TO_PLAY),
};

export function panelVerb(presence: PanelPresence, situation: PanelSituation): string {
  return panelClaimText(SITUATION_VERB[situation], presence);
}

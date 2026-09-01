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

/**
 * The receipt a link gets, wherever it was handed over.
 *
 * The old wording — *"Sent to your Kraken. It does the downloading, so a tile
 * appears here once CAM picks it up."* — was implementation copy: "CAM picks it
 * up" names a program the reader is not running and a hand-off they cannot
 * observe. What is TRUE and useful is that the Kraken fetches it and keeps a
 * copy, so a tile turns up shortly. The remote's link field says the same thing
 * as the Library's, because it is the same act.
 */
export const LINK_RECEIPT =
  'Sent to your Kraken. It fetches the file and keeps a copy, so a tile appears here shortly.';

// ---------------------------------------------------------------------------
// What is on the panel — the words, in one place
// ---------------------------------------------------------------------------

/**
 * The receipt's last step, and the sub-line under it.
 *
 * Round 6's C2. The download ladder's third card said **On screen now —
 * Playing on your Kraken** the moment the story settled, on a first-run window
 * where no display had ever published anything: the app describing a panel it
 * had never heard from. The sentence is true when a Kraken has been seen and
 * false when one has not, so it is two sentences, and
 * `panelClaims.settledReceipt()` is the only thing that chooses between them.
 *
 * `PLAYING_ON_KRAKEN` and `HOLDING_ON_KRAKEN` are shared with the remote's
 * sub-line, which said the same words in its own copy of them.
 */
export const ON_SCREEN_NOW = 'On screen now';
export const PLAYING_ON_KRAKEN = 'Playing on your Kraken';
export const HOLDING_ON_KRAKEN = 'Holding on your Kraken';

/** The honest headline for a source committed to a Kraken nobody has seen. */
export const SAVED_HEADLINE = 'Saved';

/** …and its sub-line. The promise the app CAN keep: the state is retained. */
export const PLAYS_WHEN_CONNECTED = 'Plays when your Kraken connects';

/**
 * The same act, said by a window that has never met a Kraken — round 6's C5,
 * corrected by round 7's F4.
 *
 * `LINK_RECEIPT` makes two claims a window with no display on the other end
 * cannot support: that the link was *sent* somewhere, and that a tile will turn
 * up *shortly*. On a phone paired to a room nobody is listening in — and in a
 * CAM window on a machine where the LCD page has never booted — both are
 * guesses. What is true either way is that the choice is written down and
 * retained, and that the Kraken acts on it the moment it connects.
 *
 * It used to open *"Saved to the library — …"*, which is a THIRD claim, and one
 * the shelf itself contradicts within 40 px: the Library page prints this
 * receipt directly above **{@link NOTHING_KEPT}**, so the app announced a
 * library entry and then showed an empty shelf in the same frame. A pasted link
 * is not a library entry — nothing has been fetched and nothing has been kept.
 * What was saved is the CHOICE, which is exactly what {@link SAVED_HEADLINE}
 * already says for the ladder's settled card, so the two receipts share one
 * frame and one word rather than inventing a destination each.
 *
 * Which of the two is printed is not a decision any surface makes for itself:
 * `app/config/panelClaims.ts` owns the question, and all three link fields ask
 * it through `linkReceipt()`.
 */
export const LINK_RECEIPT_UNSEEN = `${SAVED_HEADLINE} — your Kraken picks it up when it connects.`;

/**
 * The badge on the tile the panel is showing — and the one on the tile it is
 * merely going to show.
 *
 * "On screen" was typed into both shelves independently, which is the ordinary
 * duplication this file exists to end; it was also a claim about a panel
 * neither shelf had checked, which is round 6's C2 wearing a 10 px uppercase
 * label. A shelf on a window that has never heard from a Kraken knows exactly
 * one thing about the highlighted tile: it is the one queued up.
 */
export const ON_SCREEN_BADGE = 'On screen';
export const NEXT_UP_BADGE = 'Next up';

/**
 * The Library's receipt for playing something, in its two honest forms.
 *
 * Composed with the tile's name by `panelClaims.showingTile`, so neither
 * half can be printed without the question being asked.
 */
export const IS_ON_YOUR_KRAKEN = 'is on your Kraken.';
export const IS_NEXT_UP = 'is next up — your Kraken shows it when it connects.';

/**
 * The ladder's middle card, for a link that has been handed over.
 *
 * `SENT_TO_KRAKEN` is a claim about a hand-off to a machine on the other end of
 * something; with no machine ever seen there has been no hand-off, only a
 * decision written down.
 */
export const SENT_TO_KRAKEN = 'Sent to your Kraken';
export const SAVED_FOR_KRAKEN = 'Saved for your Kraken';

// ---------------------------------------------------------------------------
// The library's one verb
// ---------------------------------------------------------------------------

/**
 * What the shelf does to a thing — round 4's F4.
 *
 * The Library page used three verbs for one act, on one screen, within 200 px
 * of each other: the header said things were **Kept** here, the empty state said
 * nothing was **saved**, and the quota meter said nothing was **stored**. Three
 * words for one concept is the same failure `KEEPING_A_COPY` was written to end,
 * one surface over — so the verb is a constant and the three surfaces compose
 * their sentences out of it.
 */
export const KEPT_VERB = 'kept';

/** The shelf's resting sentence when it holds nothing. Present tense, no apology. */
export const NOTHING_KEPT = `Nothing ${KEPT_VERB} here`;

/**
 * The shelf's ONE name.
 *
 * It had six — Library, Your library, Your pictures, the shelf, the clip
 * library, the clip picker — spread across the Library page's own heading, the
 * sub-page header above it, the image module's second list and the video
 * module's prose. Six names is six shelves, which is precisely the complaint
 * ("the library is different"). One noun, imported.
 */
export const LIBRARY_NOUN = 'Library';

/**
 * Where a thing IS, when where it is constrains nothing.
 *
 * The counterpart to `COPY_HOME`. "on this PC" is a true and useful sentence in
 * CAM, because the file picker next to it can only reach that PC; on a phone it
 * is a fact about somebody else's machine, printed next to a shelf the phone can
 * drive perfectly well. Anything the user can act on from any window says
 * "in your library" and stops there.
 */
export const IN_YOUR_LIBRARY = 'in your library';

/**
 * Why a kept copy is worth having — the shelf's one promise.
 *
 * Written inline under CAM's empty shelf until round 7. It is a claim in the
 * panel-verb family ("keeps playing"), so the structural rule in
 * `vocabulary.test.ts` requires it to live in a words module rather than in a
 * view — and it is a *habitual* property of a stored file rather than a
 * statement about what the panel is doing this second, which is why it is a
 * plain term here and not a `PanelClaim`.
 */
export const OFFLINE_PROMISE = 'Whatever lands here keeps playing with the network unplugged.';

/**
 * The same promise, in the ladder's voice, while the bytes are still moving.
 *
 * What keeping a copy BUYS you, said before there is a percentage to report.
 * It says "plays forever", so the structural rule puts it here beside its
 * sibling rather than inline in the step-card — and the two being adjacent is
 * the point: they are one promise told at two moments, and a reader of this
 * file can see them agree.
 */
export const LOCAL_COPY_PITCH = 'Downloading locally — plays forever, no ads, no buffering';

/**
 * What unpairing does, and — more usefully — what it does not.
 *
 * Same reason as `OFFLINE_PROMISE`: it says "your Kraken keeps playing", which
 * is a panel-verb claim, so it is a term rather than a literal in the pairing
 * card. It is presence-independent on purpose: it describes the CONSEQUENCE of
 * a button, which is true whether or not this window has ever seen a display.
 */
export const UNPAIR_NOTE =
  'Unpairing clears this device only. Your Kraken keeps playing, and the same code still works if you scan it again.';

/**
 * The scrubber's honest line when nothing has reported a length — round 7's F1.
 *
 * `LOOP_MAX_SEC` is a rail length, not a duration, and for as long as the
 * handles wrote against it a drag persisted `loop.end = 2177` for a video
 * nobody had measured. The controls narrow to a decorative rail instead, and
 * this says why — naming the ONE thing that unlocks them, which is the same
 * shape `PLAYS_WHEN_CONNECTED` uses for the receipt.
 */
export const LOOP_UNLOCKS_ON_LENGTH = 'Loop points unlock when your Kraken reports the length';

// ---------------------------------------------------------------------------
// The frame-rate economics, said once
// ---------------------------------------------------------------------------

/**
 * Why the colour choices are flat — round 4's F4.
 *
 * `ClockConfigPanel` and `StatsConfigPanel` each carried a hand-written
 * 26-word sentence about CAM charging for repaints in the frame rate you
 * actually get. Two sentences, one fact, free to drift apart — and 26 words of
 * economics under a five-swatch colour picker in a 537 px window.
 *
 * One string, eight words, imported by both.
 */
export const FLAT_COLOURS_WHY = 'Flat fills only: kinder to CAM’s frame rate.';

// ---------------------------------------------------------------------------
// The second axis: WHO IS SPEAKING
// ---------------------------------------------------------------------------

/**
 * The one honest sentence about a transfer that did not happen — wave 3.
 *
 * It replaces `FILES_ADDED_AT_PC` ("Files are added at your PC."), which was
 * true for exactly as long as a phone had no way to hand the Kraken a file. It
 * has one now: the bytes go peer to peer over the LAN, straight into the same
 * ingest pipeline a file dropped on CAM's own Library page takes. So the
 * asymmetry the old sentence stated as a fact is gone, and what is left is a
 * CONSTRAINT — there is one STUN server and deliberately no TURN relay, because
 * a relay means somebody's server carrying somebody's video and this project is
 * not going to run one.
 *
 * Which is why this names the real requirement rather than apologising for a
 * failure, and why it is shown ONLY after a genuine failure or timeout. Warning
 * about it up front would be pre-emptively distrusting the case that almost
 * always works — a phone and a PC on one home network — which is how a feature
 * teaches its user not to use it.
 */
export const SAME_NETWORK_NOTE = 'Your phone and PC need to be on the same network.';

/**
 * Terms that only make sense on the surface that owns the bytes.
 *
 * The first vocabulary pass asked *what do we call this?* and stopped there,
 * which is how `COPY_HOME = 'on this PC'` — correct and load-bearing in CAM —
 * ended up rendered on a phone, where "this PC" refers to nothing the reader is
 * holding. The second axis is *who is allowed to say it*: these identifiers may
 * only be imported by modules that render on the owning surface, and
 * `vocabulary.test.ts` pins the import list. A phone-visible file that reaches
 * for one is a failing test rather than a screenshot in the next audit.
 */
export const OWNER_ONLY_TERMS: readonly string[] = [
  'COPY_HOME',
  'KEEP_A_COPY_LABEL',
  'KEEPING_A_COPY_NOW',
  'KEPT_A_COPY',
];

/**
 * Nouns for a machine the reader may not be sitting at.
 *
 * `OWNER_ONLY_TERMS` pins IMPORTS, which is a complete rule for a sentence that
 * lives in this file and no rule at all for one typed inline — and that is
 * exactly how the remote's pin button ended up carrying
 * `title="Allow this to be cleared when the disk fills up"` for a whole wave.
 * "The disk" is CAM's referent: from a sofa it names a thing the reader cannot
 * see, cannot check and cannot act on, which is the `COPY_HOME` failure wearing
 * a tooltip. `vocabulary.test.ts` reads the remote-rendered files themselves for
 * these, so an inline string cannot slip the import discipline again.
 *
 * "Your PC" is deliberately NOT here. It is a real referent for somebody holding
 * a paired phone — they paired it with that PC — and the remote says it on
 * purpose ("Paired with your PC", once something on the other end has actually
 * been heard from; "open Remote on your PC", which is where a code comes from).
 * What is banned is the bare, unowned machine: the one the copy assumes you are
 * standing in front of.
 */
export const MACHINE_NOUNS: readonly string[] = [
  'the disk',
  'the drive',
  'the hard drive',
  'this PC',
  'this computer',
  'this machine',
];

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
  // Round 4, F4 — the library's other two verbs for the one thing it does.
  'Nothing saved',
  'Nothing stored',
  // Round 4, F4 — the twin frame-rate-economics sentences.
  'repaints the whole tile',
  'repaints every pixel',
  // Wave 1, A5 — implementation copy, and the sixth name for the one shelf.
  'CAM picks it up',
  'Your pictures',
  // Wave 3 — retired by the LAN file transfer, which makes it untrue: a phone
  // hands the Kraken a file directly now, and the only remaining constraint is
  // the network one, which `SAME_NETWORK_NOTE` states when it actually bites.
  'Files are added at your PC',
  // Round 7, F4 — a receipt that named a destination the shelf underneath it
  // contradicted in the same frame. See `LINK_RECEIPT_UNSEEN`.
  'Saved to the library',
  // Round 8, C — an instruction for hardware nobody has. CAM cannot scan, the
  // app ships no decoder on any surface, and typing is the only way a code
  // minted on a phone reaches CAM. See `RemoteView`'s unpaired card.
  'scan it from the CAM window',
];

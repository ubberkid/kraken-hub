/**
 * The Looks sheet — templates, Your Looks, the gallery, files, the carousel.
 *
 * §4 and §9 on one surface, opened from the Looks menu in the editor's header.
 * Four groups behind one segmented control rather than four screens, because
 * "apply a different Look" is one intention and the difference between a
 * template and a Look somebody sent you is provenance, not workflow.
 *
 * ## Every card is the Look, running
 *
 * `LookPreview` mounts a real compositor per visible card. That is the promise
 * §9 makes about the gallery — "the card is the Look, not a picture of it" — and
 * it is worth keeping for the templates too: a template whose card is a
 * screenshot is a template that can quietly stop matching its own file.
 *
 * ## One path in, for everything
 *
 * A template, a saved Look, a gallery entry, a dropped file, a pasted blob of
 * JSON: all five are a `LookFile`, all five go through
 * `resolveMedia` → `applyLookFile`, and all five commit as one operation with
 * one undo entry (`editor.applyLook`). There is no "load a template" path that
 * a stranger's file does not also take, which is what makes a bug in it visible
 * on first run rather than on somebody else's machine.
 *
 * ## What the sheet is honest about
 *
 *  - **Media that is not here.** A Look references pictures and clips; it never
 *    carries them. What could not be resolved becomes a card naming the file,
 *    with the move this surface can actually offer.
 *  - **A refused file.** Five typed refusals, five sets of words, never a code.
 *  - **Where saved Looks live.** In this browser profile, not in the document —
 *    so they do not follow you to another machine, and the sheet says so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { docUrl } from '../../../../../buildInfo';
import {
  applyLookFile,
  exportLook,
  parseLookFile,
  resolveMedia,
  type LookFile,
  type MediaIndex,
} from '../../../../../state/look/file';
import { Button, Segmented } from '../../../../../ui';
import { loadTemplates, MAX_LOOK_NAME, type LookEntry } from '../../../editor/looksMenu';
import {
  addLook,
  deleteSaved,
  duplicateSaved,
  readLooksDoc,
  renameSaved,
  reorderSaved,
  subscribeLooks,
  toggleFavourite,
  updateLooksDoc,
  type LooksDoc,
  type SavedLook,
} from '../../../editor/looksStore';
import { monitoringIsSimulated } from '../../../editor/previewMonitoring';
import { PanelClaim } from '../../../PanelClaim';
import { CLAIM_SAMPLE_READINGS } from '../../../panelClaims';

import { CAROUSEL_INTERVALS, carouselLooks, intervalLabel, MIN_CAROUSEL_LOOKS } from './carousel';
import { crossFadeLookSwitch } from './crossFade';
import { loadGallery } from './gallery';
import {
  GALLERY_UNAVAILABLE,
  placeholderCard,
  refusalCard,
  SHELF_FULL,
  type LookCard,
} from './lookCards';
import { downloadLookFile, readDroppedLook, readLookText } from './lookFiles';
import { LookPreview } from './LookPreview';
import { readMediaIndex } from './mediaIndex';
import { createPreviewBudget, readsMonitoring } from './previewPolicy';

import './looks.css';

import type { Geometry } from '../../../../../platform/geometry';
import type { AppState, CarouselSettings } from '../../../../../state/schema';
import type { MonitorSnapshot } from '../../../../../sync/monitorSnapshot';
import type { EditorApi } from '../../../editor/useEditor';
import type { PanelPresence } from '../../../panelPresence';

/** §9's "Send yours": the pull-request guide, in this build's own repository. */
const GUIDE_URL = docUrl('looks/README.md');

type Tab = 'templates' | 'yours' | 'gallery' | 'carousel';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'templates', label: 'Templates' },
  { value: 'yours', label: 'Your Looks' },
  { value: 'gallery', label: 'Gallery' },
  { value: 'carousel', label: 'Carousel' },
];

export interface LooksSheetProps {
  editor: EditorApi;
  state: AppState;
  /** The panel every preview is standing in for, at its own pixel size. */
  panel: Geometry;
  monitor: MonitorSnapshot | null;
  monitorAt: number;
  /** The live Look's name, and the way to change it. */
  name: string | null;
  onRename: (next: string) => void;
  /** `ownsBytes()` — whether this window holds the library the media lives in. */
  owns: boolean;
  /** The tense every claim on this sheet is said in — the cards' F8 note. */
  presence: PanelPresence;
  /** Write the rotation into the document. `undefined` switches it off. */
  onCarousel: (next: CarouselSettings | undefined) => void;
  onClose: () => void;
}

export function LooksSheet({
  editor,
  state,
  panel,
  monitor,
  monitorAt,
  name,
  onRename,
  owns,
  presence,
  onCarousel,
  onClose,
}: LooksSheetProps) {
  const [tab, setTab] = useState<Tab>('templates');
  const [doc, setDoc] = useState<LooksDoc>(readLooksDoc);
  const [templates, setTemplates] = useState<LookEntry[] | null>(null);
  const [gallery, setGallery] = useState<LookEntry[] | null>(null);
  const [galleryMissing, setGalleryMissing] = useState(false);
  const [media, setMedia] = useState<MediaIndex>([]);
  const [cards, setCards] = useState<LookCard[]>([]);
  /**
   * The rotation's picks WHILE they are being made (F5).
   *
   * Seeded from the document so a sheet reopened over a running rotation shows
   * what is running, and kept here afterwards so a pick below the minimum is not
   * thrown away by the write that switches the rotation off.
   */
  const [picks, setPicks] = useState<string[]>(() => [...(state.carousel?.lookIds ?? [])]);
  /** The interval chosen before there was a rotation to write it into (F5). */
  const [pending, setPending] = useState<number>(
    () => state.carousel?.intervalSec ?? CAROUSEL_INTERVALS[0] ?? 30,
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** One budget for the whole sheet, so six live previews is six on the screen. */
  const budget = useMemo(() => createPreviewBudget(), []);

  useEffect(
    () =>
      subscribeLooks(() => {
        setDoc(readLooksDoc());
      }),
    [],
  );

  useEffect(() => {
    let live = true;
    void readMediaIndex().then((index) => {
      if (live) setMedia(index);
    });
    return () => {
      live = false;
    };
  }, []);

  // The two catalogues, each fetched the first time its group is looked at —
  // the templates are a chunk and the gallery is a network round trip, and
  // neither is worth spending on a sheet somebody opened to rename a Look.
  useEffect(() => {
    if (tab !== 'templates' || templates !== null) return;
    void loadTemplates().then(setTemplates);
  }, [tab, templates]);

  useEffect(() => {
    if (tab !== 'gallery' || gallery !== null) return;
    void loadGallery().then((result) => {
      if (result.ok) setGallery(result.entries);
      else setGalleryMissing(true);
    });
  }, [tab, gallery]);

  // -- applying -------------------------------------------------------------

  /**
   * The one apply. Every entry in every group ends here.
   *
   * The name follows the Look, because the alternative is a Look called
   * "Nebula clock" sitting under a header that still says whatever the last one
   * was called — and the header is the only place the current Look is named.
   */
  const apply = useCallback(
    (file: LookFile) => {
      const resolved = resolveMedia(file, media);
      crossFadeLookSwitch();
      editor.applyLook(applyLookFile(state, resolved));
      onRename(file.name);
      setCards(resolved.placeholders.map((p) => placeholderCard(p, owns ? 'cam' : 'phone')));
    },
    [editor, media, onRename, owns, state],
  );

  /** The live Look, as a file. What "Save as…" and Export both start from. */
  const currentFile = useCallback(
    (): LookFile => exportLook(state, { name: name ?? '' }, media),
    [media, name, state],
  );

  /**
   * Save as… — and the ellipsis now MEANS something (round 11's M-b).
   *
   * The button said "Save as…", which in every toolbar anybody has ever used
   * promises a dialog asking what to call it, and then saved silently under
   * whatever the header happened to say. On a Look that had never been renamed
   * that name is the empty string, so two presses produced two shelf entries
   * both reading "Untitled look" — indistinguishable, in the one place whose
   * whole job is telling your Looks apart.
   *
   * So the ellipsis gets its field. Inline, in the sheet's own footer, not
   * `window.prompt`: a prompt is a browser chrome dialog in the middle of a
   * surface that has spent ten rounds learning not to leave the page, it cannot
   * be styled, tested or dismissed with the sheet, and on CAM's embedded
   * browser it is a modal over an app that is also a live view of a cooler.
   *
   * The field opens with the current name in it — a re-save of a named Look is
   * a press and an Enter — and empty is refused rather than defaulted, because
   * an unnamed Look is exactly the thing this finding is about.
   */
  const [savingAs, setSavingAs] = useState(false);
  const [saveName, setSaveName] = useState('');

  const saveCurrent = useCallback(
    (as: string) => {
      const trimmed = as.trim();
      if (trimmed === '') return;
      const result = addLook(readLooksDoc(), { ...currentFile(), name: trimmed }, Date.now());
      if (!result.ok) {
        setCards([SHELF_FULL]);
        return;
      }
      updateLooksDoc(() => result.doc);
      onRename(trimmed);
      setSavingAs(false);
      setTab('yours');
    },
    [currentFile, onRename],
  );

  // -- files ----------------------------------------------------------------

  const importText = useCallback(
    (text: string) => {
      const result = parseLookFile(text);
      if (!result.ok) {
        setCards([refusalCard(result.reason)]);
        return;
      }
      apply(result.file);
    },
    [apply],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDropping(false);
      void readDroppedLook([...event.dataTransfer.files]).then((text) => {
        if (text === null) setCards([refusalCard({ code: 'not-an-object' })]);
        else importText(text);
      });
    },
    [importText],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      const text = event.clipboardData.getData('text/plain');
      // A paste into the rename field is a rename, not an import.
      if (text.trim() === '' || (event.target as HTMLElement).tagName === 'INPUT') return;
      event.preventDefault();
      importText(text);
    },
    [importText],
  );

  // -- the entries each group shows ----------------------------------------

  const savedEntries: LookEntry[] = doc.looks.map((row) => ({
    id: row.id,
    source: 'saved',
    name: row.file.name,
    summary: row.file.description ?? '',
    file: row.file,
  }));

  const previewProps = { panel, render: state.render, monitor, monitorAt, budget };

  /**
   * "Sample readings", once, for the whole grid — round 10's F8.
   *
   * A live card whose Look carries a stats face is running the real renderer
   * against `previewMonitoring`, which invents numbers when nothing is
   * publishing. Every such card marks itself (`kh-lookprev__sample`); the
   * SENTENCE is here, because a 100 px card in the rail's column wrapped it to
   * four lines over the picture it was annotating, and truncating it would be
   * the same failure F10 found on the budget meter.
   */
  const sampled = monitoringIsSimulated({ snapshot: monitor, at: monitorAt });
  const sampleNote = (entries: readonly LookEntry[] | null): boolean =>
    sampled && (entries?.some((e) => readsMonitoring(e.file)) ?? false);

  const rotation = state.carousel;
  const interval = rotation?.intervalSec ?? pending;
  const chosen = new Set(picks);

  /**
   * Pick a Look for the rotation — round 10's F5.
   *
   * The picks used to live only in `state.carousel`, and `state.carousel` is
   * `undefined` for anything under two Looks. So the first press computed
   * `next = [a]`, saw `1 < MIN_CAROUSEL_LOOKS`, wrote `undefined`, and the
   * NEXT press read `rotation?.lookIds ?? []` — still empty — and computed
   * `[b]`, wrote `undefined` again. The carousel could not be switched on from
   * this sheet at all, at any number of presses, and the status line said
   * "Off — pick two." forever.
   *
   * The partial pick is component state now, and the document keeps its meaning:
   * `carousel` is a RUNNING rotation, so one pick still switches it off. Only
   * ENABLING is gated on two; remembering is not.
   */
  const toggleInRotation = (id: string): void => {
    const next = chosen.has(id) ? picks.filter((x) => x !== id) : [...picks, id];
    setPicks(next);
    onCarousel(
      next.length < MIN_CAROUSEL_LOOKS ? undefined : { lookIds: next, intervalSec: interval },
    );
  };

  return (
    <section
      className="kh-sheet kh-looks-sheet"
      data-testid="looks-sheet"
      data-tab={tab}
      data-dropping={dropping ? 'true' : 'false'}
      aria-label="Looks"
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => {
        setDropping(false);
      }}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <header className="kh-sheet__head">
        <h2>Looks</h2>
        <button
          type="button"
          className="kh-iconbtn"
          data-testid="looks-sheet-close"
          aria-label="Close"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="kh-looks-bar">
        <Segmented
          id="looks-tab"
          ariaLabel="Which Looks"
          value={tab}
          /*
            Four tabs want 322 px and the rail's column is 268 (M2), so the row
            runs onto a second line rather than off the side of the page — the
            same `wrap` the palette and quality rows already use.
          */
          wrap
          options={TABS}
          onChange={(next) => {
            setTab(next as Tab);
          }}
        />
      </div>

      {/*
        `kh-sheet__body` is the class, not just a look: it is what `ui.css` gives
        `overflow-y: auto; min-height: 0` to for every sheet in the editor's rail
        column, and it is the one box on this surface allowed to scroll (M9).
      */}
      <div className="kh-looks-body kh-sheet__body">
        {tab === 'templates' && (
          <>
            <Grid
              entries={templates}
              empty="Loading the Looks that ship with the app…"
              onApply={apply}
              previewProps={previewProps}
            />
            {sampleNote(templates) && <SampleNote presence={presence} />}
          </>
        )}

        {tab === 'gallery' && (
          <>
            {galleryMissing && <Card card={GALLERY_UNAVAILABLE} />}
            {!galleryMissing && (
              <Grid
                entries={gallery}
                empty="Reading the gallery…"
                onApply={apply}
                previewProps={previewProps}
              />
            )}
            {sampleNote(gallery) && <SampleNote presence={presence} />}
            {/*
              The link is derived from this build's own manifest (I4), so a fork
              points at the fork — and renders as plain words rather than a dead
              link when the manifest names no repository.
            */}
            <p className="kh-looks-note">
              These are files in the project’s repository. Yours can be too —{' '}
              {GUIDE_URL === null ? (
                'the guide is looks/README.md.'
              ) : (
                <a href={GUIDE_URL} data-testid="looks-gallery-guide">
                  the guide is one page
                </a>
              )}
            </p>
          </>
        )}

        {tab === 'yours' && (
          <>
            {doc.looks.length === 0 ? (
              <p className="kh-looks-note" data-testid="looks-yours-empty">
                You have not kept a Look here yet. <b>Save as…</b> keeps the arrangement you are
                working on, and an exported Look is a file you can send anybody.
              </p>
            ) : (
              <div className="kh-looks-grid" data-testid="looks-grid-yours">
                {doc.looks.map((row, i) => (
                  <SavedCard
                    key={row.id}
                    row={row}
                    index={i}
                    dragging={dragging}
                    setDragging={setDragging}
                    onApply={apply}
                    onDoc={setDoc}
                    previewProps={previewProps}
                  />
                ))}
              </div>
            )}
            {sampleNote(savedEntries) && <SampleNote presence={presence} />}
            <p className="kh-looks-note">
              Your Looks are kept in this browser profile, so they do not travel with you. Export
              one and it is a file that does.
            </p>
          </>
        )}

        {tab === 'carousel' && (
          <div className="kh-looks-carousel" data-testid="looks-carousel">
            <p className="kh-looks-note">
              Pick two or more of Your Looks and they take turns. The rotation turns while this
              window is open — nothing changes while it is closed, and whatever was last chosen
              stays put.
            </p>
            {savedEntries.length < MIN_CAROUSEL_LOOKS ? (
              <p className="kh-looks-note" data-testid="looks-carousel-empty">
                Save at least two Looks first.
              </p>
            ) : (
              <>
                <ul className="kh-looks-pick">
                  {doc.looks.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        className="kh-looks-pick__item"
                        aria-pressed={chosen.has(row.id)}
                        data-testid={`carousel-pick-${row.id}`}
                        onClick={() => {
                          toggleInRotation(row.id);
                        }}
                      >
                        <span aria-hidden="true">{chosen.has(row.id) ? '◉' : '○'}</span>{' '}
                        {row.file.name === '' ? 'Untitled look' : row.file.name}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="kh-looks-interval">
                  <Segmented
                    id="looks-interval"
                    ariaLabel="How long each Look gets"
                    wrap
                    value={String(interval)}
                    options={CAROUSEL_INTERVALS.map((sec) => ({
                      value: String(sec),
                      label: intervalLabel(sec),
                    }))}
                    /*
                      The interval is settable BEFORE the rotation exists (F5).
                      It used to `return` on `rotation === undefined`, which is
                      every state the sheet can actually reach with fewer than
                      two picks — a control that silently does nothing.
                    */
                    onChange={(value) => {
                      const sec = Number(value);
                      if (picks.length < MIN_CAROUSEL_LOOKS) {
                        setPending(sec);
                        return;
                      }
                      onCarousel({ lookIds: picks, intervalSec: sec });
                    }}
                  />
                </div>
                {/*
                  Three states, and the middle one is the whole point of F5: a
                  person who has pressed one Look is one press from a rotation
                  and the line says so, instead of reporting "Off" at them.
                */}
                <p className="kh-looks-note" data-testid="carousel-status">
                  {picks.length === 0
                    ? 'Off — pick two.'
                    : picks.length < MIN_CAROUSEL_LOOKS
                      ? `${String(picks.length)} picked — pick one more`
                      : `${String(carouselLooks(rotation, doc).length)} Looks · every ${intervalLabel(
                          interval,
                        )}`}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {cards.map((card, i) => (
        <Card key={`${card.title}-${String(i)}`} card={card} />
      ))}

      <footer className="kh-looks-foot">
        <Button
          testId="looks-save-as"
          onClick={() => {
            setSaveName(name ?? '');
            setSavingAs((open) => !open);
          }}
        >
          Save as…
        </Button>
        <Button
          testId="looks-export"
          onClick={() => {
            downloadLookFile(currentFile());
          }}
        >
          Export
        </Button>
        <Button
          testId="looks-import"
          onClick={() => {
            fileRef.current?.click();
          }}
        >
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="kh-looks-file"
          accept=".krakenlook,.json,application/json"
          data-testid="looks-import-input"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            event.target.value = '';
            if (picked === undefined) return;
            void readLookText(picked).then((text) => {
              if (text === null) setCards([refusalCard({ code: 'not-an-object' })]);
              else importText(text);
            });
          }}
        />
        <span className="kh-looks-foot__hint">…or drop a file here, or paste one.</span>
      </footer>

      {/*
        The ellipsis's field — M-b.

        A form rather than a row of controls, so Enter saves: the whole gesture
        is "type a name and confirm it", and a person who has just typed one
        should not have to find a button. `Save` is disabled while the name is
        empty rather than falling back to "Untitled look", which is the name two
        silent presses used to produce twice.
      */}
      {savingAs && (
        <form
          className="kh-looks-saveas"
          data-testid="looks-save-as-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveCurrent(saveName);
          }}
        >
          <label className="kh-looks-saveas__lab" htmlFor="kh-looks-save-name">
            Save this Look as
          </label>
          <input
            id="kh-looks-save-name"
            className="kh-looks-item__name"
            data-testid="looks-save-name"
            value={saveName}
            maxLength={MAX_LOOK_NAME}
            placeholder="Name this Look"
            ref={(el) => el?.focus()}
            onChange={(event) => {
              setSaveName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSavingAs(false);
            }}
          />
          {/*
            A real submit button, not `Button` — that component is
            `type="button"` by contract, which would have made Enter in the
            field do nothing and left the form a form in name only.
          */}
          <button
            type="submit"
            className="kh-btn kh-btn--primary"
            data-testid="looks-save-confirm"
            disabled={saveName.trim() === ''}
          >
            Save
          </button>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

type PreviewProps = Omit<Parameters<typeof LookPreview>[0], 'previewId' | 'file'>;

/**
 * The grid's one honest line about where its dials' numbers come from (F8).
 *
 * A claim, through the registry, like every other sentence on this surface that
 * is about what a panel is doing — which this one is, at one remove: it is about
 * the numbers standing in for what a panel would report.
 */
function SampleNote({ presence }: { presence: PanelPresence }) {
  return (
    <PanelClaim
      claim={CLAIM_SAMPLE_READINGS}
      presence={presence}
      as="p"
      className="kh-looks-note kh-looks-note--sample"
      testId="looks-sample-note"
    />
  );
}

function Card({ card }: { card: LookCard }) {
  return (
    <div className="kh-looks-card" role="status" data-testid="looks-card">
      <b>{card.title}</b>
      <small>{card.detail}</small>
    </div>
  );
}

function Grid({
  entries,
  empty,
  onApply,
  previewProps,
}: {
  entries: LookEntry[] | null;
  empty: string;
  onApply: (file: LookFile) => void;
  previewProps: PreviewProps;
}) {
  if (entries === null) return <p className="kh-looks-note">{empty}</p>;
  return (
    <div className="kh-looks-grid" data-testid="looks-grid">
      {entries.map((entry) => (
        <div className="kh-looks-item" key={`${entry.source}-${entry.id}`}>
          <button
            type="button"
            className="kh-looks-item__apply"
            data-testid={`look-apply-${entry.id}`}
            onClick={() => {
              onApply(entry.file);
            }}
          >
            <LookPreview
              previewId={`${entry.source}-${entry.id}`}
              file={entry.file}
              {...previewProps}
            />
            <b>{entry.name === '' ? 'Untitled look' : entry.name}</b>
            <small>{entry.summary}</small>
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * A saved Look: the same card, plus the five things you can do to one.
 *
 * Delete confirms, and only delete — the other four are all reversible by doing
 * them again, and a confirmation on a favourite is a dialog that teaches people
 * to dismiss dialogs.
 */
function SavedCard({
  row,
  index,
  dragging,
  setDragging,
  onApply,
  onDoc,
  previewProps,
}: {
  row: SavedLook;
  index: number;
  dragging: string | null;
  setDragging: (id: string | null) => void;
  onApply: (file: LookFile) => void;
  onDoc: (doc: LooksDoc) => void;
  previewProps: PreviewProps;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const now = (): number => Date.now();

  return (
    <div
      className="kh-looks-item"
      data-testid={`look-saved-${row.id}`}
      draggable
      onDragStart={() => {
        setDragging(row.id);
      }}
      onDragEnd={() => {
        setDragging(null);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dragging === null || dragging === row.id) return;
        onDoc(updateLooksDoc((d) => reorderSaved(d, dragging, index)));
        setDragging(null);
      }}
    >
      <button
        type="button"
        className="kh-looks-item__apply"
        data-testid={`look-apply-${row.id}`}
        onClick={() => {
          onApply(row.file);
        }}
      >
        <LookPreview previewId={`saved-${row.id}`} file={row.file} {...previewProps} />
        {renaming ? null : <b>{row.file.name === '' ? 'Untitled look' : row.file.name}</b>}
        <small>{row.file.description ?? ''}</small>
      </button>

      {renaming && (
        <input
          className="kh-looks-item__name"
          defaultValue={row.file.name}
          maxLength={MAX_LOOK_NAME}
          aria-label="Look name"
          data-testid={`look-rename-${row.id}`}
          ref={(el) => el?.focus()}
          onBlur={(e) => {
            onDoc(updateLooksDoc((d) => renameSaved(d, row.id, e.target.value, now())));
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      )}

      <div className="kh-looks-item__acts">
        <button
          type="button"
          className="kh-iconbtn"
          aria-label={row.favourite ? 'Remove from favourites' : 'Add to favourites'}
          aria-pressed={row.favourite}
          data-testid={`look-fav-${row.id}`}
          onClick={() => {
            onDoc(updateLooksDoc((d) => toggleFavourite(d, row.id, now())));
          }}
        >
          <span aria-hidden="true">{row.favourite ? '★' : '☆'}</span>
        </button>
        <button
          type="button"
          className="kh-iconbtn"
          aria-label="Rename"
          data-testid={`look-rename-btn-${row.id}`}
          onClick={() => {
            setRenaming(true);
          }}
        >
          <span aria-hidden="true">✎</span>
        </button>
        <button
          type="button"
          className="kh-iconbtn"
          aria-label="Duplicate"
          data-testid={`look-dup-${row.id}`}
          onClick={() => {
            const result = duplicateSaved(readLooksDoc(), row.id, now());
            if (result.ok) onDoc(updateLooksDoc(() => result.doc));
          }}
        >
          <span aria-hidden="true">⧉</span>
        </button>
        <button
          type="button"
          className="kh-iconbtn"
          aria-label="Export"
          data-testid={`look-export-${row.id}`}
          onClick={() => {
            downloadLookFile(row.file);
          }}
        >
          <span aria-hidden="true">↓</span>
        </button>
        <button
          type="button"
          className="kh-iconbtn"
          aria-label={confirming ? 'Delete for good' : 'Delete'}
          data-testid={`look-del-${row.id}`}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            onDoc(updateLooksDoc((d) => deleteSaved(d, row.id)));
          }}
        >
          <span aria-hidden="true">{confirming ? '⌫!' : '⌫'}</span>
        </button>
      </div>
      {confirming && (
        <small className="kh-looks-item__confirm">Press again to delete this Look.</small>
      )}
    </div>
  );
}

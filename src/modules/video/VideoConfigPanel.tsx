import { useCallback, useEffect, useRef, useState } from 'react';

import { ALLORIGINS_PROXY_BASE } from '../../config/knownHosts';
import { KEEP_A_COPY, KEEP_A_COPY_LABEL, STREAM_ONLY } from '../../config/vocabulary';
import {
  Button,
  Chip,
  Field,
  GroupField,
  ModuleOptions,
  Notice,
  NumberInput,
  Row,
  Segmented,
  Switch,
  TextInput,
} from '../../ui';
import { FramingAdvanced } from '../../ui/Framing';

import {
  YT_BIAS_HELPER,
  describeQuality,
  qualityControlFor,
  qualityFromOption,
  qualityOptionValue,
  qualityOptions,
  type QualityReadout,
} from './quality';
import { ResolverConnectPanel } from './resolver/ResolverConnectPanel';
import { LOCAL_CLIP_SCHEME } from './routing/patterns';
import { validateUrl } from './routing/validate';
import {
  ASPECT_16_9,
  ASPECT_9_16,
  RESOLVER_DEFAULT_PORT,
  validateVideoConfig,
  type ProviderId,
  type SourceAspect,
  type VideoModuleConfig,
} from './types';

import type { ModuleConfigProps } from '../types';
import type { HealthState } from './resolver/resolverClient';
import type { TelePacket } from './telemetry/videoTelemetry';

/**
 * The video module's config panel. Config-only code: invariant I8 keeps this
 * `.tsx` out of the display graph entirely, which is why the URL field can
 * afford to import the whole validation table.
 *
 * The clip library, the download list and the drop zone live in the Library
 * view — this panel is about *this* module's settings.
 *
 * ## The settings census
 *
 * This panel had **24 controls, 23 `<label>`s, 533 words of body copy and 171
 * words living inside `<option>` elements**, and expanded to 2,963 px — five and
 * a half screens in the window CAM actually opens. The design audit's §2 census
 * cut it to six primary controls and one Advanced door, on three rules:
 *
 *  1. **Every "(recommended)" option is an admission that the control should not
 *     be a control.** Picture quality is already governed by `fpsGovernor`; the
 *     pause strategy has one right answer, because the other one raises
 *     YouTube's suggested-video grid inside the picture; the crossfade already
 *     disables itself under load; the player-size and portrait-width levers are
 *     compositor internals whose own help text admitted they were unverified on
 *     hardware. All of them are gone, pinned to the default they always had.
 *  2. **A select whose options are sentences should have been a segmented
 *     control.** Fit, keep-a-copy, shape and the downloader policy are all short
 *     exclusive choices, so they are all segments now, and what used to be the
 *     sentence is the segment's tooltip.
 *  3. **One Advanced door per module, one level deep.** There were four
 *     disclosures here, all four labelled the identical word "Advanced". There
 *     is one.
 *
 * Loop moved out entirely. It was two number fields **in seconds** — the single
 * most anti-Apple control in the app — and it is now the A/B scrubber from the
 * phone remote, lifted onto the home screen's ops strip where the halo stays in
 * view while you drag it (`views/LoopScrubber.tsx`).
 *
 * The downloader also moved: it is a real capability and it stays, but behind
 * this door rather than as a primary teal button answering somebody's first
 * successful playback with an apology and an install pitch (audit F10).
 */

const PORT_MIN = 1;
const PORT_MAX = 65_535;

/**
 * The shape override, cut from seven options to three.
 *
 * There is still no cross-origin way to read a YouTube video's true aspect, so
 * a manual override has to exist — but `detect()` already knows a Shorts link
 * from a watch link, which is the only distinction 99 % of users need. The four
 * exotic ratios were a picker of film-school trivia in front of a paste box.
 */
const SHAPE_SEGMENTS: readonly {
  value: string;
  label: string;
  title: string;
  aspect: SourceAspect;
}[] = [
  { value: 'auto', label: 'Auto', title: 'Vertical for Shorts, wide otherwise.', aspect: 'auto' },
  { value: '16:9', label: 'Wide', title: 'Standard landscape video.', aspect: ASPECT_16_9 },
  { value: '9:16', label: 'Tall', title: 'Vertical video and Shorts.', aspect: ASPECT_9_16 },
];

/** Floating-point ratios never compare equal; 0.005 separates every row above. */
const ASPECT_MATCH_EPS = 0.005;

/**
 * Which segment a stored `sourceAspect` selects — `'auto'` for anything the
 * three rows do not offer, which is the same answer the panel already gave a
 * stored 4:3 or 21:9 before the seven-row preset table in `types.ts` went away.
 * Derived from `SHAPE_SEGMENTS` so a fourth row could never fall out of sync
 * with the key that selects it.
 */
function shapeKeyFor(value: SourceAspect): string {
  return (
    SHAPE_SEGMENTS.find((s) =>
      s.aspect === 'auto'
        ? value === 'auto'
        : typeof value === 'number' && Math.abs(s.aspect - value) < ASPECT_MATCH_EPS,
    )?.value ?? 'auto'
  );
}

/**
 * The player-shape override — restored, in Advanced, with honest words.
 *
 * ## Why it was killed, and why it is back
 *
 * The round-1 census deleted it along with the rest of the compositor internals,
 * on the rule that *"every '(recommended)' option is an admission that the
 * control should not be a control"*. That rule was right about the label and
 * wrong about the choice: `square` and `tight` are not two qualities of the same
 * picture, they are a real trade the engine has always implemented (see
 * `youtube/geometry.ts` — `square` makes the iframe as tall as it is wide so
 * YouTube's own chrome is pushed outside the crop; `tight` makes it exactly as
 * tall as the video plus its bar-safe padding). The picture on the panel is the
 * same either way; what differs is how many pixels the compositor is asked to
 * carry, and how much room YouTube has to draw a control bar into.
 *
 * So it is a genuine choice with a safe default, which is what Advanced is for.
 * The old copy called one of them "(recommended)" and the other "experimental",
 * which told the reader nothing about either; these say what the trade IS.
 *
 * The engine does NOT always obey this — `perf: 'performance'` forces `tight`,
 * because a machine short of frames has already answered the question. The
 * helper line below says so, because a control that is silently overridden and
 * does not admit it is the kind of lie the audit exists to catch.
 */
const YT_SHAPE_SEGMENTS = [
  {
    value: 'square',
    label: 'Square',
    title: 'A taller frame, so YouTube’s own buttons stay outside the picture.',
  },
  {
    value: 'tight',
    label: 'Tight',
    title: 'A smaller frame: less for your PC to draw, and the same picture.',
  },
] as const;

/** When kraken-hub asks the downloader to fetch a link, rather than streaming it. */
const RESOLVER_POLICY_SEGMENTS = [
  { value: 'off', label: 'Never', title: 'Ignore the downloader even when it is running.' },
  { value: 'youtube-only', label: 'YouTube', title: 'YouTube links only. The default.' },
  {
    value: 'preferred',
    label: 'Most links',
    title: 'Anything that shows its own player controls.',
  },
  { value: 'fallback', label: 'On failure', title: 'Only after the normal player has failed.' },
] as const;

/*
 * `ownsBytes` — round 13's finding 3.
 *
 * Everything this panel gates on it acts on ONE machine's disk: the copy it
 * keeps, the downloader it runs, the port and token that program listens on, the
 * proxy the fetch goes through. The inspector mounts this component on the phone
 * now, so all of it was rendered to a reader who cannot run the program, cannot
 * see the disk and for whom "this PC" names nothing in the room. A window that
 * does not own the bytes gets the controls that are about the PICTURE — framing,
 * shape, quality — and none of the ones about the fetch.
 *
 * `true` by default: CAM's own panel is unchanged, and so is every test that
 * renders this component without an opinion.
 */
export function ConfigPanel({ config, onChange, ownsBytes = true }: ModuleConfigProps) {
  const cfg = validateVideoConfig(config);
  // Validation runs at keystroke time here, because this is the only surface
  // where a human can actually read the answer (§7.2).
  const validation = validateUrl(cfg.url);
  const isYouTube = validation.match.provider === 'youtube-embed';

  const set = (patch: Partial<VideoModuleConfig>): void => {
    onChange({ ...cfg, ...patch });
  };

  return (
    <ModuleOptions
      advancedTestId="video-advanced"
      /*
        No link field. It sat two inches under the home screen's paste row and
        held the same string — the audit's census verdict was "keep-primary, but
        it duplicates the home paste row: merge". The paste row is the merge, and
        it owns the validation copy too.
      */
      primary={
        <>
          {isYouTube && (
            /*
              §2.8, and round 3's F4 — this is where the ads fact LIVES.

              It is a property of the source, not an event in the paste ladder:
              the receipt used to assert it a third time, permanently, in a card
              that never left the screen while the halo and the status line were
              already saying what was playing. A source property belongs next to
              the control that answers it, which is the row directly below.
            */
            <Notice tone="warn">
              YouTube plays its ads <em>inside</em> the video, so cropping cannot remove them.
              {/*
                The remedy only exists where the control does. The FACT is true
                on every surface — it is a property of the link — but a phone
                that cannot keep a copy is told to keep one by a sentence whose
                control is not on the screen.
              */}
              {ownsBytes && <> {KEEP_A_COPY} for an ad-free, full-quality result.</>}
            </Notice>
          )}

          {ownsBytes && (
            <>
              {/*
            No description line. The options panel opens in the halo's place in a
            537 px window now, and every sentence in here is measured against
            that — so the explanation lives on the segment that means it, which
            is the same rule the audit's F9 applied to `<option>` prose. The row
            is named for the destination so the options can be the verbs, and
            both words come from `config/vocabulary.ts` (F7).
          */}
              <GroupField label={KEEP_A_COPY_LABEL} id="video-downloadmode">
                <Segmented
                  id="video-downloadmode"
                  labelledBy="video-downloadmode-label"
                  value={cfg.downloadMode}
                  options={[
                    {
                      value: 'auto',
                      label: KEEP_A_COPY,
                      title: 'Fetch it once, then play the copy — ad-free, offline, forever.',
                    },
                    { value: 'stream-only', label: STREAM_ONLY, title: 'Never store anything.' },
                  ]}
                  onChange={(value) => {
                    set({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
                  }}
                />
              </GroupField>
            </>
          )}

          <QualityRow cfg={cfg} set={set} provider={validation.match.provider} />
        </>
      }
      /*
        ONE door, one level. Everything the census moved rather than killed is
        flat inside it — a disclosure inside a disclosure is a settings page
        wearing a costume.

        Two subheads, and no third level (round 4, minors). Video is the only
        module with enough behind its door to need a map: seven controls, in two
        unrelated conversations — how the picture is cropped, and how the bytes
        are fetched. A reader scanning for the proxy switch had to read the
        aspect controls to find out they were not it. Headings are not a
        hierarchy, they are a table of contents: everything stays exactly one
        level down, still flat, still one door.
      */
      advanced={
        <>
          <h3 className="kh-subhead3">Framing</h3>
          <GroupField
            label="Shape of the video"
            id="video-yt-aspect"
            description="Only needed when the crop lands on the wrong part of the picture."
          >
            <Segmented
              id="video-yt-aspect"
              labelledBy="video-yt-aspect-label"
              value={shapeKeyFor(cfg.youtube.sourceAspect)}
              options={SHAPE_SEGMENTS}
              onChange={(key) => {
                const found = SHAPE_SEGMENTS.find((s) => s.value === key);
                if (found === undefined) return;
                set({ youtube: { ...cfg.youtube, sourceAspect: found.aspect } });
              }}
            />
          </GroupField>

          <GroupField
            label="YouTube player shape"
            id="video-yt-mode"
            description="Square is the safer of the two: the frame is tall enough that YouTube’s own buttons never reach the picture. Tight draws a smaller frame for the same picture."
          >
            <Segmented
              id="video-yt-mode"
              labelledBy="video-yt-mode-label"
              value={cfg.youtube.mode}
              options={YT_SHAPE_SEGMENTS}
              onChange={(key) => {
                const found = YT_SHAPE_SEGMENTS.find((s) => s.value === key);
                if (found === undefined) return;
                set({ youtube: { ...cfg.youtube, mode: found.value } });
              }}
            />
          </GroupField>
          <p className="kh-hint">
            Only affects YouTube links, and a Kraken that is short of frames uses Tight anyway.
          </p>

          <FramingAdvanced
            idPrefix="video"
            value={cfg.render}
            onChange={(patch) => {
              set({ render: { ...cfg.render, ...patch } });
            }}
          />

          {/*
            Delivery is the OWNER's half — round 13's finding 3.

            A downloader that runs on one machine, the port and token it listens
            on, and the proxy a fetch goes through: three controls whose subject
            is a computer the reader may not be sitting at, and which a phone can
            neither perform nor check. The heading goes with them, because a
            section title with nothing under it is a promise the panel does not
            keep.
          */}
          {ownsBytes && (
            <>
              <h3 className="kh-subhead3">Delivery</h3>

              <LocalDownloaderCard cfg={cfg} set={set} />

              <GroupField
                label="Use a public proxy as a last resort"
                id="video-proxy"
                description="allorigins.win is a free public service with no uptime promise, and it sees every URL your Kraken plays. Tried only for links nothing else could fetch, and it cannot fix HLS."
              >
                <Switch
                  id="video-proxy"
                  labelledBy="video-proxy-label"
                  checked={cfg.proxyBase === ALLORIGINS_PROXY_BASE}
                  onChange={(on) => {
                    set({ proxyBase: on ? ALLORIGINS_PROXY_BASE : '' });
                  }}
                />
              </GroupField>
              <Field
                label="Or your own proxy address"
                htmlFor="video-proxy-base"
                description="Ends in ?url=."
              >
                <TextInput
                  id="video-proxy-base"
                  settingUrl
                  value={cfg.proxyBase}
                  placeholder="your proxy's base URL, ending in ?url="
                  onChange={(proxyBase) => {
                    set({ proxyBase });
                  }}
                />
              </Field>
            </>
          )}
        </>
      }
    />
  );
}

/**
 * The Quality row — on the PRIMARY surface, never under Advanced.
 *
 * "Show what you're getting everywhere; offer control only where it's real."
 * The first half is unconditional: whatever is playing, this row says what
 * resolution is on the panel, in the same words on every provider. The second
 * half is where the honesty lives, and it is four different controls:
 *
 *  - a **picker** built from the levels the display actually reported (hls,
 *    dash, twitch, and the resolver companion's ladder);
 *  - a **bias** picker for YouTube, with one helper line naming who is really
 *    choosing — because there is no cross-origin quality API left and pretending
 *    otherwise would be a lie the user could catch;
 *  - a **read-only** reading for a local clip or a direct file, which have
 *    exactly one resolution;
 *  - and nothing at all when nothing is known yet.
 *
 * The live half comes off the telemetry mirror in localStorage, which the CAM
 * configuration window shares with the display for free — the same zero-network
 * path the diagnostics log uses.
 *
 * The census kept this control because its options are not sentences: they are
 * resolutions your Kraken reported, one word each — which is exactly the shape a
 * segmented row is for, and what it became in round 2's R8.
 */
function QualityRow({
  cfg,
  set,
  provider,
}: {
  cfg: VideoModuleConfig;
  set: (patch: Partial<VideoModuleConfig>) => void;
  provider: ProviderId | null;
}) {
  const [tele, setTele] = useState<TelePacket | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    // A mutable cell rather than a `let`, for the same reason as the downloader
    // card below: TypeScript's control flow narrows a plain boolean to `true`
    // across the await and the guard would be dead code.
    const alive = { current: true };
    void (async () => {
      const mod = await import('./telemetry/videoTelemetry');
      if (!alive.current) return;
      setTele(mod.readTeleMirror());
      // Assigning through the closure rather than returning the unsubscribe is
      // what lets the effect stay synchronous while the import is not.
      stop.current = mod.subscribeTeleMirror(setTele);
    })();
    return () => {
      alive.current = false;
      stop.current?.();
      stop.current = null;
    };
  }, []);

  // The display's word beats the URL's guess: a link that *looks* like a bare
  // `.m3u8` may have ended up on the resolver, and the mounted adapter is the
  // one whose control is real.
  const live = typeof tele?.provider === 'string' ? (tele.provider as ProviderId) : provider;
  const control = qualityControlFor(live);
  const levels = (tele?.levels ?? []).map((l) => ({ height: l.h, label: l.l }));
  const readout: QualityReadout = {
    reported: tele?.quality ?? null,
    local: cfg.url.startsWith(LOCAL_CLIP_SCHEME),
  };
  const reading = describeQuality(cfg.quality, readout);
  /** The same reading, minus the word the segment beside it already says. */
  const pickerReading = describeQuality(cfg.quality, readout, { inPicker: true });

  if (control === 'readonly' || control === 'none') {
    return (
      <GroupField label="Quality" id="video-quality-readout">
        {/*
          One line. It ran to two — "a stored file has one resolution, so there
          is nothing to choose" — and two lines of prose explaining the ABSENCE
          of a control is exactly the weight the panel cannot afford now that it
          opens inside the window rather than below it.
        */}
        <p className="kh-hint" id="video-quality-readout" data-testid="quality-readout">
          {control === 'readonly' ? `${reading} — one resolution, nothing to choose.` : reading}
        </p>
      </GroupField>
    );
  }

  return (
    <>
      <GroupField
        label={control === 'bias' ? 'Quality bias' : 'Quality'}
        id="video-quality"
        {...(pickerReading === '' ? {} : { description: pickerReading })}
      >
        {/*
          A segmented row rather than a `<select>`: round 2's control-idiom rule
          is that this surface has no native pickers left, and a quality ladder
          is five one-word rungs — exactly the shape a segment row is for.
        */}
        <Segmented
          id="video-quality"
          wrap
          labelledBy="video-quality-label"
          value={qualityOptionValue(cfg.quality)}
          options={qualityOptions(control, levels)}
          onChange={(value) => {
            set({ quality: qualityFromOption(value, cfg.quality) });
          }}
        />
      </GroupField>
      {control === 'bias' && <p className="kh-hint">{YT_BIAS_HELPER}</p>}
    </>
  );
}

/**
 * §6.4 / §8.1 — the local downloader.
 *
 * Called "the resolver companion" everywhere in the code and the protocol docs,
 * and **"Local downloader"** here, because that is what it does for the person
 * reading: it turns a link into a file on this PC. It never blocks anything and
 * it never nags, and after the audit it no longer greets a working YouTube video
 * with an orange paragraph and a primary CTA — it lives here, inside the one
 * Advanced door, where somebody who wants ad-free playback goes looking for it.
 */
function LocalDownloaderCard({
  cfg,
  set,
}: {
  cfg: VideoModuleConfig;
  set: (patch: Partial<VideoModuleConfig>) => void;
}) {
  // Starts unknown and is filled by the effect below. Deliberately NOT seeded
  // from a static `peekHealth` import: that would pull the resolver client into
  // the config chunk and defeat the dynamic import everywhere else.
  const [health, setHealth] = useState<HealthState | null>(null);
  const [checking, setChecking] = useState(false);
  /** The guided install, in place. */
  const [connect, setConnect] = useState(false);

  const probe = useCallback(async (): Promise<void> => {
    setChecking(true);
    const { checkHealth, invalidateHealth } = await import('./resolver/resolverClient');
    // Drop both memo layers first: pressing "Check again" must actually re-probe,
    // not hand back the 60 s-old answer the display already cached.
    invalidateHealth();
    setHealth(await checkHealth(cfg.resolver));
    setChecking(false);
  }, [cfg.resolver]);

  useEffect(() => {
    // A mutable cell rather than a `let`: the panel can unmount (or the port can
    // change) inside the 1.2 s probe window, and TypeScript's control flow would
    // narrow a plain boolean to `true` across the awaits.
    const alive = { current: true };
    void (async () => {
      const { checkHealth } = await import('./resolver/resolverClient');
      const next = await checkHealth(cfg.resolver);
      if (alive.current) setHealth(next);
    })();
    return (): void => {
      alive.current = false;
    };
  }, [cfg.resolver]);

  const detected = health?.healthy === true;

  return (
    <>
      <h3 className="kh-subhead3">Local downloader</h3>
      <p className="kh-desc">
        A small program you run on this PC. It turns a link into a plain video file, which your
        Kraken then plays forever — ad-free, full quality, with the downloader switched off again.
      </p>

      <Row>
        <Chip tone={detected ? 'ok' : 'neutral'}>{detected ? 'Running' : 'Not running'}</Chip>
        <Button
          testId="downloader-check"
          onClick={() => {
            if (!checking) void probe();
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </Button>
        {!detected && !connect && (
          <Button
            testId="resolver-get"
            onClick={() => {
              setConnect(true);
            }}
          >
            Get the downloader
          </Button>
        )}
      </Row>

      {connect && (
        <ResolverConnectPanel
          resolver={cfg.resolver}
          onClose={() => {
            setConnect(false);
            void probe();
          }}
        />
      )}

      <GroupField
        label="Use it for"
        id="video-resolver-policy"
        description="Any failure quietly falls back to the normal player. You never see an error because of the downloader."
      >
        <Segmented
          id="video-resolver-policy"
          labelledBy="video-resolver-policy-label"
          value={cfg.resolver.policy}
          options={RESOLVER_POLICY_SEGMENTS}
          onChange={(value) => {
            const policy =
              RESOLVER_POLICY_SEGMENTS.find((o) => o.value === value)?.value ?? 'youtube-only';
            set({ resolver: { ...cfg.resolver, policy } });
          }}
        />
      </GroupField>

      <Field
        label="Port"
        htmlFor="video-resolver-port"
        description={`Default ${String(RESOLVER_DEFAULT_PORT)}. The address is always 127.0.0.1.`}
      >
        <NumberInput
          id="video-resolver-port"
          value={cfg.resolver.port}
          min={PORT_MIN}
          max={PORT_MAX}
          step={1}
          onChange={(port) => {
            set({ resolver: { ...cfg.resolver, port: Math.round(port) } });
          }}
        />
      </Field>

      <Field
        label="Shared token"
        htmlFor="video-resolver-token"
        description="Only if you started the downloader with --token."
      >
        <TextInput
          id="video-resolver-token"
          value={cfg.resolver.token}
          placeholder=""
          onChange={(token) => {
            set({ resolver: { ...cfg.resolver, token } });
          }}
        />
      </Field>
    </>
  );
}

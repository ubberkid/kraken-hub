import { useCallback, useEffect, useRef, useState } from 'react';

import { ALLORIGINS_PROXY_BASE } from '../../config/knownHosts';
import {
  Button,
  Chip,
  Disclosure,
  Field,
  GroupField,
  Notice,
  NumberInput,
  Panel,
  Row,
  Segmented,
  Select,
  TextInput,
  Toggle,
} from '../../ui';
import { FramingAdvanced, FramingPrimary } from '../../ui/Framing';

import {
  YT_BIAS_HELPER,
  describeQuality,
  qualityControlFor,
  qualityFromOption,
  qualityOptionValue,
  qualityOptions,
} from './quality';
import { ResolverConnectPanel } from './resolver/ResolverConnectPanel';
import { LOCAL_CLIP_SCHEME } from './routing/patterns';
import { validateUrl } from './routing/validate';
import {
  ASPECT_16_9,
  ASPECT_9_16,
  RESOLVER_DEFAULT_PORT,
  sourceAspectKey,
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

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateVideoConfig(config);
  // Validation runs at keystroke time here, because this is the only surface
  // where a human can actually read the answer (§7.2).
  const validation = validateUrl(cfg.url);
  const isYouTube = validation.match.provider === 'youtube-embed';

  const set = (patch: Partial<VideoModuleConfig>): void => {
    onChange({ ...cfg, ...patch });
  };

  return (
    <>
      {/*
        No link field. It sat two inches under the home screen's paste row and
        held the same string — the audit's census verdict was "keep-primary, but
        it duplicates the home paste row: merge". The paste row is the merge, and
        it owns the validation copy too.
      */}
      <Panel title="Video">
        {isYouTube && (
          /* §2.8 — said plainly, next to the field where the decision is made. */
          <Notice tone="warn">
            YouTube plays its ads <em>inside</em> the video, so cropping cannot remove them. Keep a
            copy for an ad-free, full-quality result.
          </Notice>
        )}

        <GroupField
          label="Keep a copy on this PC"
          id="video-downloadmode"
          description="A copy plays ad-free, offline, and forever."
        >
          <Segmented
            id="video-downloadmode"
            labelledBy="video-downloadmode-label"
            value={cfg.downloadMode}
            options={[
              { value: 'auto', label: 'Keep a copy', title: 'Fetch it once, then play the copy.' },
              { value: 'stream-only', label: 'Stream only', title: 'Never store anything.' },
            ]}
            onChange={(value) => {
              set({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
            }}
          />
        </GroupField>

        <QualityRow cfg={cfg} set={set} provider={validation.match.provider} />

        <FramingPrimary
          idPrefix="video"
          value={cfg.render}
          onChange={(patch) => {
            set({ render: { ...cfg.render, ...patch } });
          }}
        />
      </Panel>

      {/*
        ONE door, one level. Everything the census moved rather than killed is
        flat inside it — a disclosure inside a disclosure is a settings page
        wearing a costume.
      */}
      <Disclosure summary="Advanced" testId="video-advanced">
        <GroupField
          label="Shape of the video"
          id="video-yt-aspect"
          description="Only needed when the crop lands on the wrong part of the picture."
        >
          <Segmented
            id="video-yt-aspect"
            labelledBy="video-yt-aspect-label"
            value={
              SHAPE_SEGMENTS.some((s) => s.value === sourceAspectKey(cfg.youtube.sourceAspect))
                ? sourceAspectKey(cfg.youtube.sourceAspect)
                : 'auto'
            }
            options={SHAPE_SEGMENTS}
            onChange={(key) => {
              const found = SHAPE_SEGMENTS.find((s) => s.value === key);
              if (found === undefined) return;
              set({ youtube: { ...cfg.youtube, sourceAspect: found.aspect } });
            }}
          />
        </GroupField>

        <FramingAdvanced
          idPrefix="video"
          value={cfg.render}
          onChange={(patch) => {
            set({ render: { ...cfg.render, ...patch } });
          }}
        />

        <LocalDownloaderCard cfg={cfg} set={set} />

        <Field
          label="Use a public proxy as a last resort"
          htmlFor="video-proxy"
          description="allorigins.win is a free public service with no uptime promise, and it sees every URL your Kraken plays. Tried only for links nothing else could fetch, and it cannot fix HLS."
        >
          <Toggle
            id="video-proxy"
            checked={cfg.proxyBase === ALLORIGINS_PROXY_BASE}
            onChange={(on) => {
              set({ proxyBase: on ? ALLORIGINS_PROXY_BASE : '' });
            }}
          />
        </Field>
        <Field
          label="Or your own proxy address"
          htmlFor="video-proxy-base"
          description="Ends in ?url=."
        >
          <TextInput
            id="video-proxy-base"
            value={cfg.proxyBase}
            placeholder="your proxy's base URL, ending in ?url="
            onChange={(proxyBase) => {
              set({ proxyBase });
            }}
          />
        </Field>
      </Disclosure>
    </>
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
 * This is the one `<select>` the census kept, and it kept it because its options
 * are not sentences: they are resolutions the display reported, one word each.
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
  const reading = describeQuality(cfg.quality, {
    reported: tele?.quality ?? null,
    local: cfg.url.startsWith(LOCAL_CLIP_SCHEME),
  });

  if (control === 'readonly' || control === 'none') {
    return (
      <Field label="Quality" htmlFor="video-quality">
        <p className="kh-hint" id="video-quality" data-testid="quality-readout">
          {reading}
          {control === 'readonly'
            ? ' — a stored file has one resolution, so there is nothing to choose.'
            : ' — nothing is playing yet.'}
        </p>
      </Field>
    );
  }

  return (
    <>
      <Field
        label={control === 'bias' ? 'Quality bias' : 'Quality'}
        htmlFor="video-quality"
        description={reading}
      >
        <Select
          id="video-quality"
          value={qualityOptionValue(cfg.quality)}
          options={qualityOptions(control, levels)}
          onChange={(value) => {
            set({ quality: qualityFromOption(value, cfg.quality) });
          }}
        />
      </Field>
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

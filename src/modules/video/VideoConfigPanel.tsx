import { useCallback, useEffect, useRef, useState } from 'react';
import { useMemo } from 'react';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import {
  Button,
  Chip,
  Code,
  Disclosure,
  Field,
  Notice,
  NumberInput,
  Panel,
  RangeInput,
  Row,
  Select,
  TextInput,
  Toggle,
} from '../../ui';

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
import { primaryIssue, validateUrl } from './routing/validate';
import {
  PAN_LIMIT,
  PROXY_PRESETS,
  RESOLVER_DEFAULT_PORT,
  PORTRAIT_WIDTH_ALT,
  PORTRAIT_WIDTH_DEFAULT,
  SOURCE_ASPECT_PRESETS,
  YT_LADDER,
  ZOOM_MAX,
  ZOOM_MIN,
  resolveSourceAspect,
  sourceAspectKey,
  validateVideoConfig,
  type ProviderId,
  type VideoModuleConfig,
} from './types';
import { isFpsAdvisoryDismissed, setFpsAdvisoryDismissed } from './ui/FpsAdvisory';
import { computeGeometry } from './youtube/geometry';

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
 * ## What sits where, and why
 *
 * The Halo redesign draws a hard line through this panel: the controls a person
 * uses are on the surface in plain words, and everything that exists because of
 * how the thing is built is one disclosure down. "Fit", "Keep a copy on this
 * PC" and "Loop a section" are on top; the YouTube geometry engine, the CORS
 * proxy and the downloader's policy/port/token are under **Advanced**.
 *
 * Two ids are load-bearing beyond this file: the home screen's inline-ops line
 * scrolls to and focuses `video-fit`, `video-downloadmode` and
 * `video-loop-enabled` by id (`HomeView.describeOps`). Those three must stay on
 * the primary surface — a line that names a control and then hides it inside a
 * collapsed disclosure is worse than no line at all.
 */

const ZOOM_STEP = 0.05;
const PAN_STEP = 0.01;
const SECONDS_STEP = 0.1;
const MAX_SECONDS = 86_400;
const PAN_DECIMALS = 2;
const ZOOM_DECIMALS = 2;

const RESOLVER_POLICY_OPTIONS = [
  { value: 'off', label: 'Never — ignore the downloader even when it is running' },
  {
    value: 'youtube-only',
    label: 'YouTube links only (recommended)',
  },
  { value: 'preferred', label: 'Anything that shows its own player controls' },
  { value: 'fallback', label: 'Only after the normal player has failed' },
] as const;

const PORT_MIN = 1;
const PORT_MAX = 65_535;

const PAUSE_STRATEGY_OPTIONS = [
  { value: 'microloop', label: 'Micro-loop (recommended) — never shows YouTube’s pause overlay' },
  { value: 'maskedPause', label: 'Masked pause — lower power, hidden behind the mask' },
] as const;

const GEOMETRY_MODE_OPTIONS = [
  { value: 'square', label: 'Square (default) — widest margin for YouTube’s chrome' },
  { value: 'tight', label: 'Tight — 25 % less compositor surface, same crop' },
] as const;

const PORTRAIT_WIDTH_OPTIONS = [
  {
    value: String(PORTRAIT_WIDTH_DEFAULT),
    label: `${String(PORTRAIT_WIDTH_DEFAULT)} px (default)`,
  },
  {
    value: String(PORTRAIT_WIDTH_ALT),
    label: `${String(PORTRAIT_WIDTH_ALT)} px (try if quality is low)`,
  },
] as const;

const FIT_OPTIONS = [
  { value: 'cover', label: 'Cover — fill the panel, crop the overflow' },
  { value: 'contain', label: 'Contain — fit inside the bounding square' },
  { value: 'contain-circle', label: 'Contain (circle) — fit inside the round bezel' },
  { value: 'fill', label: 'Fill — stretch to the panel (distorts)' },
] as const;

const ROTATE_OPTIONS = [
  { value: '0', label: '0°' },
  { value: '90', label: '90°' },
  { value: '180', label: '180°' },
  { value: '270', label: '270°' },
] as const;

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateVideoConfig(config);
  // Validation runs at keystroke time here, because this is the only surface
  // where a human can actually read the answer (§7.2).
  const validation = useMemo(() => validateUrl(cfg.url), [cfg.url]);
  const issue = cfg.url.trim() === '' ? null : primaryIssue(validation);
  const isYouTube = validation.match.provider === 'youtube-embed';

  /**
   * §2.3 — the zoom at which the crop stops supersampling and the panel starts
   * upscaling. Quoted against the Kraken Elite, the panel this is measured on
   * and by far the most common; a smaller panel only has more headroom, so a
   * warning shown here is never a false alarm on a Z or a 2023.
   */
  const parity = useMemo(() => {
    const device = DEVICE_PRESETS.elite;
    const g = computeGeometry({
      displayW: device.width,
      displayH: device.height,
      dpr: 1,
      zoom: cfg.render.zoom,
      sourceAspect: resolveSourceAspect(cfg.youtube.sourceAspect, false),
      mode: cfg.youtube.mode,
      qualityFloorPx: cfg.youtube.qualityFloorPx,
      ladder: YT_LADDER,
      portraitWidth: cfg.youtube.portraitWidth,
    });
    return { limit: g.pixelParityZoomLimit, elementW: g.elementW, device };
  }, [cfg.render.zoom, cfg.youtube]);

  const set = (patch: Partial<VideoModuleConfig>): void => {
    onChange({ ...cfg, ...patch });
  };

  return (
    <>
      <Panel
        title="Video"
        hint="Paste a link and kraken-hub keeps a copy on this PC, then plays that copy — no ads, no player chrome, and it keeps working offline."
      >
        <Field
          label="Video link"
          htmlFor="video-url"
          description="Leave it empty to play the bundled demo clip."
        >
          <TextInput
            id="video-url"
            value={cfg.url}
            placeholder="Paste a video link"
            onChange={(url) => {
              set({ url });
            }}
          />
        </Field>
        {issue !== null && (
          <Notice tone={issue.severity === 'error' ? 'error' : 'warn'}>{issue.message}</Notice>
        )}
        {issue === null && cfg.url.trim() !== '' && validation.match.provider !== null && (
          <Notice tone="ok">Recognised as {validation.match.provider}.</Notice>
        )}
        {isYouTube && (
          /* §2.8 — said plainly, next to the field where the decision is made. */
          <Notice tone="warn">
            YouTube embeds can serve ads, and ads play <em>inside</em> the video, so cropping cannot
            remove them. The crop hides YouTube’s player chrome, not its advertising. For an
            ad-free, chrome-free, full-quality result, download the clip to the local library or run
            the resolver companion.
          </Notice>
        )}

        <Field
          label="Keep a copy on this PC"
          htmlFor="video-downloadmode"
          description="Keeping a copy is what makes playback ad-free and offline-proof. Streaming plays straight from the link every time."
        >
          <Select
            id="video-downloadmode"
            value={cfg.downloadMode}
            options={[
              { value: 'auto', label: 'Keep a copy (recommended)' },
              { value: 'stream-only', label: 'Stream only — never store anything' },
            ]}
            onChange={(value) => {
              set({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
            }}
          />
        </Field>

        <QualityRow cfg={cfg} set={set} provider={validation.match.provider} />

        <Disclosure summary="Advanced" testId="video-advanced">
          <Field
            label="Picture quality"
            htmlFor="video-perf"
            description="Automatic eases off when CAM's frame rate is low or the panel cannot keep up."
          >
            <Select
              id="video-perf"
              value={cfg.perf}
              options={[
                { value: 'auto', label: 'Automatic' },
                { value: 'quality', label: 'Favour quality' },
                { value: 'performance', label: 'Favour smoothness' },
              ]}
              onChange={(value) => {
                set({ perf: value === 'quality' || value === 'performance' ? value : 'auto' });
              }}
            />
          </Field>

          <YouTubeGeometry cfg={cfg} set={set} parity={parity} />

          <Field
            label="Last-resort proxy"
            htmlFor="video-proxy"
            description="Tried last, and only for links nothing else could play. A proxy sees every URL the display plays. A plain passthrough proxy cannot fix HLS: the segment URLs inside a manifest still resolve to the origin host."
          >
            <Select
              id="video-proxy"
              value={PROXY_PRESETS.find((o) => o.base === cfg.proxyBase)?.key ?? 'custom'}
              options={[
                ...PROXY_PRESETS.map((o) => ({ value: o.key, label: o.label })),
                { value: 'custom', label: 'Custom — enter a base URL below' },
              ]}
              onChange={(key) => {
                const preset = PROXY_PRESETS.find((o) => o.key === key);
                if (preset !== undefined) set({ proxyBase: preset.base });
              }}
            />
          </Field>
          <Field label="Proxy base URL" htmlFor="video-proxy-base">
            <TextInput
              id="video-proxy-base"
              value={cfg.proxyBase}
              placeholder="your worker's base URL, ending in ?url="
              onChange={(proxyBase) => {
                set({ proxyBase });
              }}
            />
          </Field>
          <FpsAdvisoryToggle />
        </Disclosure>
      </Panel>

      <Panel
        title="Framing"
        hint="How the picture sits in the panel. Changing these never restarts playback."
      >
        <Field label="Fit" htmlFor="video-fit">
          <Select
            id="video-fit"
            value={cfg.render.fit}
            options={FIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(value) => {
              const fit = FIT_OPTIONS.find((o) => o.value === value)?.value ?? 'cover';
              set({ render: { ...cfg.render, fit } });
            }}
          />
        </Field>

        <Field label={`Zoom — ${cfg.render.zoom.toFixed(ZOOM_DECIMALS)}×`} htmlFor="video-zoom">
          <RangeInput
            id="video-zoom"
            value={cfg.render.zoom}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onChange={(zoom) => {
              set({ render: { ...cfg.render, zoom } });
            }}
          />
        </Field>

        <Disclosure summary="Advanced" testId="video-framing-advanced">
          <Field label={`Pan X — ${cfg.render.offsetX.toFixed(PAN_DECIMALS)}`} htmlFor="video-panx">
            <RangeInput
              id="video-panx"
              value={cfg.render.offsetX}
              min={-PAN_LIMIT}
              max={PAN_LIMIT}
              step={PAN_STEP}
              onChange={(offsetX) => {
                set({ render: { ...cfg.render, offsetX } });
              }}
            />
          </Field>

          <Field label={`Pan Y — ${cfg.render.offsetY.toFixed(PAN_DECIMALS)}`} htmlFor="video-pany">
            <RangeInput
              id="video-pany"
              value={cfg.render.offsetY}
              min={-PAN_LIMIT}
              max={PAN_LIMIT}
              step={PAN_STEP}
              onChange={(offsetY) => {
                set({ render: { ...cfg.render, offsetY } });
              }}
            />
          </Field>

          <Field label="Rotate" htmlFor="video-rotate">
            <Select
              id="video-rotate"
              value={String(cfg.render.rotate)}
              options={ROTATE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(value) => {
                const rotate = Number(value) as VideoModuleConfig['render']['rotate'];
                set({ render: { ...cfg.render, rotate } });
              }}
            />
          </Field>
        </Disclosure>
      </Panel>

      <LocalDownloaderCard cfg={cfg} set={set} />

      <Panel
        title="Loop a section"
        hint="Plays the same stretch forever. Leave the end empty to loop to just before the clip finishes — playback never reaches the final second, so there is no end screen and no gap."
      >
        <Field label="Loop this clip" htmlFor="video-loop-enabled">
          <Toggle
            id="video-loop-enabled"
            checked={cfg.loop.enabled}
            onChange={(enabled) => {
              set({ loop: { ...cfg.loop, enabled } });
            }}
          />
        </Field>
        <Field label="Start (seconds)" htmlFor="video-loop-start">
          <NumberInput
            id="video-loop-start"
            value={cfg.loop.start}
            min={0}
            max={MAX_SECONDS}
            step={SECONDS_STEP}
            onChange={(start) => {
              set({ loop: { ...cfg.loop, start } });
            }}
          />
        </Field>
        <Field
          label="End (seconds)"
          htmlFor="video-loop-end"
          description="0 or empty means “play to the end of the clip”."
        >
          <NumberInput
            id="video-loop-end"
            value={cfg.loop.end ?? 0}
            min={0}
            max={MAX_SECONDS}
            step={SECONDS_STEP}
            onChange={(end) => {
              set({ loop: { ...cfg.loop, end: end <= 0 ? null : end } });
            }}
          />
        </Field>
        <p className="kh-hint">
          On your phone, the same loop is two handles you drag along the scrubber.
        </p>
        <Disclosure summary="Advanced" testId="video-loop-advanced">
          <Field
            label="Fade across the join"
            htmlFor="video-loop-crossfade"
            description="Smooths the moment the clip jumps back, at the cost of a second video decoder. Switched off automatically when the panel is short of frames."
          >
            <Toggle
              id="video-loop-crossfade"
              checked={cfg.loop.mode === 'crossfade'}
              onChange={(on) => {
                set({ loop: { ...cfg.loop, mode: on ? 'crossfade' : 'hard' } });
              }}
            />
          </Field>
        </Disclosure>
      </Panel>
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
 * The YouTube geometry engine's controls.
 *
 * Extracted so they can live inside the Video panel's **Advanced** disclosure
 * rather than shouting "YouTube geometry" at somebody who pasted a link. The
 * copy keeps the mechanism — this is the one place where knowing the trick is
 * the difference between a soft picture and a sharp one — but it is now behind
 * one tap, which is where the design says a mechanism belongs.
 */
function YouTubeGeometry({
  cfg,
  set,
  parity,
}: {
  cfg: VideoModuleConfig;
  set: (patch: Partial<VideoModuleConfig>) => void;
  parity: { limit: number; elementW: number; device: { label: string } };
}) {
  return (
    <>
      <h3 className="kh-subhead">YouTube picture</h3>
      <p className="kh-hint">
        A deliberately oversized, letterboxing player pushes YouTube&rsquo;s own buttons onto the
        black bars, and the large measured width is what makes YouTube send a 1080p stream instead
        of a 360p one. These tune that trick.
      </p>

      <Field
        label="Shape of the original video"
        htmlFor="video-yt-aspect"
        description="There is no way to read a video's true shape across origins, so this is a manual step. Get it wrong and the crop lands on the wrong part of the picture."
      >
        <Select
          id="video-yt-aspect"
          value={sourceAspectKey(cfg.youtube.sourceAspect)}
          options={SOURCE_ASPECT_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
          onChange={(key) => {
            const preset = SOURCE_ASPECT_PRESETS.find((p) => p.key === key);
            if (preset === undefined) return;
            set({ youtube: { ...cfg.youtube, sourceAspect: preset.value } });
          }}
        />
      </Field>

      <Field
        label="Player size"
        htmlFor="video-yt-mode"
        description="Tight keeps the same crop and the same measured width, but drops the player's height so there is a quarter less surface to move each frame. Chosen automatically when smoothness is favoured."
      >
        <Select
          id="video-yt-mode"
          value={cfg.youtube.mode}
          options={GEOMETRY_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(value) => {
            const mode = value === 'tight' ? 'tight' : 'square';
            set({ youtube: { ...cfg.youtube, mode } });
          }}
        />
      </Field>

      <Field
        label="Width for vertical videos and Shorts"
        htmlFor="video-yt-portrait"
        description="Whether the smaller width still gets a 1080p stream out of YouTube is unverified on hardware (checklist H05/H11). Raise it if vertical videos look soft."
      >
        <Select
          id="video-yt-portrait"
          value={String(cfg.youtube.portraitWidth)}
          options={PORTRAIT_WIDTH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(value) => {
            const portraitWidth = Number(value);
            if (!Number.isFinite(portraitWidth)) return;
            set({ youtube: { ...cfg.youtube, portraitWidth } });
          }}
        />
      </Field>

      <Field
        label="What “hold” does"
        htmlFor="video-yt-pause"
        description="YouTube's own pause raises a grid of suggested videos inside the picture, where cropping cannot reach it — so kraken-hub never calls it by default. The other option does call it, behind our own cover, and uses less power on long holds."
      >
        <Select
          id="video-yt-pause"
          value={cfg.youtube.pauseStrategy}
          options={PAUSE_STRATEGY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(value) => {
            const pauseStrategy = value === 'maskedPause' ? 'maskedPause' : 'microloop';
            set({ youtube: { ...cfg.youtube, pauseStrategy } });
          }}
        />
      </Field>

      {cfg.render.zoom > parity.limit && (
        <Notice tone="warn">
          {`At zoom ${cfg.render.zoom.toFixed(ZOOM_DECIMALS)}× on a ${parity.device.label} the
          ${String(parity.elementW)} px player stops supersampling — past
          ${parity.limit.toFixed(ZOOM_DECIMALS)}× the panel is enlarging pixels and the picture gets
          softer, not closer. Reduce the zoom, or let the quality watchdog step the player up.`}
        </Notice>
      )}
    </>
  );
}

/**
 * §6.4 / §8.1 — the local downloader card.
 *
 * Called "the resolver companion" everywhere in the code and the protocol docs,
 * and **"Local downloader"** here, because that is what it does for the person
 * reading: it turns a link into a file on this PC. The whole point of the design
 * is that it is optional, so this card has exactly two jobs — say plainly
 * whether one is running, and, when it is not, say how to start one. It never
 * blocks anything and it never nags. Its policy, port and token are technical
 * and live under Advanced.
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
  /** The guided install, in place — the same panel the home screen opens. */
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
    <Panel
      title="Local downloader (optional)"
      hint="A small program you run on this PC. kraken-hub asks it to turn a link into a plain video file, keeps that file, and then plays it forever — ad-free, no player chrome, full quality, and with the downloader switched off again."
    >
      <Row>
        <Chip tone={detected ? 'ok' : 'neutral'}>
          {detected ? 'Downloader detected' : 'Not detected'}
        </Chip>
        <Button
          testId="downloader-check"
          onClick={() => {
            if (!checking) void probe();
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </Row>

      {detected ? (
        <Notice tone="ok">
          Videos are kept on this PC, ad-free, at full quality. Once a clip is in the library it
          keeps playing with the downloader stopped.
        </Notice>
      ) : (
        <>
          <Notice tone="warn">
            {`${health?.reason ?? 'Not checked yet.'} kraken-hub works without it — YouTube links fall back to the built-in player automatically, with no error. `}
            {connect ? '' : 'Press “Get the downloader” for the one-click install, or see '}
            {connect ? null : <Code inline>docs/resolver-protocol.md</Code>}
            {connect ? '' : ' for what it does and what it does not.'}
          </Notice>
          {connect ? (
            <ResolverConnectPanel
              resolver={cfg.resolver}
              onClose={() => {
                setConnect(false);
                void probe();
              }}
            />
          ) : (
            <Row>
              <Button
                primary
                testId="resolver-get"
                onClick={() => {
                  setConnect(true);
                }}
              >
                Get the downloader
              </Button>
            </Row>
          )}
        </>
      )}

      <Disclosure summary="Advanced" testId="downloader-advanced">
        <Field
          label="When to use it"
          htmlFor="video-resolver-policy"
          description="Any failure — not running, a timeout, an error — quietly falls back to the normal player. You never see an error because of the downloader."
        >
          <Select
            id="video-resolver-policy"
            value={cfg.resolver.policy}
            options={RESOLVER_POLICY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(value) => {
              const policy =
                RESOLVER_POLICY_OPTIONS.find((o) => o.value === value)?.value ?? 'youtube-only';
              set({ resolver: { ...cfg.resolver, policy } });
            }}
          />
        </Field>

        <Field
          label="Port"
          htmlFor="video-resolver-port"
          description={`Default ${String(RESOLVER_DEFAULT_PORT)}. The address is always 127.0.0.1 — a LAN address would be blocked as mixed content, and would let another machine drive your downloads.`}
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
          label="Shared token (optional)"
          htmlFor="video-resolver-token"
          description="Only needed if you started the downloader with --token. Running one means any site you visit could ask your machine to download a video; a token is how you stop that."
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
      </Disclosure>
    </Panel>
  );
}

/** §8.1 — the LCD cannot dismiss the advisory; this is the only place that can. */
function FpsAdvisoryToggle() {
  const [dismissed, setDismissed] = useState(() => isFpsAdvisoryDismissed());
  return (
    <Field
      label="Hide the frame-rate warning"
      htmlFor="video-fps-dismiss"
      description="CAM ships the Kraken's web integration at 1 frame per second, and the panel says so until you raise it. Hide the notice only if you have decided to live with it."
    >
      <Toggle
        id="video-fps-dismiss"
        checked={dismissed}
        onChange={(next) => {
          setFpsAdvisoryDismissed(next);
          setDismissed(next);
        }}
      />
    </Field>
  );
}

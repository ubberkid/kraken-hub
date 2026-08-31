import { useCallback, useEffect, useState } from 'react';
import { useMemo } from 'react';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import {
  Button,
  Chip,
  Code,
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
  type VideoModuleConfig,
} from './types';
import { isFpsAdvisoryDismissed, setFpsAdvisoryDismissed } from './ui/FpsAdvisory';
import { computeGeometry } from './youtube/geometry';

import type { ModuleConfigProps } from '../types';
import type { HealthState } from './resolver/resolverClient';

/**
 * The video module's config panel. Config-only code: invariant I8 keeps this
 * `.tsx` out of the display graph entirely, which is why the URL field can
 * afford to import the whole validation table.
 *
 * The clip library, the download list and the upload drop zone live in the
 * Sources view — this panel is about *this* module's settings.
 */

const ZOOM_STEP = 0.05;
const PAN_STEP = 0.01;
const SECONDS_STEP = 0.1;
const MAX_SECONDS = 86_400;
const PAN_DECIMALS = 2;
const ZOOM_DECIMALS = 2;

const RESOLVER_POLICY_OPTIONS = [
  { value: 'off', label: 'Off — never use the companion' },
  {
    value: 'youtube-only',
    label: 'YouTube only (default) — use it for YouTube links when it is running',
  },
  { value: 'preferred', label: 'Preferred — use it for anything that paints its own player UI' },
  { value: 'fallback', label: 'Fallback — only after the normal player fails' },
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
        hint="Paste a link. kraken-hub downloads it into the local clip library and plays the local copy — no CORS, no ads, works offline."
      >
        <Field
          label="Source URL"
          htmlFor="video-url"
          description="Leave empty to play the bundled demo clip. A local clip reads kraken-hub-clip:<id>."
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
          label="Download and keep a local copy"
          htmlFor="video-downloadmode"
          description="Auto: fetch the bytes into the clip library when they are reachable, then play from disk forever. Stream-only: always play from the remote URL."
        >
          <Select
            id="video-downloadmode"
            value={cfg.downloadMode}
            options={[
              { value: 'auto', label: 'Auto — download and keep (recommended)' },
              { value: 'stream-only', label: 'Stream only — never store' },
            ]}
            onChange={(value) => {
              set({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
            }}
          />
        </Field>

        <Field
          label="Performance mode"
          htmlFor="video-perf"
          description="Auto drops to performance when CAM's frame rate is low or the panel cannot keep up."
        >
          <Select
            id="video-perf"
            value={cfg.perf}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'quality', label: 'Quality' },
              { value: 'performance', label: 'Performance' },
            ]}
            onChange={(value) => {
              set({ perf: value === 'quality' || value === 'performance' ? value : 'auto' });
            }}
          />
        </Field>
      </Panel>

      <Panel
        title="Framing"
        hint="Written straight to the compositor — changing these never restarts playback."
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
      </Panel>

      <Panel
        title="YouTube geometry"
        hint="An oversized, letterboxing iframe pushes YouTube's chrome onto the black bars, and the large measured width is what makes YouTube serve 1080p instead of 360p. These settings tune that trick."
      >
        <Field
          label="Source aspect ratio"
          htmlFor="video-yt-aspect"
          description="There is no way to read a video's true aspect across origins, so this is a manual step. Get it wrong and the crop lands on the wrong part of the picture."
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
          label="Geometry mode"
          htmlFor="video-yt-mode"
          description="Tight keeps the same crop and the same measured width, but drops the element height so the compositor has a quarter less surface to move. Performance mode selects it automatically."
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
          label="Vertical / Shorts element width"
          htmlFor="video-yt-portrait"
          description="Whether a 1080-wide element still elicits 1080p from YouTube's size heuristic is unverified on hardware (hardware checklist H05/H11). Raise it if vertical videos look soft."
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
          label="Hold behaviour"
          htmlFor="video-yt-pause"
          description="YouTube's pause raises a suggested-video grid inside the picture, where cropping cannot reach it — so kraken-hub never calls it by default. Masked pause does call it, behind our own mask, and is the lower-power choice for long holds."
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
            ${String(parity.elementW)} px element stops supersampling — past
            ${parity.limit.toFixed(ZOOM_DECIMALS)}× the panel is upscaling and the picture gets
            softer, not closer. Reduce the zoom, or let the quality watchdog step the element up.`}
          </Notice>
        )}
      </Panel>

      <ResolverCard cfg={cfg} set={set} />

      <Panel
        title="Playback fallbacks"
        hint="Everything here is off by default and is only reached after the direct attempts in the fallback chain have failed."
      >
        <Field
          label="CORS proxy (advanced)"
          htmlFor="video-proxy"
          description="Tried last, and only for links nothing else could play. A proxy sees every URL the display plays. Note that a plain passthrough proxy cannot fix HLS: the segment URLs inside a manifest still resolve to the origin host."
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
      </Panel>

      <Panel
        title="A-B loop"
        hint="Loops a section forever. Leave the end empty to loop to just before the clip ends — playback never reaches the final second, so no end screen and no gap."
      >
        <Field label="Enabled" htmlFor="video-loop-enabled">
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
          description="0 or empty means “to the end of the clip”."
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
        <Field
          label="Crossfade the seam"
          htmlFor="video-loop-crossfade"
          description="Costs a second video decoder. Disabled automatically in performance mode and at 10 FPS or below."
        >
          <Toggle
            id="video-loop-crossfade"
            checked={cfg.loop.mode === 'crossfade'}
            onChange={(on) => {
              set({ loop: { ...cfg.loop, mode: on ? 'crossfade' : 'hard' } });
            }}
          />
        </Field>
      </Panel>
    </>
  );
}

/**
 * §6.4 / §8.1 — the companion card.
 *
 * The whole point of the resolver design is that it is optional, so this card
 * has exactly two jobs: say plainly whether one is running, and — when it is
 * not — say how to start one. It never blocks anything and it never nags.
 */
function ResolverCard({
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
      title="Resolver companion (optional)"
      hint="A small program you run on this PC. kraken-hub asks it for a plain video file on 127.0.0.1, downloads that into the local clip library, and then plays the clip forever — ad-free, chrome-free, full quality, and with the companion switched off."
    >
      <Row>
        <Chip tone={detected ? 'ok' : 'neutral'}>
          {detected ? 'Resolver detected' : 'No companion running'}
        </Chip>
        <Button
          onClick={() => {
            if (!checking) void probe();
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </Row>

      {detected ? (
        <Notice tone="ok">
          Videos download locally, ad-free, at full quality. Once a clip is in the library it keeps
          playing with the companion stopped.
        </Notice>
      ) : (
        <Notice tone="warn">
          {`${health?.reason ?? 'Not checked yet.'} kraken-hub works without it — YouTube links fall back to the geometry engine automatically, with no error. To install it, run `}
          <Code>npx kraken-hub-resolver</Code>
          {' in a terminal on this PC and leave it running, then press “Check again”. See '}
          <Code>docs/resolver-protocol.md</Code>
          {' for what it does and what it does not.'}
        </Notice>
      )}

      <Field
        label="When to use it"
        htmlFor="video-resolver-policy"
        description="Any failure — not running, a timeout, an error — silently falls back to the normal player. You never see an error because of the companion."
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
        description="Only needed if you started the companion with --token. Installing a companion means any site you visit can ask your machine to download a video; a token is how you stop that."
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
    </Panel>
  );
}

/** §8.1 — the LCD cannot dismiss the advisory; this is the only place that can. */
function FpsAdvisoryToggle() {
  const [dismissed, setDismissed] = useState(() => isFpsAdvisoryDismissed());
  return (
    <Field
      label="Hide the low-frame-rate advisory"
      htmlFor="video-fps-dismiss"
      description="CAM ships the LCD Web Integration at 1 FPS, and the display says so until you raise it. Hide the notice only if you have decided to live with the frame rate."
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

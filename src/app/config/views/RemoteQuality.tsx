import { memo } from 'react';

import {
  YT_BIAS_HELPER,
  describeQuality,
  qualityControlFor,
  qualityFromOption,
  qualityOptionValue,
  qualityOptions,
  type QualityConfig,
} from '../../../modules/video/quality';
import { LOCAL_CLIP_SCHEME } from '../../../modules/video/routing/patterns';
import { GroupField, Segmented } from '../../../ui';

import type { ProviderId, VideoModuleConfig } from '../../../modules/video/types';

/**
 * The same quality control as the CAM panel, in a thumb-sized form.
 *
 * Identical rules and identical words — `src/modules/video/quality.ts` owns
 * both, so the two surfaces can never disagree about who controls the picture.
 * The difference is only where the truth comes from: the panel reads the
 * telemetry mirror over CAM's shared origin, and this reads the same packet off
 * the encrypted `tele` channel.
 *
 * A pin travels as ordinary module *config* — it is a setting, not a command —
 * so it reaches the display through the retained state snapshot and survives a
 * cold boot, exactly like the A-B loop.
 *
 * ## `tele` must be a VIDEO packet
 *
 * This component's shape is derived from `provider`: `bias` and `set` render a
 * segmented ladder, `readonly` and `none` render a paragraph. So handing it a
 * packet that simply has no opinion about the video does not degrade the
 * reading — it REPLACES the control with prose and throws its DOM node away.
 *
 * That is exactly what used to happen. The caller passed `lastTele`, "the most
 * recent packet of any kind", and the `tele` channel is shared: the replica
 * feed's `monitor` packet lands between two `videoStats` packets every couple
 * of seconds and knows nothing about any provider. The picker therefore
 * vanished and came back on the telemetry cadence, taking its subtree with it.
 * The caller now passes `lastVideo`, which is sticky across the other kinds —
 * see `carriesVideoTelemetry` in `../useSync.ts`.
 *
 * It lives in its own file so that the regression test can mount it directly
 * and assert on DOM node identity, which is the only assertion that can tell a
 * remount from a re-render.
 */
export const RemoteQuality = memo(function RemoteQuality({
  cfg,
  tele,
  fallbackProvider,
  onChange,
}: {
  cfg: VideoModuleConfig;
  tele: Record<string, unknown> | null;
  fallbackProvider: ProviderId | null;
  onChange: (next: QualityConfig) => void;
}) {
  const reportedProvider = typeof tele?.['provider'] === 'string' ? tele['provider'] : null;
  // The mounted adapter beats the URL's guess: a link that looks like a bare
  // `.m3u8` may have ended up on the resolver, and the adapter that is actually
  // running is the one whose control is real.
  const control = qualityControlFor((reportedProvider as ProviderId | null) ?? fallbackProvider);
  const rawLevels = tele?.['levels'];
  const levels = Array.isArray(rawLevels)
    ? (rawLevels as { h: number; l: string }[]).map((l) => ({ height: l.h, label: l.l }))
    : [];
  const rawQuality = tele?.['quality'];
  const reported =
    typeof rawQuality === 'object' && rawQuality !== null
      ? (rawQuality as { height?: number | null; label?: string | null })
      : null;
  const reading = describeQuality(cfg.quality, {
    reported,
    local: cfg.url.startsWith(LOCAL_CLIP_SCHEME),
  });

  if (control === 'readonly' || control === 'none') {
    return (
      <p className="kh-hint" id="remote-quality-readout" data-testid="remote-quality-readout">
        {reading}
        {control === 'readonly'
          ? ' — one resolution, nothing to choose.'
          : ' — nothing is playing yet.'}
      </p>
    );
  }

  return (
    <>
      <GroupField
        label={control === 'bias' ? 'Bias' : 'Quality'}
        id="remote-quality"
        description={reading}
      >
        {/*
          The same segmented ladder the CAM panel draws (R8): the remote was the
          last surface in the product with a native `<select>` on it, and a
          picker whose options are one word each was never a popup's job.
        */}
        <Segmented
          id="remote-quality"
          wrap
          labelledBy="remote-quality-label"
          value={qualityOptionValue(cfg.quality)}
          options={qualityOptions(control, levels)}
          onChange={(value) => {
            onChange(qualityFromOption(value, cfg.quality));
          }}
        />
      </GroupField>
      {control === 'bias' && <p className="kh-hint">{YT_BIAS_HELPER}</p>}
    </>
  );
});

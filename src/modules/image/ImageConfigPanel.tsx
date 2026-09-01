/**
 * The image module's settings panel.
 *
 * Config-only code (invariant I8): `.tsx` under `src/modules/` is chunked into
 * `config-ui` and can never reach the display graph, so this file is free to
 * read the library index, use the UI kit and render React.
 *
 * ## The settings census
 *
 * Ten controls became four on the surface, on the design audit's §2 verdicts:
 *
 *  - **Framing is not written here any more.** It was a byte-for-byte copy of
 *    the video panel's fit/zoom/pan/rotate block in *different words*, so both
 *    now import `ui/Framing` and a user who learned "Cover" once has learned it
 *    everywhere.
 *  - **Background colour is gone.** It was a free-form hex text field for the
 *    strip around a picture that does not fill a round panel, on a device whose
 *    bezel is black. Black stays; the field does not.
 *  - **The slideshow moved behind Advanced**, because a slideshow is a thing you
 *    set up once and then never touch.
 *
 * Round 2 took two more:
 *
 *  - **The picture link is not written here either.** The home screen's primary
 *    action is contextual now — with Image on the panel, the row under the halo
 *    *is* the picture-link field, submitted by the same validation this panel
 *    used to run. Two fields holding one string, one of them behind a
 *    disclosure, is the shape of the problem the whole redesign is about.
 *  - **Fit and Slideshow are on the ops strip**, in view, so they are not asked
 *    again down here.
 *
 * ## Wave 2, C1 — and the picture list is gone
 *
 * The audit parked the decision (§6) and it is made: **there is one shelf, and
 * a module panel holds settings only.** This panel used to render its own "Your
 * pictures" list beside the unified Library grid — an asymmetry clips never had,
 * a second name for the one shelf, and a second place to go looking for a
 * picture. Photos has no separate Videos app; kind is a property, not a place.
 *
 * Picking a stored picture is what the Library grid's tiles do, for both kinds,
 * through one commit (`app/config/showTile.ts`). Deleting this list took a
 * feature away from nowhere: the same act, on the same picture, is one screen
 * over and works from the sofa as well as from CAM.
 */

import { KEEP_A_COPY, KEEP_A_COPY_LABEL, STREAM_ONLY } from '../../config/vocabulary';
import { Field, GroupField, ModuleOptions, RangeInput, Segmented } from '../../ui';
import { FramingAdvanced } from '../../ui/Framing';

import {
  SLIDESHOW_MAX_INTERVAL_SEC,
  SLIDESHOW_MIN_INTERVAL_SEC,
  validateImageConfig,
  type ImageModuleConfig,
} from './schema';

import type { ModuleConfigProps } from '../types';

const INTERVAL_STEP = 5;

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateImageConfig(config);

  const patch = (next: Partial<ImageModuleConfig>): void => {
    onChange({ ...cfg, ...next });
  };
  const patchRender = (next: Partial<ImageModuleConfig['render']>): void => {
    onChange({ ...cfg, render: { ...cfg.render, ...next } });
  };

  return (
    <ModuleOptions
      advancedTestId="image-advanced"
      primary={
        <>
          {/* The sentence lives on the segment that means it — see the video
              panel's note: this panel opens inside a 537 px window now. The row
              is named for the destination so the options can be the verbs; both
              come from `config/vocabulary.ts` (round 3, F7). */}
          <GroupField label={KEEP_A_COPY_LABEL} id="image-download-mode">
            <Segmented
              id="image-download-mode"
              labelledBy="image-download-mode-label"
              value={cfg.downloadMode}
              options={[
                {
                  value: 'auto',
                  label: KEEP_A_COPY,
                  title:
                    'Fetch it once, then paint the copy — still there with the network unplugged.',
                },
                { value: 'stream-only', label: STREAM_ONLY, title: 'Never store anything.' },
              ]}
              onChange={(value) => {
                patch({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
              }}
            />
          </GroupField>
        </>
      }
      advanced={
        <>
          <FramingAdvanced idPrefix="image" value={cfg.render} onChange={patchRender} />

          <Field
            label={`Change pictures every ${String(cfg.slideshow.intervalSec)} s`}
            htmlFor="image-slideshow-interval"
            description="Ten seconds is the floor — every change is a whole new picture for CAM to capture."
          >
            <RangeInput
              id="image-slideshow-interval"
              value={cfg.slideshow.intervalSec}
              min={SLIDESHOW_MIN_INTERVAL_SEC}
              max={SLIDESHOW_MAX_INTERVAL_SEC}
              step={INTERVAL_STEP}
              onChange={(intervalSec) => {
                onChange({ ...cfg, slideshow: { ...cfg.slideshow, intervalSec } });
              }}
            />
          </Field>
        </>
      }
    />
  );
}

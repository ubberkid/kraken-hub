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
 * "Your pictures" stays exactly where it is. Merging the image store into the
 * Library is a real architectural change with storage-quota consequences, and
 * the audit reserved it for the user (§6).
 */

import { useEffect, useState } from 'react';

import { Disclosure, Field, GroupField, Panel, RangeInput, Segmented } from '../../ui';
import { FramingAdvanced } from '../../ui/Framing';

import { readImageIndex, type ImageSummary } from './imageStore';
import {
  SLIDESHOW_MAX_INTERVAL_SEC,
  SLIDESHOW_MIN_INTERVAL_SEC,
  localImageUrl,
  validateImageConfig,
  type ImageModuleConfig,
} from './schema';

import type { ModuleConfigProps } from '../types';

const INTERVAL_STEP = 5;
const BYTES_PER_KB = 1024;

function kb(bytes: number): string {
  return `${String(Math.round(bytes / BYTES_PER_KB))} kB`;
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateImageConfig(config);
  // Lazy initial value rather than a setState in the effect: the index is a
  // synchronous localStorage read, so there is nothing to wait for and a
  // cascading render buys nothing.
  const [library, setLibrary] = useState<ImageSummary[]>(readImageIndex);

  useEffect(() => {
    const onStorage = (): void => {
      setLibrary(readImageIndex());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const patch = (next: Partial<ImageModuleConfig>): void => {
    onChange({ ...cfg, ...next });
  };
  const patchRender = (next: Partial<ImageModuleConfig['render']>): void => {
    onChange({ ...cfg, render: { ...cfg.render, ...next } });
  };

  return (
    <>
      <Panel hint="The row under the halo is the picture link. Fit and slideshow are on the strip above.">
        {/* The sentence lives on the segment that means it — see the video
            panel's note: this panel opens inside a 537 px window now. */}
        <GroupField label="Keep a copy on this PC" id="image-download-mode">
          <Segmented
            id="image-download-mode"
            labelledBy="image-download-mode-label"
            value={cfg.downloadMode}
            options={[
              {
                value: 'auto',
                label: 'Keep a copy',
                title:
                  'Fetch it once, then paint the copy — still there with the network unplugged.',
              },
              { value: 'stream-only', label: 'Stream only', title: 'Never store anything.' },
            ]}
            onChange={(value) => {
              patch({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
            }}
          />
        </GroupField>

        {/*
          The picture store, inside this panel rather than in a second one.

          A `.kh-panel` of its own cost a heading, a lede and two sets of
          padding for what is a list — and the round-2 measurement is that the
          image options overflowed CAM's window by 260 px, more than any other
          module. It is a subhead and a shelf now. (Merging it into the Library
          proper is still the user's call — audit §6.)
        */}
        {library.length === 0 ? (
          /* Empty needs one line, not a heading over a paragraph saying the
             heading has nothing under it. */
          <p className="kh-hint">Your pictures — nothing kept yet.</p>
        ) : (
          <ul className="kh-list kh-list--shelf" aria-label="Your pictures">
            {library.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="kh-btn"
                  onClick={() => {
                    patch({ url: localImageUrl(row.id) });
                  }}
                >
                  {row.name} — {String(row.width)}×{String(row.height)}, {kb(row.size)}
                  {row.animated ? ' (animated)' : ''}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ONE door, one level — the same rule as every other module. */}
      <Disclosure summary="Advanced" testId="image-advanced">
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
      </Disclosure>
    </>
  );
}

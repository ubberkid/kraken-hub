/**
 * The image module's settings panel.
 *
 * Config-only code (invariant I8): `.tsx` under `src/modules/` is chunked into
 * `config-ui` and can never reach the display graph, so this file is free to
 * read the library index, use the UI kit and render React.
 */

import { useEffect, useState } from 'react';

import { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN } from '../../render/types';
import {
  Disclosure,
  Field,
  Notice,
  Panel,
  RangeInput,
  Row,
  Select,
  TextInput,
  Toggle,
} from '../../ui';

import { readImageIndex, type ImageSummary } from './imageStore';
import { primaryImageIssue, validateImageUrl } from './imageUrl';
import {
  SLIDESHOW_MAX_INTERVAL_SEC,
  SLIDESHOW_MIN_INTERVAL_SEC,
  localImageUrl,
  validateImageConfig,
  type ImageModuleConfig,
} from './schema';

import type { RenderSettings } from '../../state/schema';
import type { ModuleConfigProps } from '../types';

const FIT_OPTIONS: readonly { value: RenderSettings['fit']; label: string }[] = [
  { value: 'cover', label: 'Cover — fill the panel, crop the overflow' },
  { value: 'contain', label: 'Contain — whole picture, letterboxed' },
  { value: 'contain-circle', label: 'Contain (circle) — inscribed in the round bezel' },
  { value: 'fill', label: 'Fill — stretch to the panel' },
];

// Named individually: invariant 5's `no-magic-numbers` exempts `const`
// initialisers but not array elements, and 90/180/270 are the four quarter
// turns rather than anything device-shaped.
const QUARTER = 90;
const HALF_TURN = 180;
const THREE_QUARTER = 270;
const ROTATIONS: readonly RenderSettings['rotate'][] = [0, QUARTER, HALF_TURN, THREE_QUARTER];
const ROTATE_OPTIONS = ROTATIONS.map((r) => ({ value: String(r), label: `${String(r)}°` }));

const ZOOM_STEP = 0.05;
const PAN_STEP = 0.02;
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

  const check = validateImageUrl(cfg.url, {
    context: 'config',
    knownImageIds: library.map((i) => i.id),
  });
  const issue = primaryImageIssue(check);

  const patch = (next: Partial<ImageModuleConfig>): void => {
    onChange({ ...cfg, ...next });
  };
  const patchRender = (next: Partial<ImageModuleConfig['render']>): void => {
    onChange({ ...cfg, render: { ...cfg.render, ...next } });
  };

  return (
    <>
      <Panel
        title="Image"
        hint="Paste a direct link to a picture or a GIF. Your Kraken keeps a copy and paints that from then on, so it goes on working with the network unplugged."
      >
        <Field
          label="Picture link"
          htmlFor="image-url"
          description="A link to the file itself — right-click the picture and copy the image address, not the page address."
        >
          <TextInput
            id="image-url"
            value={cfg.url}
            placeholder="Paste a direct image link"
            onChange={(url) => {
              patch({ url });
            }}
          />
        </Field>
        {issue !== null && (
          <Notice tone={issue.severity === 'error' ? 'error' : 'warn'}>{issue.message}</Notice>
        )}

        <Field
          label="Keep a copy on this PC"
          htmlFor="image-download-mode"
          description="Keeping a copy means the picture is still there with the network unplugged. If the server refuses to hand over the bytes the display shows it straight from the link instead — quietly, and you still see the picture."
        >
          <Select
            id="image-download-mode"
            value={cfg.downloadMode}
            options={[
              { value: 'auto', label: 'Keep a copy (recommended)' },
              { value: 'stream-only', label: 'Never store anything' },
            ]}
            onChange={(value) => {
              patch({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
            }}
          />
        </Field>

        <Disclosure summary="Advanced" testId="image-advanced">
          <Field
            label="Background colour"
            htmlFor="image-background"
            description="What shows around a picture that does not fill the panel."
          >
            <TextInput
              id="image-background"
              value={cfg.background}
              placeholder="#000000"
              onChange={(background) => {
                patch({ background });
              }}
            />
          </Field>
        </Disclosure>
      </Panel>

      <Panel title="Framing" hint="How the picture sits in the panel.">
        <Field label="Fit" htmlFor="image-fit">
          <Select
            id="image-fit"
            value={cfg.render.fit}
            options={FIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(value) => {
              const found = FIT_OPTIONS.find((o) => o.value === value);
              if (found !== undefined) patchRender({ fit: found.value });
            }}
          />
        </Field>

        <Field label={`Zoom (${cfg.render.zoom.toFixed(2)}×)`} htmlFor="image-zoom">
          <RangeInput
            id="image-zoom"
            value={cfg.render.zoom}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onChange={(zoom) => {
              patchRender({ zoom });
            }}
          />
        </Field>

        <Disclosure summary="Advanced" testId="image-framing-advanced">
          <Row>
            <Field label="Pan X" htmlFor="image-pan-x">
              <RangeInput
                id="image-pan-x"
                value={cfg.render.offsetX}
                min={-PAN_LIMIT}
                max={PAN_LIMIT}
                step={PAN_STEP}
                onChange={(offsetX) => {
                  patchRender({ offsetX });
                }}
              />
            </Field>
            <Field label="Pan Y" htmlFor="image-pan-y">
              <RangeInput
                id="image-pan-y"
                value={cfg.render.offsetY}
                min={-PAN_LIMIT}
                max={PAN_LIMIT}
                step={PAN_STEP}
                onChange={(offsetY) => {
                  patchRender({ offsetY });
                }}
              />
            </Field>
          </Row>

          <Field label="Rotate" htmlFor="image-rotate">
            <Select
              id="image-rotate"
              value={String(cfg.render.rotate)}
              options={ROTATE_OPTIONS}
              onChange={(value) => {
                const rotate = ROTATIONS.find((r) => String(r) === value);
                if (rotate !== undefined) patchRender({ rotate });
              }}
            />
          </Field>
        </Disclosure>
      </Panel>

      <Panel
        title="Slideshow"
        hint="Cycles through every picture you have kept, newest first. Ten seconds is the floor: each change hands CAM a picture with nothing in common with the last one, which is the most expensive thing this can do."
      >
        <Field label="Cycle through pictures" htmlFor="image-slideshow">
          <Toggle
            id="image-slideshow"
            checked={cfg.slideshow.enabled}
            onChange={(enabled) => {
              onChange({ ...cfg, slideshow: { ...cfg.slideshow, enabled } });
            }}
          />
        </Field>
        <Field
          label={`Interval (${String(cfg.slideshow.intervalSec)} s)`}
          htmlFor="image-slideshow-interval"
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
      </Panel>

      <Panel
        title="Your pictures"
        hint="Everything your Kraken has kept. Stored on this PC inside CAM's own browser storage, so it survives a reboot with no network."
      >
        {library.length === 0 ? (
          <p className="kh-hint">
            Nothing here yet. Paste a link above with “keep a copy” on, and this fills in the moment
            the picture is fetched.
          </p>
        ) : (
          <ul className="kh-list">
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
    </>
  );
}

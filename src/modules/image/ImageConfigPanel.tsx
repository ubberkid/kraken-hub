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
 * "Your pictures" stays exactly where it is. Merging the image store into the
 * Library is a real architectural change with storage-quota consequences, and
 * the audit reserved it for the user (§6).
 */

import { useEffect, useState } from 'react';

import {
  Disclosure,
  Field,
  GroupField,
  Notice,
  Panel,
  RangeInput,
  Segmented,
  TextInput,
} from '../../ui';
import { FramingAdvanced, FramingPrimary } from '../../ui/Framing';

import { readImageIndex, type ImageSummary } from './imageStore';
import { primaryImageIssue, validateImageUrl } from './imageUrl';
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

        <GroupField
          label="Keep a copy on this PC"
          id="image-download-mode"
          description="A copy is still there with the network unplugged. If the server refuses to hand over the bytes, your Kraken shows the picture from the link instead — quietly."
        >
          <Segmented
            id="image-download-mode"
            labelledBy="image-download-mode-label"
            value={cfg.downloadMode}
            options={[
              { value: 'auto', label: 'Keep a copy', title: 'Fetch it once, then paint the copy.' },
              { value: 'stream-only', label: 'Stream only', title: 'Never store anything.' },
            ]}
            onChange={(value) => {
              patch({ downloadMode: value === 'stream-only' ? 'stream-only' : 'auto' });
            }}
          />
        </GroupField>
      </Panel>

      <Panel title="Framing" hint="How the picture sits in the panel.">
        <FramingPrimary idPrefix="image" value={cfg.render} onChange={patchRender} />
      </Panel>

      {/* ONE door, one level — the same rule as every other module. */}
      <Disclosure summary="Advanced" testId="image-advanced">
        <FramingAdvanced idPrefix="image" value={cfg.render} onChange={patchRender} />

        <GroupField
          label="Cycle through your pictures"
          id="image-slideshow"
          description="Ten seconds is the floor: each change hands CAM a picture with nothing in common with the last one, which is the most expensive thing this can do."
        >
          <Segmented
            id="image-slideshow"
            labelledBy="image-slideshow-label"
            value={cfg.slideshow.enabled ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(value) => {
              onChange({ ...cfg, slideshow: { ...cfg.slideshow, enabled: value === 'on' } });
            }}
          />
        </GroupField>

        <Field
          label={`Change every ${String(cfg.slideshow.intervalSec)} s`}
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
      </Disclosure>

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

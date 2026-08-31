import { useState } from 'react';

import { DEVICE_PRESETS, type DevicePresetId } from '../../../platform/devicePresets';
import { Field, Panel, Select } from '../../../ui';

/**
 * The simulator UX: a real `<iframe>` running the real display boot path
 * (`./?kraken=1&sim=…`) inside a bezel, not a lookalike React tree.
 *
 * An iframe is the point. It exercises geometry, the CSS variables, the mask
 * and the module mount exactly as the Kraken Browser will, and it shares this
 * page's localStorage — so an edit on the left previews live on the right with
 * production semantics, including the storage-event path itself.
 */
const FPS_CHOICES = ['1', '5', '15', '25', '40'] as const;

export function PreviewView() {
  const [preset, setPreset] = useState<DevicePresetId>('elite');
  const [fps, setFps] = useState<string>('40');
  const device = DEVICE_PRESETS[preset];
  const src = `./?kraken=1&sim=${preset}&fps=${fps}`;

  return (
    <>
      <Panel title="Preview" hint="A real display page, booted the way CAM boots it.">
        <Field label="Device" htmlFor="preview-device">
          <Select
            id="preview-device"
            value={preset}
            options={Object.values(DEVICE_PRESETS).map((p) => ({ value: p.id, label: p.label }))}
            onChange={(value) => {
              setPreset(value as DevicePresetId);
            }}
          />
        </Field>
        <Field
          label="Frame rate"
          htmlFor="preview-fps"
          description="Set 1 FPS to see exactly what a user who never touched the CAM slider sees."
        >
          <Select
            id="preview-fps"
            value={fps}
            options={FPS_CHOICES.map((f) => ({ value: f, label: `${f} FPS` }))}
            onChange={setFps}
          />
        </Field>
      </Panel>

      <div className={device.shape === 'circle' ? 'kh-bezel' : 'kh-bezel kh-bezel--square'}>
        <div
          className={
            device.shape === 'circle' ? 'kh-bezel__ring' : 'kh-bezel__ring kh-bezel__ring--square'
          }
        >
          <iframe
            key={src}
            title={`kraken-hub display preview — ${device.label}`}
            src={src}
            width={device.width}
            height={device.height}
          />
        </div>
      </div>
    </>
  );
}

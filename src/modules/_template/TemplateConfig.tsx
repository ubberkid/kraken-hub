import { Field, Panel, TextInput } from '../../ui';

import { validateTemplate } from './schema';

import type { ModuleConfigProps } from '../types';

/** STEP 3 — the React config panel. Config-only: never on the display path. */
export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateTemplate(config);
  return (
    <Panel title="Template" hint="Copy this directory to start a new module.">
      <Field label="Label" htmlFor="template-label">
        <TextInput
          id="template-label"
          value={cfg.label}
          onChange={(label) => {
            onChange({ ...cfg, label });
          }}
        />
      </Field>
    </Panel>
  );
}

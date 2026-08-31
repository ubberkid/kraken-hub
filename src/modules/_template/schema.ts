/** STEP 1 — describe your config, its defaults, and a validator that cannot throw. */

export interface TemplateConfig {
  label: string;
}

const MAX_LABEL_LEN = 64;

export const TEMPLATE_DEFAULTS: TemplateConfig = { label: 'Hello, Kraken' };

/**
 * MUST NOT throw. Coerce, clamp, drop unknown keys, fill from defaults — this
 * runs against whatever happens to be in localStorage, including a config
 * written by a future version of your module.
 */
export function validateTemplate(raw: unknown): TemplateConfig {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const label = o['label'];
  return {
    label:
      typeof label === 'string' && label.length <= MAX_LABEL_LEN ? label : TEMPLATE_DEFAULTS.label,
  };
}

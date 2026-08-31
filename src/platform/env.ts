/**
 * Process-wide identity and flags: the client id (stable per browser profile),
 * the build stamp, and the runtime role.
 *
 * `clientId` exists so that echo suppression works: the CAM Configuration
 * Browser and the hidden Kraken Browser share one localStorage, and a writer
 * must be able to recognise its own writes coming back at it.
 */

import { buildInfo, type BuildInfo } from '../buildInfo';
import { randomId } from '../lib/id';

import { readRaw, writeRaw } from './storage';

const INSTALL_KEY = 'install';

let cachedClientId: string | null = null;

/**
 * 12-char id, fresh on every page load — deliberately NOT persisted.
 *
 * CAM opens two Chromium browsers on the same origin, so they share one
 * localStorage. A profile-scoped id would therefore be IDENTICAL in the
 * configuration browser and on the LCD, and the display would mistake every
 * config write for its own echo and ignore it. Per-load is the only scope that
 * distinguishes the two writers.
 */
export function clientId(): string {
  cachedClientId ??= randomId(12);
  return cachedClientId;
}

/** Stable per browser profile. Diagnostics only — never used for echo suppression. */
export function installId(): string {
  const existing = readRaw(INSTALL_KEY);
  if (existing !== null && existing.length > 0) return existing;
  const fresh = randomId(12);
  writeRaw(INSTALL_KEY, fresh);
  return fresh;
}

export type Role = 'display' | 'config' | 'remote';

export interface Env {
  clientId: string;
  installId: string;
  build: BuildInfo;
  dev: boolean;
}

export function env(): Env {
  return {
    clientId: clientId(),
    installId: installId(),
    build: buildInfo(),
    dev: import.meta.env.DEV,
  };
}

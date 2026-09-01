import { useState } from 'react';

import { DEFAULT_MQTT_URL, DEFAULT_NTFY_BASE } from '../../../sync/endpoints';
import {
  Chip,
  Code,
  Disclosure,
  Field,
  GroupField,
  Notice,
  Panel,
  Row,
  Segmented,
  Switch,
  TextInput,
} from '../../../ui';

import type { AppState } from '../../../state/schema';
import type { ConfigRuntime } from '../runtime';
import type { SyncHandle } from '../useSync';

/**
 * Connection — the ONE place a room is configured, and nothing else.
 *
 * All of this used to live on the Remote page, two and three disclosures deep,
 * inside a "More controls" section that was a second complete copy of the app
 * (design audit, F6). None of it is a media control: a person driving a cooler
 * from the sofa never changes an MQTT endpoint, and a person who does is not
 * doing it on a phone. So it moved here.
 *
 * Round 2's R3 then took the engineering out of it. What this section shipped
 * as was three panels — *Connection*, *Hardware report*, *Connection detail* —
 * carrying a native `<select>` whose options were sentences, three bare browser
 * checkboxes, a paragraph containing `SHA-256(code)`, a row of six chips
 * reading `mqtt — online · local bus — idle · topic 2RTW…`, and a cross-network
 * diagnostics puller. Roughly 700 px of it, on a page that was 2,225 px tall.
 *
 * What is left is the four settings and their labels:
 *
 *  - **Route** — a segmented row, one word per option (R8).
 *  - **Use my own broker**, and the two endpoint fields it reveals.
 *  - **Your Kraken remembers remote changes** and **Your Kraken reports back to
 *    this page**, as the house `Switch`. Both are named for the object rather
 *    than for the system, which is why they read as sentences about a cooler
 *    and not as two more toggles. There is no native checkbox anywhere in this
 *    product now.
 *
 * The plumbing readout and the honest privacy note are both still here and both
 * still true — behind one disclosure each, which is where a thing that is
 * occasionally essential and usually noise belongs. The hardware-report pull
 * moved to the Report section, next to the rest of the diagnostics, because
 * that is the errand it belongs to.
 *
 * `sync` is a prop rather than a `useSync()` call of its own: the About page
 * mounts this beside the Report section, and two hooks would open two
 * connections to the same room.
 */
export function ConnectionSection({
  runtime,
  sync,
  now,
}: {
  runtime: ConfigRuntime;
  sync: SyncHandle;
  /** The page's 1 Hz clock, sampled outside render. `0` means "not yet". */
  now: number;
}) {
  const state = runtime.store.getSnapshot();
  const [showEndpoints, setShowEndpoints] = useState(false);

  const commit = (mutate: (s: AppState) => AppState): void => {
    runtime.store.commit(mutate);
  };

  const errorPacket = sync.lastError?.body ?? null;

  return (
    <Panel title="Connection" hint="How this PC and your phone reach each other.">
      {/*
        No description under it.

        "Automatic tries the fast route first and falls back if it cannot
        connect within five seconds" is a true sentence about a setting whose
        first option is the word **Automatic** and which nobody who is not
        already debugging a broker will ever touch. Two lines of the About
        page's height budget, spent explaining the default.
      */}
      <GroupField label="Route" id="room-transport">
        {/*
          `wrap`, because four options with a three-word one among them is
          364 px of row (round 5, S6).

          It was the last fixed-width row in the product: at 320 and 360 px the
          About page scrolled sideways, on a page whose entire purpose is being
          read when something has gone wrong. Every other four-or-more segment
          row in the app already wraps; this one did not, for no reason beyond
          nobody having opened About on a small phone.
        */}
        <Segmented
          id="room-transport"
          wrap
          labelledBy="room-transport-label"
          value={state.sync.transport === 'fake' ? 'auto' : state.sync.transport}
          options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'mqtt', label: 'MQTT' },
            { value: 'ntfy', label: 'ntfy' },
            { value: 'off', label: 'Same PC only' },
          ]}
          onChange={(raw) => {
            commit((s) => ({
              ...s,
              sync: { ...s.sync, transport: raw as AppState['sync']['transport'] },
            }));
          }}
        />
      </GroupField>

      <GroupField label="Use my own broker" id="room-endpoints">
        <Switch
          id="room-endpoints"
          labelledBy="room-endpoints-label"
          checked={showEndpoints}
          onChange={setShowEndpoints}
        />
      </GroupField>
      {showEndpoints && (
        <>
          <Field label="MQTT address" htmlFor="room-mqtt">
            <TextInput
              id="room-mqtt"
              settingUrl
              value={state.sync.mqttUrl}
              placeholder={DEFAULT_MQTT_URL}
              onChange={(mqttUrl) => {
                commit((s) => ({ ...s, sync: { ...s.sync, mqttUrl } }));
              }}
            />
          </Field>
          <Field label="ntfy address" htmlFor="room-ntfy">
            <TextInput
              id="room-ntfy"
              settingUrl
              value={state.sync.ntfyBase}
              placeholder={DEFAULT_NTFY_BASE}
              onChange={(ntfyBase) => {
                commit((s) => ({ ...s, sync: { ...s.sync, ntfyBase } }));
              }}
            />
          </Field>
        </>
      )}

      <GroupField label="Your Kraken remembers remote changes" id="room-persist">
        <Switch
          id="room-persist"
          labelledBy="room-persist-label"
          checked={state.sync.persistRemote}
          onChange={(persistRemote) => {
            commit((s) => ({ ...s, sync: { ...s.sync, persistRemote } }));
          }}
        />
      </GroupField>
      <GroupField label="Your Kraken reports back to this page" id="room-tele">
        <Switch
          id="room-tele"
          labelledBy="room-tele-label"
          checked={state.sync.publishTelemetry}
          onChange={(publishTelemetry) => {
            commit((s) => ({ ...s, sync: { ...s.sync, publishTelemetry } }));
          }}
        />
      </GroupField>

      {/*
        The plumbing, one tap down.

        Six chips of transport vocabulary on the page itself answered a question
        almost nobody was asking; the person who IS asking it knows to open a
        drawer called "Connection detail".
      */}
      <Disclosure summary="Connection detail" testId="connection-detail">
        <Row>
          <Chip tone={sync.status?.network === 'online' ? 'ok' : 'warn'} testId="connection-net">
            {sync.status === null
              ? 'not started'
              : `${sync.status.networkTransport ?? 'no transport'} — ${sync.status.network}`}
          </Chip>
          <Chip tone={sync.status?.local === 'online' ? 'ok' : 'neutral'}>
            local bus — {sync.status?.local ?? 'idle'}
          </Chip>
          {sync.status?.failedOver === true && (
            <Chip tone="warn">fallback transport — higher latency</Chip>
          )}
          <Chip tone={sync.lastTele === null ? 'neutral' : 'ok'}>
            {sync.lastTele === null
              ? 'nothing heard'
              : `heard ${String(Math.max(0, Math.round((now - sync.lastTele.at) / 1000)))}s ago`}
          </Chip>
          {sync.topicId !== null && <Chip tone="neutral">topic {sync.topicId}</Chip>}
        </Row>
        {sync.status?.lastError != null && <Notice tone="warn">{sync.status.lastError}</Notice>}
        {errorPacket !== null && (
          <Notice tone="error">
            {asText(errorPacket['code'], 'error')}: {asText(errorPacket['message'], '')}
          </Notice>
        )}
        {sync.status !== null && sync.status.decryptFailures >= 10 && (
          <Notice tone="error">
            No messages could be decrypted. The other side is almost certainly on a different room
            code.
          </Notice>
        )}
      </Disclosure>

      <Disclosure summary="What leaves your machine" testId="privacy-note">
        <p className="kh-hint">
          Only the room code stays private, and only because you never send it: the broker sees a
          topic derived from <Code inline>SHA-256(code)</Code>, and every payload is AES-GCM
          encrypted under a key derived from the same code, with a separate key per channel. What
          the broker can observe is that <em>some</em> topic exists, how big the messages are and
          how often they arrive. What it cannot read is the video link, the seek position, the clip
          names or any error text.
        </p>
        <p className="kh-hint">
          What your Kraken reports back is playback position, achieved frame rate, panel geometry,
          error codes, the names and durations of what is in your library, and a <em>hash</em> of
          the source link — never the link itself.
        </p>
      </Disclosure>
    </Panel>
  );
}

/** Telemetry values arrive as `unknown`; render them without stringifying an object. */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

# Remote control

Drive the LCD from your phone. No account, no server of ours, nothing to sign
up for — and the broker in the middle cannot read a single thing you send.

- [Pair a phone in about a minute](#pair-a-phone-in-about-a-minute)
- [What the remote can and cannot do](#what-the-remote-can-and-cannot-do)
- [Transports and failover](#transports-and-failover)
- [Privacy and threat model](#privacy-and-threat-model)
- [Running your own broker](#running-your-own-broker)
- [Troubleshooting](#troubleshooting)

---

## Pair a phone in about a minute

1. On the machine running CAM, open kraken-hub's configuration page (the one CAM
   opens for you, or the same URL in any browser) and go to **Remote**.
2. Press **Generate code**. You get eight characters, like `H4KM7Q2V`.
3. On your phone, either scan the QR code shown next to it, or open the same
   site and type the code into **Room code → Join**.
4. The status line turns green: `mqtt — online`. That is it — you are paired.

The QR encodes an ordinary link of the form
`https://<your-site>/#/remote?room=H4KM7Q2V`. It is generated **on your own
machine** (`src/app/config/qr.ts`), never fetched from a QR service, because the
link contains the room code and the room code is the only secret in this design.

The **Setup** page shows the same code, QR and link in a pairing card, so you do
not have to go looking for it.

### Rotating a code

**Rotate code** replaces it immediately. Anyone still holding the old code lands
on a different topic and simply sees nothing — there is nothing to revoke and no
list to update. Do this if you have ever shown the code on stream.

### Which surfaces exist

| Surface                    | How you get there             | Role      |
| -------------------------- | ----------------------------- | --------- |
| CAM Configuration Browser  | CAM opens it                  | `config`  |
| Any other browser or phone | the site URL, `#/remote`      | `remote`  |
| The LCD itself             | CAM opens it with `?kraken=1` | `display` |

The display **never publishes state**. It listens, it obeys, and it reports
telemetry. That one rule is what stops three surfaces from echoing changes at
each other forever.

---

## What the remote can and cannot do

**Can:** set the source URL (with the same validation the config page uses),
play and hold, seek, drag an A–B loop, change fit / zoom / rotation, switch
modules, pick from the clip library, watch live telemetry — position, achieved
frame rate, the last error — and **pull a hardware report off the machine
running CAM**, from any browser, without touching that machine.

**Cannot:**

- **Add files to the clip library.** CAM opens the configuration window and the
  LCD window in two Chromium browsers that share one storage profile; your
  phone is a third, separate profile. A file picker on the phone would upload
  into storage the display cannot see. Downloads and uploads happen in the CAM
  window, and the remote offers a one-click link to open kraken-hub there. What
  the remote _can_ do is choose from clips the display has already announced.
- **Change audio.** The volume and mute controls are present and disabled, with
  a tooltip explaining why: it is unverified whether the CAM webview reaches the
  speakers at all (hardware checklist **H08**), so the display forces mute until
  somebody measures it. A control that silently does nothing is worse than one
  that says why it is off.
- **Change the display's own trust settings.** A remote peer cannot repoint the
  display at a different broker, turn off its watchdog, or opt it into audio.
  Those fields are deliberately absent from the wire format
  (`syncBodyToPatch()` in `src/sync/appSync.ts`).

### Pulling a hardware report (Diagnostics card)

**Remote → Diagnostics → Request hardware report.**

This is the one control on the page that is about the machine rather than the
media. It sends a `requestDiag` command; the display probes itself for about
five seconds — panel geometry, DPR, Chromium version, target and achieved frame
rate, a three-second rAF sample, storage and codec support — and publishes the
result back as `tele` packets. The card renders a summary, a collapsed raw-JSON
block, a **Copy JSON** button and a link to the hardware-report issue form.

Three things about it are worth knowing:

- **The display does not need `?diag=1`.** That is the entire point. Nobody can
  edit the URL of a hidden Kraken Browser window from a different computer, so
  a diagnostics route that depends on a URL parameter is useless the moment the
  two machines are not the same machine. A display booted normally answers.
- **It answers even with telemetry switched off.** The `publishTelemetry`
  toggle governs the continuous stream a display volunteers. A report is a
  one-shot answer to a button somebody just pressed, and a button that silently
  does nothing is the failure mode this feature exists to remove.
- **It is chunked.** A full report does not fit in one 8 KB envelope, so it is
  serialised compactly (no whitespace, no null-valued keys) and split into
  numbered parts spaced 250 ms apart — above `SyncService`'s 5 Hz telemetry
  throttle, which drops rather than queues. The remote reassembles them and
  gives up after 20 seconds with _display did not answer — is it online and
  paired?_

The same-machine route (`#/diag` in CAM's own Configuration Browser, fed through
`localStorage`) is unchanged and remains the alternative when both windows are
on one computer. See [the hardware checklist](hardware-checklist.md).

### Commands versus state

Two different things travel on two different channels, on purpose:

- **`state`** is the _desired configuration_: a full snapshot, retained, and
  idempotent. A display that cold-boots with nothing but one of these messages
  must be completely correct — which is why state is never sent as a delta.
- **`cmd`** is _imperative_: `seekBy(+10)`, `reload`, `ping`. These are not
  idempotent, are never retained, and are dropped on arrival if they are more
  than 15 seconds old. That single rule is what makes it safe to subscribe to a
  transport with a 12-hour replay cache.

Position never travels as a bare number. It is always `posSec` plus `posAtTs`
(when it was sampled), and the receiver re-anchors, clamping the extrapolation
to 30 seconds. Two machines do not share a clock, and a display can sleep for
hours; without the clamp, both produce a seek to a position that never existed.

### Where the position on your phone comes from

Three paths, and it is worth knowing which is which, because they fail
differently.

1. **The moving seek bar is telemetry.** The display publishes a stats packet
   twice a second at most, and only every two seconds in practice. Each one
   carries `currentTime` and the moment it was sampled, so the phone re-anchors
   it against its own clock four times a second and the bar moves smoothly
   between packets. Nothing is being sent in between — the phone is
   extrapolating, and it stops extrapolating (falling back to the raw sample) as
   soon as the two clocks disagree by more than five minutes.
2. **Dragging the bar sends a command _and_ a state write.** The `cmd` does the
   seek immediately; the `playback` block in the retained snapshot is what a
   display that boots ten seconds later reads. The display applies a given
   `posAtTs` exactly once, so the retained copy being re-delivered on every
   reconnect and every five-minute keepalive does not drag playback backwards.
3. **A display that reboots alone resumes by itself.** With no phone and no
   network, the display still restores its position, from a checkpoint it writes
   for itself into `kraken-hub:v1:video:positionCheckpoint` every ten seconds and
   on page teardown. It is keyed by source — a clip id, or a hash of the URL, so
   no raw URL is stored — and it only ever resumes the **same** source. It stands
   down for a live stream, and for an A-B loop, where the loop's own start is the
   resume point you asked for. This never leaves the machine.

---

## Transports and failover

There are two independent slots.

**The local slot** always runs, needs no room code, and never touches the
network. It is how the CAM Configuration Browser and the hidden Kraken Browser
talk: they share an origin, so `localStorage` plus the `storage` event is the
sanctioned channel (plus an unconditional 1-second poll). The event is reliable
on CAM 4.76.5 — **H14**, confirmed, see the
[known results](hardware-checklist.md#known-results) — and the poll stays anyway,
because other CAM versions are unmeasured and it costs nothing.

**The network slot** holds at most one transport:

|            | MQTT                                       | ntfy                               |
| ---------- | ------------------------------------------ | ---------------------------------- |
| Endpoint   | `wss://broker.emqx.io:8084/mqtt`           | `https://ntfy.sh`                  |
| Shape      | WebSocket, port 8084                       | HTTPS POST + Server-Sent Events    |
| Last value | true retained messages                     | none; a 12-hour replay cache       |
| Latency    | low                                        | higher                             |
| Topics     | `kraken-hub/v1/<topicId>/{state,cmd,tele}` | one flat `kraken-hub-v1-<topicId>` |

They were chosen to fail **differently**. A firewall or captive portal that
kills a WebSocket on a non-standard port usually leaves ordinary HTTPS alone, so
the fallback is a genuinely independent path rather than a second roll of the
same dice.

**The ladder.** With `Transport: Auto`, kraken-hub tries MQTT first. On a
connection error, or a **5-second** timeout, it moves to ntfy and the remote
shows _fallback transport — higher latency_. If a live transport later drops,
the ladder re-runs from its current rung after a jittered backoff
(`1s, 2s, 4s, 8s, 15s, 30s, 60s`). If both are unreachable the status reads
_offline_ — and the display keeps playing from its persisted state, because it
never depends on sync to function.

**Retention, and how ntfy fakes it.** MQTT stores the last `state` message as a
retained message; a cold display gets it as part of the connect handshake. ntfy
stores nothing, so the state owner re-publishes every four minutes and a fresh
subscriber recovers by polling `/json?poll=1&since=10m` and taking the **last**
`state` message it finds. Commands are never replayed from that cache.

Two MQTT details are consequences of live measurement rather than taste, and
both are commented at length in `src/sync/transports/MqttTransport.ts`:
publishing a retained message and closing quickly **silently loses it**, so
`connect()` resolves only after CONNACK _and_ SUBACK and every publish awaits
the broker's acknowledgement; and the last will is set on the `tele` channel
**only**, because a will on `state` would publish a tombstone over the retained
snapshot the instant a display dropped off the network — deleting the exact
message a reloading display cold-starts from.

---

## Privacy and threat model

### What is actually sent

The room code never leaves your devices. Everything derived from it does:

```
topicId = crockford32( SHA-256(code)[0..10] )                    # 80 bits
key(ch) = HKDF-SHA256( ikm = code,
                       salt = "kraken-hub/v1",
                       info = "kraken-hub/v1/aes-256-gcm/<ch>" ) # one key per channel
frame   = 0x01 || iv[12] || AES-256-GCM( payload )               # fresh IV per message
                                          AAD = "<topicId>|<channel>"
```

The additional authenticated data binds a ciphertext to the channel it was sent
on, so a captured `state` frame cannot be replayed onto `cmd`.

### What the broker can see

- That a topic with a particular 16-character name exists.
- How large the messages are and how often they arrive.
- Nothing else. Not the video URL, not the seek position, not the clip names,
  not the error text.

### What the broker cannot do

Forge a message. Every frame is authenticated; a tampered one fails to open and
is counted, not acted on. Ten decryption failures inside 30 seconds raises _no
messages could be decrypted — check the room code_ rather than half-working in
silence.

### The honest limitation

**Eight Crockford characters is 40 bits.** Under a single HKDF pass that is a
convenience secret, not a cryptographic one: an attacker who has _already found
your topic_ could brute-force the code offline. Three things make that a poor
use of anyone's time, and you should judge them for yourself:

1. The topic is itself derived from the code and is 80 bits — it cannot be
   guessed, and there is no directory of topics to enumerate.
2. The contents are low-value: a media URL and a playback position.
3. Codes are trivial to rotate, and rotating one invalidates everything.

If that trade is not acceptable for you, run your own broker (below) and the
public-broker exposure disappears entirely.

### What telemetry contains

Playback position and duration, achieved and target frame rate, panel geometry
and DPR, error codes and messages, the names / durations / sizes of stored clips
(capped at 40 entries, no thumbnails), download progress, and a **hash** of the
source URL — the first eight hex characters of SHA-256, never the URL itself.
Telemetry can be switched off entirely in **Room settings**.

One payload is not part of that stream: a hardware report, sent only in answer
to **Request hardware report** and therefore unaffected by the toggle. It is the
same `DiagReport` `#/diag` shows you, and it contains no media URL, no room code
and no file contents — panel geometry, browser and codec support, frame timings,
storage counters, and the last sixteen lines of the in-page log ring.

### Where the room code is stored

In plaintext, in the browser profile, inside the normal `kraken-hub:v1:state`
document. This is deliberate and it is not a hash-versus-plaintext oversight:
the code **is** the key material, so a display that reboots has to be able to
read it back to derive the AES key. Storing only a hash would make the display
unable to decrypt anything, and a "wrapped" copy would just move the wrapping
key into the same localStorage.

One code is never persisted: a code that arrives as `?room=` **on the display
page** is applied to the running state and never written to disk, so a shared
link cannot silently repoint somebody's LCD forever.

---

## Running your own broker

Both endpoints are user-overridable — **Remote → Room settings → Use my own
broker** — and both defaults live in exactly one file, `src/sync/endpoints.ts`,
so a fork can change them once.

- **MQTT**: any broker with a WebSocket listener works. Mosquitto with
  `listener 8084` / `protocol websockets` and a TLS certificate is enough. The
  URL must be `wss://` (or `ws://` for a plain-HTTP page); `https://` pages
  cannot open an insecure WebSocket, so an `ws://` override on a deployed site
  is blocked as mixed content by the browser, not by us.
- **ntfy**: any [ntfy](https://ntfy.sh/docs/install/) instance. The transport
  uses only `POST /<topic>`, `GET /<topic>/sse` and
  `GET /<topic>/json?poll=1&since=10m`, with `Content-Type: text/plain` and no
  custom headers — deliberately a CORS _simple request_, so there is no
  preflight to configure.

An empty field means "this build's default", so a fork that changes the default
does not have to migrate anybody's saved settings.

Payloads are encrypted either way. Self-hosting removes the metadata exposure
(that a topic exists, and its message sizes), not the confidentiality — that was
never with the broker in the first place.

---

## Troubleshooting

**`fallback transport — higher latency`** — MQTT could not be reached, so ntfy
took the slot. Usually a firewall blocking port 8084. Everything still works;
expect a second or so more latency.

**`offline`** — neither transport connected. The display keeps playing whatever
it was already playing; use the CAM configuration window until the network
returns.

**"No messages could be decrypted"** — the two ends are on different room codes.
Re-scan the QR, or retype the code. Note that `I`/`L` become `1` and `O` becomes
`0` automatically, so those are not the problem.

**The remote connects but the display never reacts** — check that the display
page is actually in a room: open it with `?kraken=1&diag=1` and look at the
`data-kh-sync` attribute on `<html>`, which reports the transport, the last
applied revision and whether it arrived retained.

**Request hardware report says the display did not answer** — the display is on
a different room code, is not running, or CAM has not reloaded the integration
since this build was deployed. CAM caches the page: a display already running an
older build has no `requestDiag` handler, and it will ignore the request in
silence until CAM restarts or the integration is reloaded.

**Nothing in the clip list** — the display publishes its clip index on connect
and every five minutes. If it is empty, the library is empty; add clips from the
CAM window.

---

## Testing this yourself

```bash
npm run test:e2e     # the fake-transport suite, including cold retained restore
npm run test:live    # opt-in: one real EMQX round trip + one real ntfy replay
```

The e2e suite drives a real remote page against a real display page through the
in-repo broker simulator (`?transport=fake`), including the case that matters
most: deleting the persisted state document entirely and proving the display
recovers from the retained snapshot alone.

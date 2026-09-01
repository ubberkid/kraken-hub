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
   opens for you, or the same URL in any browser) and follow **Remote** in the
   row under the halo. In CAM this page is **pairing**, not a remote control:
   a window is not a remote for the machine it runs on, and everything a remote
   offers — a mirror of the panel, a transport, the library — is already on the
   home screen in a truer form, one click away.
2. Press **Create a code**. You get eight characters, like `H4KM7Q2V`, and the
   card becomes the thing you came for: **Scan with your phone**, the QR at the
   size a camera resolves, the room underneath it, and **Rotate code** and
   **Copy the link** beside it.
3. Point your phone's camera at the QR. **That is the whole step** — the phone
   opens the remote and joins before the card first paints. Nothing to type, no
   Join button, no account.
4. On the phone, the line under the transport reads _Linked to your Kraken_. You
   are paired, and you stay paired: a bookmark to that page reconnects on its
   own.

On a phone or a second browser — any window that really is remote from the
Kraken — the same route is the remote control, and its pairing card collapses to
one line (_Paired with your PC_ and the room) with the square one tap down under
**Pairing options**. Pairing a second device is a pairing option there, because
the card's whole message once you are paired is that one line.

The QR encodes an ordinary link of the form
`https://<your-site>/#/remote?room=H4KM7Q2V`. The code rides in the **fragment**,
which browsers strip before the request leaves the machine, so it never reaches
an origin server, a CDN, a proxy, a `Referer` header or an analytics beacon. The
QR is generated **on your own machine** (`src/app/config/qr.ts`), never fetched
from a QR service, because the room code is the only secret in this design.

It is drawn as dark modules on a white tile — the rest of the app is dark, and
an inverted code is one a phone camera will not offer to open. On the **remote**
surface it appears only above 700 px: there the pairing card is already the
remote, so a QR would be the page offering you a scan of itself. On CAM's
**pairing** surface it is always shown, at any window width, because it is the
entire reason that page exists.

If the camera route is not available — a desktop second browser, a locked-down
phone — the same card has a **Type a code instead** disclosure holding a
**Room code → Join** field. Typing is the fallback, so it sits behind a door
rather than competing with the thing that works.

The field defends the one thing typing can get wrong. `filterRoomCodeInput`
applies, on every keystroke, exactly the folding the code itself is normalised
with: it uppercases, drops separators, folds `I` and `L` to `1` and `O` to `0`,
removes `U` — which Crockford excludes and which has no lookalike to fold into —
and stops at eight characters, because a ninth can only ever be a mistake. It is
deliberately not a validator; it never rejects, it only declines to store a
character that could not have been meant.

Judgement happens on **Join**, and it happens visibly: a code that is still not
eight usable characters sets `aria-invalid` on the input and renders an inline
error carrying the same sentence as the field's own hint (`ROOM_CODE_HINT`).
This used to submit silently — `normalizeRoomCode` returned `null`, the handler
returned, and the card sat there looking exactly as it had a moment earlier,
which is a button that does nothing (round 5, S5).

### Unpairing

**Unpair**, on the pairing card itself, clears every place a room hides on that
device: the remembered code, the shared state
document, and the code still sitting in the page's own fragment from the link
that opened it.

### Rotating a code

**Rotate code** — beside the QR and the copyable link on CAM's pairing surface,
and under **Pairing options** on a remote — replaces it immediately. Anyone still holding the old code lands
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

**Can:** play and hold, seek, drag an A–B loop, set the source URL (with the same
validation the config page uses), switch modules, change how the picture is
framed, choose a quality, and watch live telemetry — position, achieved frame
rate, the last error.

The remote's surface is a **media remote**, not a settings mirror: a mini-halo, a
title, the scrubber with its two loop handles, three transport buttons, **four
compact essentials** and one pairing card. The four are the source field, the
module picker, Fit and Quality — and they are on the page, not behind a door, as
segmented rows rather than dropdowns.

**The link field is contextual, and it has to be.** It writes to whichever module
is actually on screen, so it says what that module takes: with **Video** active
the placeholder reads _Paste a video link — YouTube, MP4, HLS…_ and the button
says **Play**; with **Image** active it reads _Paste a picture link — JPG, PNG,
WebP, GIF…_ and the button says **Show**. On a narrow screen both drop their
list of examples and read simply _Paste a video link_ / _Paste a picture link_,
because a placeholder that does not fit is not a hint. Under **Clock** or
**Stats** there is no link to paste at all, so the field collapses to a quiet
**Play something** button that switches to Video and puts the cursor in the
field.

The mapping is one function — `pasteAction` in `src/app/config/pasteLink.ts` —
and it is shared with the home screen's paste row. That sharing is the point.
The remote not having it was a defect rather than missing polish: the field was
hardcoded to the video module while the picker one row below it could perfectly
well be on **Image**, so a picture link pasted there was validated as a video
source, written into the _video_ config, answered with a success receipt, and
changed nothing on the panel (round 5, S1).

**None of it mounts until a room is live.** An unpaired remote is the ring, one
sentence and **Create a code** — with _Type a code instead_ behind a quiet
disclosure and nothing else at all. A scrubber reading `0:00 / 60:00` for a
duration nobody had reported, three greyed-out transport buttons and two status
lines both saying "waiting" is not a remote; it is a screenshot of one.

**Where a duration is genuinely unknown, the scrubber withdraws.** It used to
show no total and keep everything else, which left the invented hour running the
controls: the seek input's `max` was 3600, so a tap two thirds along the bar
reported a playhead at forty minutes, and dragging **B** persisted `loop.end =
2177` for a video nobody had measured. The rail is decorative in that state —
no seek input, no loop band, the two handles parked and disabled — with one line
saying what unlocks them: _Loop points unlock when your Kraken reports the
length_. Nothing is written from a scale nobody reported
(`src/app/config/loopPoints.ts`). The seek gates on the same freshness the
transport buttons do, because it is the same question about the same panel.

There used to be a `More controls` disclosure holding a second complete copy of
the app: fourteen controls duplicating the configuration page in different words,
a clip picker, the room settings and a nested privacy note, on a 390 px screen.
It is gone. **Room settings, the transport internals and the hardware-report pull
now live in exactly one place** — the `Connection` and `Report` sections of the
merged About page, which the remote reaches by the single quiet **About** link
at the bottom of the page (once it is paired), and which the configuration page
reaches by clicking the version line in its footer. The link is named after the
page it opens rather than after the two things on it: _Connection &
diagnostics_ named a Diagnostics page that has not existed since round 1, and a
link whose words do not match where it lands teaches the reader not to trust the
next one.

The one thing the remote deliberately does not do is nudge, zoom or rotate the
picture — that is setup, not remote control, and it lives under the module's own
options on the home screen.

## The library, from the sofa

The shelf on the remote is **the** shelf. It is not a copy and it is not a
picker: the display publishes its library on the telemetry channel, the remote
draws it with the same tile builder CAM's own Library page uses, and pressing a
tile is the ordinary state commit — the same one CAM makes — so playing something
from a phone invents no new machinery at all.

Tile art on the phone is the **treated card**: a deterministic function of the
name, so most tiles are pixel-identical to CAM's for zero bytes on the wire. A
source with a public poster (YouTube) is fetched by the phone itself. Nothing is
ever streamed or chunked over the radio to draw a shelf.

### Curating

**Pin**, **Rename** and **Delete** are on every tile, on every surface. The
remote cannot reach the bytes, so it does not try: it sends a command, the
display applies it to the one library and immediately re-announces the shelf.

Three properties are load-bearing, and all three are in
`src/lib/curation.ts`:

- **Absolute, never a toggle.** `setPinned` carries the value it wants. The
  command channel is redelivered by a replaying transport, and "flip it" applied
  twice is a bug that looks exactly like somebody changing their mind.
- **Batched by id.** Commands are throttled per operation at 200 ms and the
  extras are **dropped**, not queued — so a five-item delete loop would delete
  one thing. Press **Select**, choose what you mean, and one command carries
  every id.
- **Idempotent by id.** Applying a delete twice is applying it once. That is what
  makes it safe for this channel to have no acknowledgement.

Deleting asks once, in a confirm, on **both** shelves. The remote had one first,
because the screen it affects is in another room; CAM deleted on the press, on
the argument that there the row, the finger and the shelf that redraws from the
database are all in one place. That argument was about the shelf and not about
the act — there is no undo anywhere in the product and the bytes go from the one
database the LCD can read — so both windows mount the same sheet now.

The remote removes the tile **optimistically** and then reconciles against the
next library packet. If the Kraken turns out to still have the row — it was
asleep, the command was lost — the tile comes back and the shelf says
_"Your Kraken did not change …"_. Nothing is silently pretended.

## Add from your phone

The **Add** button above the shelf offers two things.

**Paste a link** commits the URL as the source, exactly as the home screen's
paste row does; your Kraken fetches it and keeps a copy. The field is the field
for **whatever is on the panel**: with Image showing it asks for a picture link
and hands it to the picture module, and with Clock or Stats showing — neither of
which has anything to be handed — it steps aside for a quiet _Play something_
instead. Every link field in the product reads that one mapping.

The receipt says what is true of your room. Paired to a Kraken that has been
heard from, it is _"Sent to your Kraken… a tile appears here shortly"_; paired to
one that has not said anything yet, it is _"Saved to the library — your Kraken
picks it up when it connects"_, because the tile is not on its way until
something is listening.

**Send a file** hands the Kraken a photo or a video **straight from the phone**,
peer to peer over your network. This is the one genuinely device-local thing left
in the product: the bytes have to land in the browser profile the LCD page can
read, and a phone shares nothing with it.

How it works, and what it costs:

- **WebRTC, with a data channel.** The offer, the answer and the ICE candidates
  ride the ordinary encrypted sync channel — there is no signalling server and
  there will not be one, so the broker only ever sees ciphertext and only a peer
  holding the room code can start a transfer.
- **The display is the receiver**, because the display is the window that owns
  the store. The assembled file goes through the **same ingest pipeline** a file
  dropped on CAM's own Library page takes: the same probe, the same thumbnail,
  the same quota check, the same rejection messages. There is no second way for a
  byte to become a row.
- **The quota is checked before a byte moves.** The offer carries the size; a
  library with no room for it is a refusal in one round trip rather than a
  progress bar that fails at the end. The cap is 500 MB.
- **One STUN server, no TURN relay.** A relay means somebody's server carrying
  somebody's video, which this project is not going to run and cannot honestly
  promise. So this works when **your phone and your PC are on the same network**,
  which is the case it is for — and that sentence is what the app says, once,
  after a transfer has genuinely failed or timed out. It is deliberately not a
  warning shown up front.

Cancel is available throughout, on both ends, and a transfer that is interrupted
leaves nothing behind: a row is written only when the whole file has arrived.

### The ring is a live replica, not a picture of one

The mini-halo at the top runs the display's **actual module renderer** — the same
code the LCD runs — driven by synced state. The clock ring is the clock module.
The stats ring is the stats module, showing your real CPU and GPU temperatures.

It is **not** an iframe and **not** a video stream, and that is a deliberate
design decision rather than a shortcut. The CAM configuration window can put the
real display page in its halo because it shares CAM's origin and storage; a phone
is a different browser on a different machine, so an iframe there would boot a
_second_ display — a second decoder, a second download, on a battery — showing
what the phone thinks rather than what the cooler shows.

So the display volunteers only the two things a replica cannot work out for
itself:

| What                     | Why it has to travel                                                                             | Cost                    |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------- |
| Five monitoring readings | CPU / GPU temperature and load and the liquid temperature exist only on the machine running CAM. | ~60 bytes, every 2.5 s  |
| A ≤6 KB WebP thumbnail   | A stored clip or a library image lives in CAM's browser profile, which the phone can never read. | Sent **once** per image |

Everything else is computed on the phone. Local time is the clearest example: a
clock replica is correct by definition, because the phone has its own clock.

Three consequences worth knowing:

- **The thumbnail is sent once.** It is keyed by content hash and cached on the
  phone, so an unchanged picture never crosses the wire again. It travels in
  numbered chunks over the same telemetry channel the hardware report uses.
- **YouTube's still is fetched by the phone.** The poster is a public
  `i.ytimg.com` URL, so asking the display to grab, re-encode and transmit a
  frame it already has a link for would be silly.
- **The ring runs at 1 Hz and stops completely when the page is hidden.** No
  timer, no repaint, no packets acted on. A remote left open in a background tab
  costs a phone nothing.

The video ring is the one that cannot be a replica — pixels are the thing this
design refuses to stream — so it shows the still plus a **position arc**, drawn
from the same re-anchored telemetry as the scrubber. The arc advances smoothly
between packets rather than stepping twice a second, because the position is
extrapolated locally from `posSec + posAtTs`.

### Quality

**Quality**, on the remote page itself. The same control as the CAM panel, with the same
words, because it is the same code (`src/modules/video/quality.ts`). It always
shows what the display is actually getting; whether it offers a _choice_ depends
entirely on the provider, and it says which case you are in:

- a **picker** of the exact renditions the display reported, for HLS, DASH,
  Twitch and the resolver companion;
- a **bias** (Auto / 720 / 1080 / 1440) for YouTube, with one honest line —
  _"YouTube chooses; kraken-hub nudges it by resizing the hidden player"_ —
  because there is no cross-origin quality API and the measured player width is
  the only lever that exists;
- a **read-only reading** for a stored clip or a direct file, which have exactly
  one resolution.

A quality choice is a **setting**, not a command: it travels as ordinary module
config in the retained state snapshot, so it survives a display reboot the same
way an A–B loop does. The full per-provider table is in
[providers.md](providers.md#what-the-quality-control-does-per-provider).

**Cannot:**

- **Ingest a file into the phone's _own_ browser storage.** CAM opens the
  configuration window and the LCD window in two Chromium browsers that share
  one storage profile; your phone is a third, separate profile, and nothing the
  phone writes to its own IndexedDB will ever be a row the display can read.
  That is the whole of the limitation, and it is a fact about how browsers
  partition storage rather than a decision. **The file still reaches the
  library**: the phone hands the bytes to the display peer to peer over your
  network, and the display runs the ordinary ingest pipeline on them — see
  [Add from your phone](#add-from-your-phone). What that costs is a network
  requirement rather than a missing feature: one STUN server and no TURN relay,
  so the phone and the PC have to be on the same network. The app says that
  sentence — _"Your phone and PC need to be on the same network."_ — only after
  a transfer has genuinely failed or timed out, and never as a warning up front.
- **Change audio.** There is no volume or mute control on the remote at all. It
  is unverified whether the CAM webview reaches the speakers (hardware checklist
  **H08**), so the display forces mute until somebody measures it — and a
  control that could only ever be disabled is worse than no control.
- **Change the display's own trust settings.** A remote peer cannot repoint the
  display at a different broker, turn off its watchdog, or opt it into audio.
  Those fields are deliberately absent from the wire format
  (`syncBodyToPatch()` in `src/sync/appSync.ts`).

### Pulling a hardware report

**About → Report → Show the technical detail → Ask your Kraken.**

This is the one control on the page that is about the machine rather than the
media. It sends a `requestDiag` command; the display probes itself for about
five seconds — panel geometry, DPR, Chromium version, target and achieved frame
rate, a three-second rAF sample, storage and codec support — and publishes the
result back as `tele` packets. The drawer renders a short summary and a
collapsed raw-JSON block; the **Copy report** button at the top of the Report
section puts both halves — this browser's probes and your Kraken's — on the
clipboard, and **Send it in** opens the hardware-report issue form.

Three things about it are worth knowing:

- **The display does not need `?diag=1`.** That is the entire point. Nobody can
  edit the URL of a hidden Kraken Browser window from a different computer, so
  a diagnostics route that depends on a URL parameter is useless the moment the
  two machines are not the same machine. A display booted normally answers.
- **It answers even with telemetry switched off.** The `publishTelemetry`
  toggle governs the continuous stream a display volunteers. A report is a
  one-shot answer to a button somebody just pressed, and a button that silently
  does nothing is the failure mode this feature exists to remove.
- **It is chunked, and it jumps the telemetry throttle.** A full report does not
  fit in one 8 KB envelope, so it is serialised compactly (no whitespace, no
  null-valued keys) and split into numbered parts spaced 250 ms apart. Every
  part is published with `immediate`, which is the one thing that bypasses
  `SyncService`'s 5 Hz telemetry throttle: that throttle drops rather than
  queues, so a routine `videoStats` packet landing 180 ms before the answer used
  to eat it and the button did nothing for twenty seconds. The requester
  reassembles the parts and gives up after 20 s.

The pull lives on the merged About page — `#/about`, which `#/diag` still
resolves to — inside **Report → Show the technical detail**. Any paired browser
can press it, including the phone: follow the **About** link at the bottom of
the remote.

The same-machine route (the display report the configuration browser reads back
through `localStorage`, on the same page) is unchanged and remains the
alternative when both windows are on one computer. See
[the hardware checklist](hardware-checklist.md).

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
connection error, or a **5-second** timeout, it moves to ntfy and the remote's
status line appends _"· on the backup link, so it is a little slower"_. If a
live transport later drops, the ladder re-runs from its current rung after a
jittered backoff (`1s, 2s, 4s, 8s, 15s, 30s, 60s`). If both are unreachable the
remote reads _"Looking for your Kraken…"_ — and the display keeps playing from
its persisted state, because it never depends on sync to function. The machine
words (`fallback transport — higher latency`, `offline`) are the About page's
**Connection detail** chips, not anything the remote says.

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
  not the error text — and not the WebRTC offer or the ICE candidates a file
  transfer signals with, which are sealed like everything else. The file itself
  never touches the broker at all: it goes directly between the two devices.

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
and DPR, error codes and messages, the names / sizes / kinds — and, for a clip,
the duration — of the things in your library (capped at 40 entries **across
both kinds**, newest first, no thumbnails), download progress, and a **hash** of the
source URL — the first eight hex characters of SHA-256, never the URL itself.

The live ring adds two things to that list, and both are worth naming
explicitly because they are new kinds of data rather than more of the same:

- **Five monitoring readings** — CPU and GPU temperature and load, and the
  liquid temperature. These are facts about your hardware. They are the same
  numbers the stats module puts on the LCD.
- **A ≤6 KB thumbnail of the current image or clip**, sent once per distinct
  picture. This is the only telemetry that contains _content_ rather than
  metadata, and it is encrypted under the room key like everything else.

Telemetry — including both of those — can be switched off entirely under
**About → Connection → "Your Kraken reports back to this page"**, which is
exactly what that switch means.

One payload is not part of that stream: a hardware report, sent only in answer
to **Ask your Kraken** and therefore unaffected by the toggle. It is the same
`DiagReport` the About page shows you, and it contains no media URL, no room code
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

Both endpoints are user-overridable — the footer's version line → **Connection →
Use my own broker** — and both defaults live in exactly one file,
`src/sync/endpoints.ts`,
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

**`fallback transport — higher latency`** (About → Connection → _Connection
detail_; on the remote, _"on the backup link, so it is a little slower"_) — MQTT
could not be reached, so ntfy took the slot. Usually a firewall blocking port 8084. Everything still works; expect a second or so more latency.

**`offline`** (About → Connection → _Connection detail_; on the remote,
_"Looking for your Kraken…"_) — neither transport connected. The display keeps
playing whatever it was already playing; use the CAM configuration window until
the network returns.

**"No messages could be decrypted"** — the two ends are on different room codes.
Re-scan the QR, or retype the code. Note that `I`/`L` become `1` and `O` becomes
`0` automatically, so those are not the problem.

**The remote connects but the display never reacts** — check that the display
page is actually in a room: open it with `?kraken=1&diag=1` and look at the
`data-kh-sync` attribute on `<html>`, which reports the transport, the last
applied revision and whether it arrived retained.

**Ask your Kraken says it did not answer** — the display is on
a different room code, is not running, or CAM has not reloaded the integration
since this build was deployed. CAM caches the page: a display already running an
older build has no `requestDiag` handler, and it will ignore the request in
silence until CAM restarts or the integration is reloaded.

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

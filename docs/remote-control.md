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

That line waits for evidence. _Paired with your PC_ is a claim about the other
end of the room, and a device knows nothing about the other end merely by
holding a code — so until something the display has published reaches it, the
card reads **Your pairing code** instead, over the same room, the same
**Unpair** and the same **Pairing options** (round 8). The status line above it
is what reports the wait; this line reports what the device has.

### If the phone made the code first

**Create a code** exists on the phone too, and a code minted there is a room CAM
has never been told about. There is no camera on that side of the pair: CAM
cannot scan, and kraken-hub ships no QR decoder on any surface — the scanning in
step 3 above is your phone's own camera app opening a link. So the one way a
phone's code reaches CAM is by hand, and the card says so, naming the controls
that exist: on the PC, open **Remote** and use **Type a code instead**.

The phone's unpaired card leads with the route its hardware actually has — the
code comes from CAM, point the camera at the square — and offers **Create a
code** as the fallback for a reader with no square in front of them. It used to
read _"Create a code here, then scan it from the CAM window on your PC —
nothing to type"_, which asked the one device that can scan to be scanned by the
one that cannot, and ruled out the only route that works.

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

| Surface                   | How you get there             | Role      | What it shows                   |
| ------------------------- | ----------------------------- | --------- | ------------------------------- |
| CAM Configuration Browser | CAM opens it                  | `config`  | Everything                      |
| A desktop browser         | the site URL                  | `remote`  | Everything, minus adding files  |
| A phone                   | the site URL, any address     | `remote`  | The remote, and only the remote |
| The LCD itself            | CAM opens it with `?kraken=1` | `display` | The panel                       |

### A phone is a remote, on every address

Type the site URL on a phone — with no `#/remote`, or with `#/library`, or with
a bookmark to `#/about` — and you get **the remote**. The address bar catches up
in the page, without a navigation.

That is a decision rather than a limitation. Every configuration screen is advice
about a PC: _point CAM at this address_, _raise the frame-rate slider_, a shelf
backed by a file picker, a broker field. A phone is not that PC, and a control
whose bytes would land somewhere your Kraken can never read is worse than no
control (the same rule the Library's file picker has always followed).

What a phone keeps is everything that drives the one Kraken from somewhere else:
the ring, the transport, the A–B loop, the link field, **Send a file** over the
LAN, the Library — the same shelf `#/library` would have drawn, fed from the wire
— and the whole of pairing: join, rotate, unpair. What it loses is the About
page's connection plumbing, so the remote does not offer a link to it there.

A **desktop** browser is untouched: it is the same remote at a desk, and it keeps
the configuration screens, because it is also a machine that can install CAM. The
signal is the device, not the width — a coarse pointer on a narrow viewport —
so dragging a desktop window narrow never changes which app you are using.
`?phone=1` / `?phone=0` overrides it for testing, exactly as `?cam=` does.

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
merged About page. A **desktop** remote reaches it by the single quiet **About**
link at the bottom of the page (once it is paired), and the configuration page
reaches it by clicking the version line in its footer. The link is named after
the page it opens rather than after the two things on it: _Connection &
diagnostics_ named a Diagnostics page that has not existed since round 1, and a
link whose words do not match where it lands teaches the reader not to trust the
next one.

**A phone has no such link, and that is the point.** Every route on a phone
resolves back to the remote (`usePhoneOnly`, `RemoteView.tsx`), so an About link
there would open onto the room it is already in — and the sections behind it are
broker fields and telemetry switches, which are settings for the machine that
talks to the broker rather than for the handset holding the remote. What the
phone keeps is the part of that page it can actually act on: pairing — join,
rotate, unpair — has never lived on About and is on the remote itself. So
`Connection`, `Report` and the hardware-report pull are things you do **from the
PC** — the CAM configuration browser, or a desktop browser paired to the same
room.

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

### Editing from your phone

Under the ring there is **Edit this look**. It turns the ring into a canvas —
the replica keeps running underneath — and gives you the same editor CAM has,
with the gestures a hand expects:

| Gesture               | What it does                                       |
| --------------------- | -------------------------------------------------- |
| Tap a layer           | Selects it; its strip appears below the canvas     |
| Tap the background    | Deselects                                          |
| Drag                  | Moves it, snapping to the same guides CAM uses     |
| Pinch                 | Resizes it                                         |
| Two fingers, turning  | Rotates it, with the same 0 / 15 / 45 / 90° ticks  |
| Long press (½ second) | Duplicate · Bring to front · Send to back · Remove |

**Layers** opens the layer rail as a sheet, **+ Add a layer** opens the same add
sheet CAM shows, and the look's name at the top opens the Looks menu. Undo and
redo sit beside it, and one drag, pinch or twist is one undo step — not one per
frame. **Done** puts the remote back.

Three things are worth knowing, and the app says all three itself rather than
leaving you to find out:

- **The canvas needs a panel.** Edit is disabled until your Kraken has reported
  its geometry, because every layer is positioned against the real panel's size.
  A canvas over a guessed panel would place things by arithmetic on a number
  nobody supplied.
- **The layers are drawn as outlines.** The phone shows _where_ each layer sits,
  not what is inside it: pixels are the one thing this design never streams, and
  a plausible-looking fake would be worse than an honest wireframe.
- **The arrangement travels like any other change.** A look is state, and the
  sync body carries it — so a layer you drag on the phone is on the cooler by the
  time you let go, and the line under the canvas says _"Your Kraken has this
  arrangement."_ It says that only when the room is genuinely connected; joined
  but offline, or never paired at all, it reverts to _"Kept here until your
  Kraken is back"_. The edits are real and they are kept either way; what the app
  will not do is promise a delivery it cannot see.

  Two people arranging the same look at once is the ordinary
  last-writer-wins case — whichever tap was later is the one every screen lands
  on. [When two people change the same thing at once](#when-two-people-change-the-same-thing-at-once)
  has the mechanism, and it is the same mechanism for a layer's position as for
  the video's fit.

The deeper controls — the source field, the A-B loop, the quality ladder — are
not duplicated into the editor. They are real controls on the remote itself, so
pressing them in the strip closes the editor and puts you in front of them.

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
resolves to — inside **Report → Show the technical detail**. That page is a
**PC** surface: the CAM configuration browser reaches it from the version line
in its footer, and a paired desktop browser from the **About** link at the
bottom of the remote. A phone cannot press it — every route there resolves back
to the remote, so the link is not drawn — and the report it would pull is a
paragraph of build identity and probe results for a bug report, which is work
that ends at a keyboard. The phone's own half of the same question is the
presence line and the panel facts the remote already shows.

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

### When two people change the same thing at once

Every setting that travels is merged **per key**, and each key remembers when it
was last decided. The "when" is a hybrid logical clock: a wall-clock reading that
is dragged forward by everything the device has heard from the room. Two
consequences, both worth knowing:

- **A change that came after something you saw always wins.** If your phone had
  already received CAM's edit when you tapped, your tap is stamped later than it
  — by the clock, not by an argument between the two devices — so your value is
  the one every screen ends up on. This holds even if your phone's clock is
  minutes behind: the stamp is `max(now, the latest thing this page has seen)`,
  so a slow clock can never write into the past.
- **And a change made after something you did NOT see wins too, now.** The
  clause above used to be the whole story, and it left a real hole on the one
  device most likely to hit it. Everything that happens while your phone's
  screen is locked, or while it is in a lift, is something it has not seen — so
  on a phone whose clock was more than a few seconds behind, the first tap after
  it came back was stamped in the past and quietly lost. Measured: a phone ten
  seconds behind, away for six and a half, tapped on return — the button went
  green and came back. Each page now also keeps a reading of **room time**: the
  latest wall clock it has heard from anybody, which it stamps with instead of
  its own. A device joining a room adopts room time on the **first frame of any
  kind** — including the telemetry a display sends, which matters because a
  display never publishes state, so a phone alone with one would otherwise hear
  nothing at all for a whole session. Room time is kept across a reload, and so
  is the fact of having heard it: a page whose previous session genuinely learned
  nothing holds its first tap until a frame arrives and then re-stamps it.

  Room time alone was not quite enough, and the gap was measured with every
  clock in the room **correct**. Room time is a reading, and a locked phone
  takes no readings — so if the ROOM's clock moves forward while you are away
  (somebody else's phone corrects itself by ten seconds, a Kraken with no
  battery clock reaches a time server), your phone comes back stamping against
  what the room read before you locked it, and its first tap is under
  everything written in between. So the rule is now the one sentence rather
  than three special cases: **a write the room has not heard is held as an
  intent.** It takes effect on your screen the instant you make it, and it is
  re-stamped the moment a frame arrives — whether you have never heard the room,
  heard it only in a previous session that has since been closed and reopened,
  or simply had no signal for the last few seconds. What you tapped last is what
  the room lands on.

- **And a change made after your own clock jumps wins too.** Room time is
  projected forward on a clock that cannot go backwards, so a device that
  corrects its clock — an NTP step, a Kraken with no RTC reaching a time server,
  a user fixing a timezone — does not start writing into its own past. The 5 Hz
  publish throttle is measured the same way. Before that, a device whose clock
  stepped back an hour simply stopped publishing for an hour: it kept receiving,
  it reported "online", and the room split in two in silence.
- **Two genuinely simultaneous changes resolve by whichever clock reads later.**
  If you and somebody else touch the same setting within a fraction of a second,
  before either device has heard the other, there is no fact about who moved
  first — the room picks one, and it picks the SAME one on every screen. In
  practice the deciding margin is the two devices' clock skew **after room time
  has been applied**, which is milliseconds once a device has heard a single
  frame, and only its raw skew for a device that has heard nothing at all yet.
  On phones and desktops synced to network time that is milliseconds. Nothing is ever left
  split: the panel, the configuration window and the phone all land on one value
  within a round trip.

Different keys never contend at all. One person changing the fit while another
rotates the panel is two independent writes, and both survive.

If a device's clock is wrong by minutes or hours, the only thing that degrades
is that tie-break. A change it makes after seeing yours still wins over yours; a
change it makes after coming back from an outage still wins, because a write the
room has not heard is re-stamped against the first frame back rather than
against a reading taken before the outage. Only a change made at the same
instant as yours, by a device that has not heard the room recently, is decided
by the wrong clock.

That last clause is wider than "a device that has never heard the room", and the
cost is worth naming: a page treats itself as out of touch when its link is down
**or** when nothing at all has arrived for five seconds. A room with a Kraken in
it beats far faster than that, so the second test only fires during a genuine
outage — but in a room with telemetry switched off, or with no display in it at
all, a quiet stretch makes the next tap an intent too, and two people tapping
the same setting within a round trip of each other are then resolved in favour
of whoever hears the other first rather than by whichever clock read later. That
is the same simultaneity this section already says the room resolves
arbitrarily. Losing the tap outright, which is what the alternative costs, is
worse.

Readings more than a day out are **clamped to a day** rather than ignored, and
the difference is worth stating, because ignoring them was worse: a peer past
the limit still stamped its own writes at its own time, and discarding its
reading only stopped everyone else from tracking it.

Past a day, though, the honest answer is that a badly-wrong clock costs the room
real things. All three of these are measured, in
`src/sync/hlcFloorPin.dom.test.ts`:

- **A device more than a day SLOW loses its first tap after every outage** — a
  lift, a tunnel, a screen lock — until somebody corrects its clock. Its room
  time is capped a day short of the room's, so even the re-stamp its returning
  tap gets lands under everything written while it was away: the setting goes
  green on its screen and reverts a moment later. At 23 hours slow the same
  script lands the tap, and the boundary really is exactly the clamp — it used
  to be measurably narrower than that, because a phone with a **perfect** clock
  lost its first tap back whenever anybody else's clock stepped forward while it
  was locked. That one is fixed; this one is arithmetic, not a rule that can be
  patched: a device that thinks it is two days ago cannot stamp a write into the
  present.
- **One device far in the FUTURE poisons the settings it touched, for as long as
  it is wrong.** A stamp three days out pins the ordering clock of every device
  in the room at that reading for three days of real time, and while it is
  pinned the room can no longer tell which of two taps came second by any clock
  at all. It falls back to internal counters and, failing those, to the devices'
  internal ids, which is arbitrary. A device coming back from an outage is no
  longer the one that loses — its tap is re-stamped one step past the clock it
  has just caught up with, and measured, it now wins where it used to lose to
  alphabetical order. What is left is two people who were both connected the
  whole time touching the same setting at once: the room still lands on ONE
  value everywhere, and which one is not a fact about who moved first.
- **Correcting the clock does not undo it, and neither does reloading the page.**
  The bad reading now lives in the value the room agreed on, not in the device.
  What clears it is somebody changing that setting again from a device that is
  connected to everyone else at the time, or real time catching up.

The connected case remains fully covered: while every device is in the room,
whoever tapped last wins, whatever any clock says. There is no fix for the rest
inside a design with no consensus round — every cap that removes the pin either
splits the room or gives two devices two different orderings for one write —
and a room where a peer can lie about the clock is a room where that peer can
also simply write the value it wants. **If a Kraken or a phone has no network
time, set its clock.** That is the whole mitigation, and it is worth doing.

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

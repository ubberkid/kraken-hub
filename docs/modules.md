# Writing a module

A **module** is one thing the LCD can show: a video, a picture, a clock, a wall
of sensor readings. Modules are the extension point of kraken-hub — everything
user-visible on the panel is one, including the flagship video player.

This guide is a walkthrough, not a reference. It builds the **Clock** module
(`src/modules/clock/`) from an empty directory to a registered, tested, budgeted
module, and every rule it states is a rule that module actually obeys. If you
want the raw contract instead, read
[`src/modules/types.ts`](../src/modules/types.ts) — it is short and heavily
commented. If you want a skeleton to copy, take
[`src/modules/_template/`](../src/modules/_template/); it is deliberately not
registered, so copying it cannot break a build.

**Contents**

1. [The six files](#1-the-six-files)
2. [What a module actually is](#2-what-a-module-actually-is)
3. [Step 1 — the config schema](#3-step-1--the-config-schema)
4. [Step 2 — the pure logic](#4-step-2--the-pure-logic)
5. [Step 3 — the display renderer](#5-step-3--the-display-renderer)
6. [Step 4 — the config panel](#6-step-4--the-config-panel)
7. [Step 5 — the manifest](#7-step-5--the-manifest)
8. [Step 6 — register it](#8-step-6--register-it)
9. [URL parameters](#9-url-parameters)
10. [Chunking and the 25 kB budget](#10-chunking-and-the-25-kb-budget)
11. [Testing expectations](#11-testing-expectations)
12. [Changing a config shape later](#12-changing-a-config-shape-later)
13. [The checklist](#13-the-checklist)

---

## 1. The six files

```
src/modules/clock/
├── schema.ts             config type + defaults + validate()  (eager, tiny)
├── time.ts               pure logic: formatting, hand angles  (display chunk)
├── display.ts            the imperative renderer              (display chunk)
├── clock.css             styles, imported from display.ts     (display chunk)
├── ClockConfigPanel.tsx  the React settings panel             (config chunk)
└── index.ts              the manifest — what the registry sees (eager, tiny)
```

Plus one line in [`src/modules/registry.ts`](../src/modules/registry.ts). That
is the whole surface: no build configuration, no route, no state migration, no
change to the display shell.

Two of those files are **eager** — `index.ts` and `schema.ts` are imported by the
registry, which both pages load at boot so they can validate stored state and
parse URL parameters before anything is rendered. Keep them free of DOM access,
free of heavy imports, and free of anything that is only needed once the module
is actually on screen. `display.ts` and the panel are behind `loadDisplay()` and
`loadConfigPanel()`; they are the parts that are allowed to be big.

---

## 2. What a module actually is

### The display is React on the outside, imperative on the inside

`ModuleHost` (a React component) mounts your renderer into an empty, absolutely
positioned `<div>` that fills the panel — and then React is finished. Everything
that changes per frame is written straight to the DOM by your own code.

This is [invariant I4](../CONTRIBUTING.md#the-platform-invariants), and it is not
style advice. At `targetFps = 40` the frame budget is 25 ms, and CAM
_re-compresses every captured frame_ before it reaches the LCD. A per-frame
`setState` would spend that budget on reconciliation and garbage collection and
buy nothing, because nobody is interacting with the panel: there is no pointer,
no keyboard, and no scrollbar on a cooler.

So: **React renders on human-driven config changes. Your renderer renders
frames.**

### The frame clock, and why you probably want fewer frames

One `requestAnimationFrame` loop exists for the whole page
([`src/platform/fpsGovernor.ts`](../src/platform/fpsGovernor.ts)), gated to the
panel's `targetFps`. You subscribe by _implementing `frame()`_ — `ModuleHost`
wires it up for you when the method exists, and unsubscribes on unmount.

`targetFps` comes from CAM's Frame Rate slider and **its factory default is 1**.
A Kraken Z is capped at 1 and NZXT has said it will not be raised. Your module
has to look deliberate at 1 FPS, not broken:

- Never animate anything that only reads correctly as motion. A sweeping second
  hand at 1 FPS is a stuttering second hand; a _ticking_ second hand at 1 FPS is
  exactly right, because a discrete tick per second is what the clock means
  anyway. Clock therefore has **no continuous animation at all** — every visual
  state is a function of the current second.
- Prefer low-entropy pixels: flat fills, no gradients, no blur, no shadows,
  large solid areas that do not change. The Elite's frame compressor spends its
  bit budget on whatever moved, so a design that changes 2 % of the frame gets
  more frames per second than one that changes 100 % of it.
- Repaint only what changed. Compare against the last value you wrote and return
  early when it is identical — `frame()` is called up to 40 times a second and
  will be called with nothing to do most of those times.

If your module has no per-frame work at all (Stats is driven by the 1 Hz
monitoring feed, not by frames), simply do not implement `frame()` and set
`needsFrameLoop: false`.

### Geometry is a value, never a number you wrote down

Four panels exist: 640 round (Elite, Plus), 320 round (Z), 240 square
(Kraken 2023). Read every size from `ctx.geometry()`:

```ts
interface Geometry {
  width: number;
  height: number;
  shape: 'circle' | 'square';
  targetFps: number;
  dpr: number;
  source: 'nzxt' | 'sim' | 'url' | 'fallback';
  safeInsetPx: number; // practical inset for anything readable
  inscribedSquarePx: number; // min(w,h)/√2 on a circle, min(w,h) on a square
  radiusPx: number;
}
```

`inscribedSquarePx` is the number you usually want: it is the side of the
largest square guaranteed to be fully visible, so scaling a font or a dial
against it is correct on all four panels with no branching.

A literal `640`, `320` or `240` anywhere under `src/` fails
`npm run invariants`, and a bare number in `src/modules/**` fails ESLint's
`no-magic-numbers`. Both are deliberate: hardcoded geometry is silently wrong on
two of the four panels, and almost every contributor develops against an Elite.
Name your constants (`const FONT_SCALE = 0.22`) and derive from `Geometry`.

Geometry can also _change_ while you are mounted — CAM injects `window.nzxt`
late often enough that there is a simulator flag for it (`?inject=late`).
Implement `geometry(g)` and re-lay-out; do not cache sizes taken at mount and
assume they are final.

### The safe area

On a round panel the corners are not merely decorative, they are **not there**.
Anything the user must read — a label, a value, a date line — belongs inside the
safe inset. Two ways to get it:

- **CSS**, easiest: `applyGeometryToDom()` publishes `--kh-safe`, `--kh-w`,
  `--kh-h`, `--kh-r`, `--kh-inscribed` and `--kh-target-fps` on `:root`, plus
  `data-shape` on the stage. `inset: var(--kh-safe)` is a complete answer for an
  overlay.
- **JS**, when you need the numbers: `safeAreaBox(panel, opts)` from
  [`src/render/safeArea.ts`](../src/render/safeArea.ts) returns the box overlays
  are laid out against — 398×398 centred on a 640 round panel at the default
  `safeRadiusPct` of 0.88.

Full-bleed _content_ (a video, a photo) may and should bleed to the bezel. It is
**text and UI** that must respect the inset.

### The monitoring feed

`ctx.monitoring` is the 1 Hz feed CAM injects. Implement `monitoring(norm, raw)`
and `ModuleHost` subscribes you. Set `needsMonitoring: true` so the shell knows.

Every numeric field in that feed is `number | undefined`, and that is not
paranoia — CAM genuinely drops sensors, and `?monitor=missing` in the simulator
rotates fields in and out of `undefined` precisely so you are forced to handle
it. Render an em-dash or `--`, never `NaN`, never `0` pretending to be a
reading. There is **no pump RPM field**; the cooler exposes
`kraken.liquidTemperature` and nothing else. Do not invent one.

### The lifecycle, in order

```ts
interface DisplayRenderer<C> {
  mount(host, ctx, config): void | Promise<void>;
  update(config, reason): void; // config changed (human-driven, rare)
  frame?(f): void; // per tick, gated to targetFps
  monitoring?(norm, raw): void; // 1 Hz CAM feed
  geometry?(g): void; // panel size/shape/fps changed
  visibility?(v): void;
  reinit?(reason): void; // watchdog recovery; MUST be idempotent
  command?(op, arg): void; // one-shot remote command; ignore unknown ops
  unmount(): void; // MUST leave nothing behind
}
```

`unmount()` is the one with teeth. The display page runs for weeks without a
reload. Revoke every blob URL, clear every timer, remove every listener, and
drop every reference to the host element. `ctx.signal` is an `AbortSignal` that
is aborted for you on unmount — pass it to every `fetch` and every
`addEventListener` you can, and the leak stops being possible.

`update()` and `command()` are different on purpose. `update()` receives _state_
and is idempotent — it may be called with the same config after a reload, a
retained sync snapshot, or a URL parameter. `command()` receives an _action_
(`seekBy(+10)`) which is not idempotent and must never be replayed. If you find
yourself wanting a command, ask whether it is really a state change; most of the
time it is.

Every renderer callback is wrapped by `ModuleHost` in a `try/catch`, so throwing
does not take the page down — but it does show an error card on a panel nobody
is looking at, so do not rely on it.

---

## 3. Step 1 — the config schema

`src/modules/clock/schema.ts`. Three exports: a type, a defaults object, and a
validator that **cannot throw**.

```ts
export type ClockFace = 'digital' | 'analog';
export type ClockTheme = 'mono' | 'amber' | 'cyan' | 'lime' | 'magenta';

export interface ClockConfig {
  face: ClockFace;
  hourFormat: '12' | '24';
  showSeconds: boolean;
  showDate: boolean;
  theme: ClockTheme;
}

export const CLOCK_DEFAULTS: ClockConfig = {
  face: 'digital',
  hourFormat: '24',
  showSeconds: true,
  showDate: false,
  theme: 'mono',
};

export function validateClock(raw: unknown): ClockConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    face: pick(o['face'], CLOCK_FACES, CLOCK_DEFAULTS.face),
    hourFormat: pick(o['hourFormat'], HOUR_FORMATS, CLOCK_DEFAULTS.hourFormat),
    showSeconds: typeof o['showSeconds'] === 'boolean' ? o['showSeconds'] : true,
    showDate: typeof o['showDate'] === 'boolean' ? o['showDate'] : false,
    theme: pick(o['theme'], CLOCK_THEMES, CLOCK_DEFAULTS.theme),
  };
}
```

The validator's contract is worth stating precisely, because it is the only
thing standing between a corrupt `localStorage` document and a black cooler:

- **It never throws.** Coerce, clamp, drop unknown keys, fill from defaults.
- **It is total.** It runs against `undefined`, `null`, `42`, `[]`, and against
  a config written by a _newer_ version of your module on another machine that
  synced into this one. The registry conformance test feeds it all of that.
- **It is idempotent.** `validate(validate(x))` must equal `validate(x)`.
- **It is pure.** No DOM, no storage, no clock reads.

Do not reach for zod. The display bundle budget is 90 kB gzip for the whole
critical path and a schema library is a sixth of it to do a job that is twenty
lines of clamping. The rest of the codebase hand-rolls validators for exactly
this reason (see [`src/state/validate.ts`](../src/state/validate.ts)).

---

## 4. Step 2 — the pure logic

Put every decision that does not touch the DOM in its own file and unit-test it
there. For Clock that is `time.ts`: formatting a `Date` into digits, and turning
one into three hand angles.

```ts
/** Degrees clockwise from 12 o'clock. Discrete: hands tick, they do not sweep. */
export function handAngles(date: Date, showSeconds: boolean): HandAngles {
  const s = date.getSeconds();
  const m = date.getMinutes();
  const h = date.getHours() % HOURS_ON_FACE;
  return {
    hour: (h + m / MINUTES_PER_HOUR) * DEG_PER_HOUR,
    minute: m * DEG_PER_MINUTE,
    second: showSeconds ? s * DEG_PER_SECOND : null,
  };
}
```

Note what is _not_ in there: no `performance.now()`, no fractional second, no
easing. The angles are a function of the wall clock alone, which is what makes
the module identical at 1 FPS and at 40 FPS — the only difference is how soon
after a tick the panel catches up.

Two more reasons this file exists separately:

- It is the part a reviewer can actually check. A worked example in a test
  (`03:00 → hour hand at 90°`) is worth more than any amount of staring at a
  renderer.
- `Intl` is a trap on the display path. `Intl.DateTimeFormat` pulls in a large
  ICU surface and its output varies with the host locale, which on a headless
  webview inside CAM is not a thing you control or can test. Clock formats
  digits by hand and builds its date line from short, explicit tables.

---

## 5. Step 3 — the display renderer

`src/modules/clock/display.ts` exports exactly one function:

```ts
export function createRenderer(): DisplayRenderer<ClockConfig> { … }
```

`loadDisplay()` resolves to this module, `ModuleHost` calls `createRenderer()`
once per mount, and each renderer instance owns its own state in the closure —
never at module scope, or a second mount inherits the first one's DOM.

The shape that works:

```ts
export function createRenderer(): DisplayRenderer<ClockConfig> {
  let root: HTMLElement | null = null;
  let cfg: ClockConfig = CLOCK_DEFAULTS;
  let lastPainted = '';           // repaint guard

  const paint = (now: Date): void => {
    const key = paintKey(now, cfg);   // cheap string identity of the frame
    if (key === lastPainted) return;  // ← the important line
    lastPainted = key;
    …write to the DOM…
  };

  return {
    mount(host, ctx, config) { … },
    update(config)  { cfg = config; lastPainted = ''; layout(); paint(new Date()); },
    frame()         { paint(new Date()); },
    geometry(g)     { layout(g); lastPainted = ''; paint(new Date()); },
    reinit()        { lastPainted = ''; paint(new Date()); },
    unmount()       { root?.remove(); root = null; },
  };
}
```

Three details that matter more than they look:

**The repaint guard.** `frame()` fires up to 40 times a second and the clock
changes once a second. Deriving a short string that identifies the frame and
bailing when it is unchanged means 39 of those 40 calls cost one string compare
— and, more importantly, produce **zero DOM mutations**, so the compositor has
nothing to redraw and CAM's frame compressor has nothing to encode.

**Resetting the guard on every non-frame entry point.** `update()`, `geometry()`
and `reinit()` all invalidate it. Forget one and a config change silently does
nothing until the next second ticks over — the single most common bug in this
codebase's module renderers.

**Layout and paint are separate.** Layout writes sizes derived from `Geometry`
and runs on mount, on `update()` and on `geometry()`. Paint writes values and
runs per frame. Keeping them apart is what stops a font-size recalculation from
happening 40 times a second.

### DOM or SVG or canvas?

Declare it in `capabilities.substrate` (`'dom' | 'canvas' | 'mixed'`) and pick
by what you draw:

- **DOM** for text and simple boxes. Clock's digital face is one `<div>`.
- **Inline SVG** for vector geometry that changes attribute-by-attribute — Clock's
  analog face is an SVG built once at mount, after which a tick is three
  `setAttribute('transform', …)` calls. No layout, no reflow, and the untouched
  parts of the face are literally unchanged pixels.
- **Canvas** when you are drawing many things per frame. Remember to scale by
  `geometry().dpr` and to redraw on `geometry()`.

Styles go in a plain CSS file next to the module and are imported from
`display.ts` (`import './clock.css'`), which puts them in the module's own lazy
chunk. Do not add module styles to `src/app/display/display.css` — that file is
on the display critical path and is downloaded whichever module is active.

### Two things that bit all three M3 modules

**`hidden` loses to your own CSS.** The UA stylesheet's `[hidden] { display:
none }` is a bare attribute selector, so any class rule that sets `display`
(`display: grid` on an overlay, say) silently outranks it and `node.hidden =
true` does nothing. Every module that toggles `hidden` therefore ships an
explicit `.kh-thing[hidden] { display: none }`. Cheap, and invisible until an
e2e test asks whether something is hidden.

**`reinit()` must not restart your timers.** The watchdog calls `reinit()` on a
rAF or monitoring stall, which on a hidden window happens routinely. The image
module's first version re-armed the slideshow interval from `reinit()`, so on a
machine that stalled every few seconds the slideshow would never advance at all
— the countdown was reset before it could ever elapse. Re-resolve your source,
re-paint, and leave anything time-based alone.

### What a display renderer may not import

Enforced by ESLint (`import-x/no-restricted-paths`) and re-checked on the built
bundle graph by `npm run size`:

- ❌ `src/ui/` — the config component kit. It assumes a mouse and a keyboard.
- ❌ `src/app/config/` — the configuration application.
- ❌ another module's internals. If two modules need the same math, promote it:
  Image reuses the fit/zoom/pan math through `src/render/fit.ts`, which was
  lifted out of the video module for exactly that reason and is now shared by
  both. Reaching into `src/modules/video/…` from Image would have made the LCD
  download the entire video player to show a JPEG.
- ❌ `localStorage` / `sessionStorage` / `indexedDB.open` directly. Go through
  [`src/platform/storage.ts`](../src/platform/storage.ts) and
  [`src/platform/idb.ts`](../src/platform/idb.ts) so every key carries the
  `kraken-hub:v1:` namespace and the database stays `kraken-hub.v1`.
- ❌ navigation of any kind. The Kraken Browser does not follow navigations —
  a navigation is a permanently black LCD.

---

## 6. Step 4 — the config panel

`src/modules/clock/ClockConfigPanel.tsx`, exporting a component named
`ConfigPanel`:

```tsx
export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateClock(config); // ← always, first line
  return (
    <ModuleOptions
      advancedTestId="clock-advanced"
      primary={
        <GroupField label="Show date" id="clock-date">
          <Switch
            id="clock-date"
            labelledBy="clock-date-label"
            checked={cfg.showDate}
            onChange={(showDate) => {
              onChange({ ...cfg, showDate });
            }}
          />
        </GroupField>
      }
      advanced={/* colours, and anything else one level down */}
    />
  );
}
```

`ModuleOptions` is how every module builds its panel, and it is what stops a
door opening onto an empty room: pass `primary={null}` — which Stats does on its
default layout, where the one primary control does not apply — and the advanced
controls are promoted into the panel itself rather than sitting behind a
disclosure with nothing in front of it.

Note what is **not** here. The home screen's options strip already carries the
handful of settings that are worth seeing without opening anything (Face, Hours
and Seconds, for the clock), so the panel does not ask again — one module has
one set of options — and it never opens with a sentence explaining where the
others are.

Conventions:

- **Props are `unknown` on purpose.** `config` arrives from `localStorage`; the
  first thing every panel does is run its own `validate()`. That is also what
  lets the registry hold a heterogeneous list of modules without an `any`.
- **`onChange` replaces the whole config**, immutably. The host writes it into
  the state document under your module id and re-validates it on the way in.
  Never mutate `config`.
- **Build from [`src/ui/`](../src/ui/index.tsx)** — `ModuleOptions`, `Panel`,
  `Field`, `GroupField`, `Segmented`, `Switch`, `TextInput`, `NumberInput`,
  `RangeInput`, `Button`, `Disclosure`, `Notice`, `Meter`, `Chip`, `Code`,
  `Row`. There is no `Select` and no `Toggle`: round 2 deleted every native
  picker from this surface, because a `<select>` whose options are sentences is
  a control that has given up on being understood at a glance, and a system-blue
  checkbox in a teal palette is a control from somebody else's app. Using the kit is what makes a third-party module look
  like it belongs, and it keeps the panel accessible: every control gets an
  `htmlFor`/`id` pair and `jsx-a11y` runs over this file.
- **Explain the panel, not the platform.** If a setting is limited by hardware,
  say so in a `hint` or a `Notice` and link the H-id — see
  [`docs/hardware-checklist.md`](hardware-checklist.md).
- The panel is the _only_ place a user can read a cause. The LCD has no input
  and no scrollbar, so an error the panel does not explain is an error nobody
  can act on.

`.tsx` under `src/modules/` is chunked into `config-ui` and can never reach the
display graph, so the panel is free to be as heavy as it needs to be.

The reverse direction is not protected, and is worth a thought: a panel that
imports a symbol out of a _display-chunk_ file makes the configuration page
download that chunk. Nothing breaks — only the display graph is guarded — but it
is avoidable. Stats keeps its metric labels in `schema.ts` (eager and tiny) for
exactly this reason, so the panel can name a metric without pulling in the
renderer.

---

## 7. Step 5 — the manifest

`src/modules/clock/index.ts`. Small, eager, and the only file the registry sees:

```ts
export const clockModule: KrakenModule<ClockConfig> = defineModule<ClockConfig>({
  id: 'clock',
  name: 'Clock',
  summary: 'Digital or analog, with an optional date line. No network, no media.',
  icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5h-2v6l5 3 1-1.7-4-2.3V7z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    needsFrameLoop: true,
    usesMedia: false,
    hasTimeline: false,
    motionLevel: 'low',
    substrate: 'mixed',
    audio: 'none',
    remoteCommands: [],
  },
  defaults: CLOCK_DEFAULTS,
  validate: validateClock,
  applyUrlParams(config, params) { … },
  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./ClockConfigPanel'),
});
```

`defineModule()` is an identity function with DEV-only assertions — it checks the
id pattern (`^[a-z][a-z0-9-]{1,23}$`), that `configVersion >= 1`, that a
`configVersion > 1` ships a `migrateConfig`, and that `defaults` is under 4 kB.

`capabilities` is not documentation, the shell reads it:

| Field             | What the shell does with it                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `needsMonitoring` | subscribes you to the 1 Hz feed                                                  |
| `needsFrameLoop`  | declares that you want frame ticks (implement `frame()` too)                     |
| `usesMedia`       | you read IndexedDB blobs                                                         |
| `hasTimeline`     | you participate in `AppState.playback`                                           |
| `motionLevel`     | drives the low-FPS advisory: only `'full'` is genuinely ruined at 1 FPS          |
| `ownsFpsAdvisory` | you render the advisory yourself, so the shell's banner stands down (video only) |
| `substrate`       | `'dom' \| 'canvas' \| 'mixed'`                                                   |
| `audio`           | `'none' \| 'optional'` — the display is muted-only unless the user opts in       |
| `remoteCommands`  | the ops you accept on the sync `cmd` channel                                     |

Getting `motionLevel` wrong is user-visible: a Clock declaring `'full'` would
put a "raise your frame rate" card over a module that is perfectly happy at
1 FPS.

---

## 8. Step 6 — register it

[`src/modules/registry.ts`](../src/modules/registry.ts) — one import, one array
entry:

```ts
import { clockModule } from './clock';

export const MODULES: readonly AnyKrakenModule[] = [
  videoModule,
  imageModule,
  clockModule,
  statsModule,
];
```

Array order is the order of the module picker in the config UI. That is all;
routing, panel loading, validation, URL parsing and the display switch are all
driven off this array.

You get the [registry conformance suite](../src/modules/registry.test.ts) for
free the moment you are in it: id pattern, non-empty metadata, `validate()`
idempotence, `validate()` totality against junk, defaults size, and id
uniqueness.

---

## 9. URL parameters

The display accepts parameters that override persisted state for one load
(`?module=clock&face=analog`). They are parsed centrally in
[`src/state/urlParams.ts`](../src/state/urlParams.ts), which splits them in two:

- **Global** keys (`module`, `fit`, `room`, `transport`, `sim`, `fps`, `diag`,
  `demo`, `pin`, `monitor`, `inject`, `pattern`, `page`) become a patch over
  `AppState`.
- **Module-scoped** keys (`src`, `loop`, `mute`, `face`, `layout`) are collected
  raw into `moduleParams` and handed to whichever module is active.

Your module opts in by implementing `applyUrlParams(config, params)`:

```ts
applyUrlParams(config, params) {
  let next = config;
  const face = params['face'];
  if (face === 'analog' || face === 'digital') next = { ...next, face };
  return next;
}
```

Rules:

- **Unknown keys are ignored, never fatal.** An unparseable value is dropped and
  recorded as a `ParamNote` the diagnostics view renders. A typo in a URL must
  never produce a black panel.
- **You do not have to be defensive about ranges.** The host runs your result
  back through `validate()`.
- **Adding a new key means editing `KNOWN_KEYS` in `urlParams.ts`**, adding it to
  the table in that file's header comment, and adding a case to
  `urlParams.test.ts`. A key not in `KNOWN_KEYS` is reported as unknown and
  never reaches your module.
- Prefer reusing an existing key over inventing a synonym: `src` already means
  "the thing to show" for both Video and Image.

Precedence overall is: URL parameters > live remote commands > persisted state >
defaults.

---

## 10. Chunking and the 25 kB budget

Every module's display code gets its own lazily fetched chunk, and **each one is
capped at 25 kB gzip** (`budgets.json` → `perModuleChunk`). The cap is enforced
by `npm run size`, which runs inside `npm run check`.

Add your group to `vite.config.ts` next to the others:

```js
{
  name: 'module-clock',
  test: /[\\/]src[\\/]modules[\\/]clock[\\/][^/\\\\]*\.ts$/,
  priority: 92,
},
```

Two things about that regex are load-bearing:

- **`\.ts$`, not `\.tsx$`.** The panel must stay out of the module chunk; a
  separate rule sweeps every `src/modules/**/*.tsx` into `config-ui`.
- **A group claims its matched modules _and their dependencies_.** Priorities
  exist to stop a low-priority group from stealing shared code: `core` (95)
  outranks every module group (92) so the platform/state/lib files stay in
  `core`, and `render-shared` (94) sits between them so the fit math shared by
  Video and Image belongs to neither module chunk. If you add a group and the
  bundle report suddenly shows another chunk growing, this is why.

The regex above also matches `index.ts` and `schema.ts`, which are eager. That
turns out not to matter: because the registry imports them statically from
`core`, rolldown places them in `core` regardless of the group, and the module
chunk ends up holding only what `display.ts` reaches. That is an observation
about the bundler, not a guarantee — the sourcemaps say so today (`core` carries
every module's `index.ts` and `schema.ts`; `module-clock` carries `time.ts`,
`display.ts` and the CSS), and the e2e chunk-isolation test is what would catch
it changing. If a `schema.ts` ever grows past a few hundred bytes, split the
eager part out rather than trusting the hoist.

Otherwise: put anything large behind a second dynamic `import()` inside
`display.ts`. The video module does this for its download manager, which is why
the player fits the budget at all.

Verify with `npm run build && npm run size`, or explore with `npm run analyze`.
For reference, the M3 modules measure 2.0 kB (clock), 2.3 kB (stats) and 4.0 kB
(image) gzip against the 25 kB cap.

---

## 11. Testing expectations

A module is not done until all four of these exist.

**1. Unit tests for the pure logic** (`time.ts`, `format.ts`, …). This is where
the real coverage is. Table-driven, with worked examples:

```ts
it('ticks the second hand in whole seconds', () => {
  expect(handAngles(at(10, 10, 30), true).second).toBe(180);
});
```

Files are `*.test.ts` next to the source, run by Vitest's `unit` project in
node. Anything needing a document is `*.dom.test.ts` (jsdom project), and React
components are `*.test.tsx`.

**2. The registry conformance suite** — free, but read what it asserts and make
sure you actually satisfy it rather than making it pass.

**3. An e2e render check** at every panel preset. `tests/e2e/modules.spec.ts`
holds a `MODULES` table and loops it over `PRESETS` — `sim=elite` (640 round),
`sim=z` (320 round) and `sim=kraken2023` (240 square) — asserting the module
mounts, paints, stays inside the panel and logs no console error. Adding a
module is one row in `MODULES`: its id, its chunk name, the query it needs to
boot (`sourceParam`), an optional network `setup`, and one `panelCases` entry
per thing worth asserting on a panel. Nothing below the table names a module,
so there is no second place to edit.

**4. A chunk-isolation assertion.** The same spec — driven by the same table,
including the `module-video` row that carries no panel cases of its own —
records every script request while a module boots and asserts no _other_
module's chunk was fetched. This is
the test that catches an accidental cross-module import — the failure mode where
switching to Clock quietly downloads the video player.

Beyond that, e2e for whatever is genuinely stateful: Image's slideshow advance
(driven with Playwright's `page.clock` so a 10-second interval does not cost ten
seconds), Stats' placeholder rendering under `?monitor=missing`.

Run `npm run check` (typecheck, lint, invariants, format, unit, companion,
build, budgets) and `npm run test:e2e` before you open a PR.

---

## 12. Changing a config shape later

Additive changes are free: add the field, add its default, and `validate()`
fills it in for every existing user. Leave `configVersion` alone.

A **breaking** change — a renamed field, a narrowed enum, a changed unit — means:

1. bump `configVersion`;
2. implement `migrateConfig(fromVersion, raw)`, which receives the stored config
   and the version it was written at and returns something `validate()` can
   read;
3. ship a fixture test for it.

Silent data loss on somebody's cooler is not recoverable, which is why
`defineModule()` refuses in DEV to accept `configVersion > 1` without a
`migrateConfig`.

**Renaming or removing a module id is a different, larger thing**, because the
id appears in `AppState.activeModuleId` and as a key in `AppState.modules`.
That needs a _state_ migration in
[`src/state/migrations.ts`](../src/state/migrations.ts) and a `SCHEMA_VERSION`
bump. There is a worked example in that file: the `clock-lite` placeholder
shipped in M0 was replaced by this Clock module in M3, and migration 3 → 4
rewrites `activeModuleId` and moves the stored config slot across, mapping the
old `format`/`showSeconds` fields onto the new ones so an existing user's clock
comes back looking the same. Unknown module ids are otherwise preserved
verbatim, so a fork's module config survives a round trip through this build.

---

## 13. The checklist

- [ ] `schema.ts`: type, defaults, total non-throwing idempotent `validate()`
- [ ] `[hidden]` beaten by an explicit rule wherever you toggle it
- [ ] Pure logic in its own file, with unit tests and worked examples
- [ ] `display.ts`: `createRenderer()`, per-instance state, repaint guard, guard
      reset in `update`/`geometry`/`reinit`, complete `unmount()`
- [ ] Every size derived from `ctx.geometry()`; no `640`/`320`/`240` anywhere
- [ ] Readable content inside the safe area; correct on circle and square
- [ ] Deliberate at `targetFps = 1`; honest `motionLevel`
- [ ] Every `undefined` from the monitoring feed renders as `--`
- [ ] `ConfigPanel.tsx` built from `src/ui/`, validating its props first
- [ ] `index.ts` manifest with accurate `capabilities`
- [ ] Registered in `registry.ts`
- [ ] Chunk group in `vite.config.ts`; `npm run size` under 25 kB gzip
- [ ] URL params in `KNOWN_KEYS` and covered by a test, if you added any
- [ ] e2e render at 640 round / 320 round / 240 square, plus chunk isolation
- [ ] `CHANGELOG.md` under `[Unreleased]`
- [ ] `npm run check` and `npm run test:e2e` green

---

## See also

- [`src/modules/types.ts`](../src/modules/types.ts) — the contract, commented
- [`src/modules/_template/`](../src/modules/_template/) — a copyable skeleton
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — dev setup and the platform invariants
- [`docs/design/design-architecture.md`](design/design-architecture.md) — why the
  module system is shaped this way
- [`docs/hardware-checklist.md`](hardware-checklist.md) — what is still unmeasured

#!/usr/bin/env node
/**
 * The source-text half of the platform invariants.
 *
 * ESLint enforces seven of the eight invariants from CONTRIBUTING.md as lint
 * rules. **Invariant 5 — "no hardcoded device sizes" — is the one it can only
 * half enforce.** `no-magic-numbers` catches a bare `640` in an expression, but
 * it says nothing about a *named* constant (`const PANEL = 640`, which is
 * exactly the shape the invariant exists to prevent), it is scoped to
 * `src/modules/**` and `src/app/display/**` only, and it never sees CSS or JSX
 * text at all. This script closes that: a grep for the three device dimensions
 * across every source file, with an explicit allowlist and an explicit,
 * documented escape hatch.
 *
 * Why it matters: 640 is one device. A Kraken Z is 320 and a Kraken 2023 is 240,
 * and every one of those numbers reaches the code through `Geometry`, read from
 * `window.nzxt.v1`. A literal that slips in produces a layout that is silently
 * wrong on two of the four supported panels — and nobody notices, because
 * almost every contributor is developing against an Elite.
 *
 * ## What counts as a violation
 *
 * A `640`, `320` or `240` token in a source file, after comments are stripped,
 * outside the allowlist, without a marker.
 *
 * ## The escape hatch
 *
 * Some of these numbers are genuinely not device dimensions — a YouTube quality
 * ladder rung, a thumbnail edge, prose in the config UI. Mark those with
 *
 *     // device-size-ok: <why this is not a panel dimension>
 *
 * on the same line or the line above. The marker is the point: it forces the
 * next person to write down why, and a new unexplained 640 still fails.
 *
 * Usage: node scripts/check-invariants.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

/** The two files whose whole job is to KNOW the device table. */
const ALLOWLIST = new Set(['src/platform/devicePresets.ts', 'src/platform/geometry.ts']);

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css'];
const DEVICE_SIZE_RE = /\b(?:640|320|240)\b/;
const MARKER = 'device-size-ok';

/** Tests reproduce the design docs' worked examples; the literals ARE the test. */
function isScanned(rel) {
  if (!SCANNED_EXTENSIONS.some((ext) => rel.endsWith(ext))) return false;
  if (rel.endsWith('.d.ts')) return false;
  if (/\.test\.tsx?$/.test(rel)) return false;
  return !ALLOWLIST.has(rel);
}

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/**
 * Blanks out comments while preserving line count and column positions, so a
 * hit still reports the line it is really on.
 *
 * `//` is only treated as a comment when it is not preceded by `:` — otherwise
 * every `https://` in a string would swallow the rest of its line, and a device
 * size hiding after one would go unreported.
 */
function stripComments(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blanked
    .split('\n')
    .map((line) => {
      const at = line.search(/(?<!:)\/\//);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

const violations = [];
let scanned = 0;
let marked = 0;

for (const abs of files(srcDir)) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (!isScanned(rel)) continue;
  scanned += 1;

  const raw = readFileSync(abs, 'utf8').split('\n');
  const code = stripComments(raw.join('\n')).split('\n');

  for (let i = 0; i < code.length; i += 1) {
    if (!DEVICE_SIZE_RE.test(code[i])) continue;
    const here = raw[i] ?? '';
    const above = raw[i - 1] ?? '';
    if (here.includes(MARKER) || above.includes(MARKER)) {
      marked += 1;
      continue;
    }
    violations.push(`${rel}:${i + 1}  ${here.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// The cascade collision check (round 4, F7)
// ---------------------------------------------------------------------------

/**
 * The bug shape this catches, which has now shipped twice.
 *
 * `ui.css` compresses the home screen's rhythm inside `@media (max-height:
 * 640px)` and its phone layout inside `@media (max-width: 700px)`, and both
 * blocks sit ABOVE the base declarations for the same selectors. A media query
 * adds nothing to specificity, so `.kh-status` inside a media block and
 * `.kh-status` two thousand lines later are both (0,1,0) and the LATER one
 * wins — the media block is silently dead, and the file reads as though it is
 * not.
 *
 * Round 2 found the whole short-viewport block dead this way (the missing 35 px
 * of R11) and fixed it by qualifying every selector with `.kh-home`, and wrote a
 * comment saying so. Round 4 found `.kh-mods { gap: 10px 12px }` inside the
 * phone block, unqualified and dead, **twenty-five lines below that comment**.
 * A rule enforced by a comment is a rule enforced by whoever last read it.
 *
 * ## What counts as a collision
 *
 * The same selector text, at the same specificity, declared inside an at-rule
 * block and AGAIN later in source order outside it, where the two rules declare
 * at least one property in common. That is precisely the shape that is always a
 * mistake: the author wrote a conditional override and the unconditional rule
 * underneath it took the property back.
 *
 * Ordering matters, so a base rule followed by a media override is fine — that
 * is how a stylesheet is supposed to be written. Different properties are fine.
 * Different specificity is fine, which is what the `.kh-home` fix produces.
 *
 * ## The escape hatch
 *
 * A collision that is genuinely deliberate is marked with
 *
 *     a CSS comment containing `cascade-collision-ok: <why the later rule wins>`
 *
 * on the line above the LATER rule's selector.
 */
const CASCADE_MARKER = 'cascade-collision-ok';

/** `.a .b:hover` → `0,2,0`-ish. Ids, then classes/attributes/pseudo-classes, then elements. */
function specificity(selector) {
  const cleaned = selector.replace(/::[\w-]+/g, ' ');
  const ids = (cleaned.match(/#[\w-]+/g) ?? []).length;
  const classes = (cleaned.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g) ?? []).length;
  const elements = (cleaned.replace(/[.#[:][^\s>+~,]*/g, ' ').match(/\b[a-zA-Z][\w-]*/g) ?? [])
    .length;
  return `${ids},${classes},${elements}`;
}

/** Normalised so `.a , .b` and `.a,.b` are the same selector. */
function normaliseSelector(selector) {
  return selector
    .split(',')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part !== '')
    .sort()
    .join(',');
}

/** The property names a rule body declares, ignoring values. */
function declaredProps(body) {
  const props = new Set();
  for (const decl of body.split(';')) {
    const at = decl.indexOf(':');
    if (at === -1) continue;
    const name = decl.slice(0, at).trim().toLowerCase();
    if (name !== '' && /^[-a-z]+$/.test(name)) props.add(name);
  }
  return props;
}

/**
 * Every style rule in a stylesheet, in source order, with its at-rule context.
 *
 * A hand-rolled brace scanner rather than a parser dependency: this file is a
 * build gate and it must not grow a `node_modules` edge to do its job. Comments
 * are blanked first (preserving newlines) so a `{` in prose cannot desynchronise
 * the depth counter.
 */
function parseRules(css) {
  const rules = [];
  const stack = [];
  let buf = '';
  let index = 0;
  let line = 1;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '\n') {
      line += 1;
      buf += ' ';
      continue;
    }
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        continue;
      }
      // A style rule: consume to its matching brace.
      let depth = 1;
      let body = '';
      let j = i + 1;
      for (; j < css.length; j += 1) {
        const c = css[j];
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        if (c === '\n') line += 1;
        body += c;
      }
      index += 1;
      rules.push({
        selector: normaliseSelector(prelude),
        raw: prelude.replace(/\s+/g, ' '),
        specificity: specificity(prelude),
        props: declaredProps(body),
        at: stack.length === 0 ? null : stack.join(' && '),
        index,
        line,
      });
      i = j;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      buf = '';
      continue;
    }
    if (ch === ';' && buf.trim().startsWith('@')) {
      // A statement at-rule (`@import`, `@charset`) — not a block.
      buf = '';
      continue;
    }
    buf += ch;
  }
  return rules;
}

const cssFiles = files(srcDir).filter((p) => p.endsWith('.css'));
const collisions = [];
let cssRuleCount = 0;

for (const abs of cssFiles) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  const raw = readFileSync(abs, 'utf8');
  const rawLines = raw.split('\n');
  const rules = parseRules(stripComments(raw));
  cssRuleCount += rules.length;

  for (const later of rules) {
    if (later.at !== null) continue;
    for (const earlier of rules) {
      if (earlier.at === null) continue;
      if (earlier.index >= later.index) continue;
      if (earlier.selector !== later.selector) continue;
      if (earlier.specificity !== later.specificity) continue;
      const shared = [...earlier.props].filter((p) => later.props.has(p));
      if (shared.length === 0) continue;
      const above = rawLines[later.line - 2] ?? '';
      const here = rawLines[later.line - 1] ?? '';
      if (above.includes(CASCADE_MARKER) || here.includes(CASCADE_MARKER)) continue;
      collisions.push(
        `${rel}:${String(later.line)}  ${later.raw} { ${shared.join(', ')} }  ` +
          `overrides the same declaration${shared.length === 1 ? '' : 's'} inside ` +
          `${earlier.at} at line ${String(earlier.line)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The sticky-hover check
// ---------------------------------------------------------------------------

/**
 * The bug shape this catches, reported from a real phone.
 *
 * *"I had to click things twice in the remote on my phone for anything to
 * happen."* iOS Safari does not have a pointer, so it decides what a tap MEANS:
 * if the element (or an ancestor) would look or lay out differently under
 * `:hover`, the first tap is delivered as the hover and the click is withheld
 * until the second. A `:hover` rule that reveals a row of buttons — the library
 * tile's Pin/Rename/Delete, at `opacity: 0` until hovered — is precisely the
 * change that triggers it, and no amount of `@media (hover: none)` patching
 * afterwards un-writes the rule the browser already read.
 *
 * ## What counts as a violation
 *
 * A selector containing `:hover`, outside `@media (hover: hover)`, that declares
 * any of `display`, `visibility`, `opacity`, `pointer-events` or `transform` —
 * the five properties that reveal, hide, or move something rather than tint it.
 * A hover that only changes colour is fine and always was: it cannot make
 * content appear, so Safari has nothing to withhold a tap for.
 *
 * The fix is not a `hover: none` counter-rule, it is to write the rule
 * hover-first: put the hiding AND the revealing inside `@media (hover: hover)`,
 * so a touch browser never sees either.
 *
 * ## The escape hatch
 *
 *     a CSS comment containing `hover-ok: <why this cannot swallow a tap>`
 *
 * on the line above the offending selector, or on it.
 */
const HOVER_MARKER = 'hover-ok';
const HOVER_GATED_PROPS = ['display', 'visibility', 'opacity', 'pointer-events', 'transform'];
const HOVER_CONTEXT_RE = /@media[^{]*\(\s*hover\s*:\s*hover\s*\)/;

const stickyHovers = [];

for (const abs of cssFiles) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  const raw = readFileSync(abs, 'utf8');
  const rawLines = raw.split('\n');
  for (const rule of parseRules(stripComments(raw))) {
    if (!rule.raw.includes(':hover')) continue;
    if (rule.at !== null && HOVER_CONTEXT_RE.test(rule.at)) continue;
    const gated = HOVER_GATED_PROPS.filter((p) => rule.props.has(p));
    if (gated.length === 0) continue;
    const above = rawLines[rule.line - 2] ?? '';
    const here = rawLines[rule.line - 1] ?? '';
    if (above.includes(HOVER_MARKER) || here.includes(HOVER_MARKER)) continue;
    stickyHovers.push(`${rel}:${String(rule.line)}  ${rule.raw} { ${gated.join(', ')} }`);
  }
}

console.log('');
if (stickyHovers.length > 0) {
  console.error(
    `[invariants] Hover-gated content: ${String(stickyHovers.length)} rule(s) a touch browser can swallow a tap for.\n`,
  );
  for (const h of stickyHovers) console.error(`  ${h}`);
  console.error(
    [
      '',
      'iOS Safari delivers the FIRST tap as a hover whenever hovering would reveal,',
      'hide or move something — so the user presses everything twice. Wrap the rule',
      '(the hiding AND the revealing) in `@media (hover: hover)` so a touch browser',
      'never reads it at all. A `@media (hover: none)` counter-rule is not a fix.',
      '',
      'A hover that only changes colour is fine. If this one genuinely cannot swallow',
      'a tap, say why:',
      '',
      `    /* ${HOVER_MARKER}: <why> */`,
      '',
      'See ui.css `.kh-tile__actions` and CONTRIBUTING.md.',
    ].join('\n'),
  );
  process.exit(1);
}

if (collisions.length > 0) {
  console.error(
    `[invariants] Dead media-query rules: ${String(collisions.length)} equal-specificity collision(s).\n`,
  );
  for (const c of collisions) console.error(`  ${c}`);
  console.error(
    [
      '',
      'A media query adds NOTHING to specificity. A rule inside one, followed later',
      'in the file by the same selector at the same specificity, is dead — the later',
      'declaration wins wherever it sits.',
      '',
      'Qualify the conditional rule with an ancestor (`.kh-home .kh-mods`), or move it',
      'below the base rule. If the later rule really should win, say why:',
      '',
      `    /* ${CASCADE_MARKER}: <why> */`,
      '',
      'See ui.css "Every selector below is qualified by `.kh-home`" and round 4, F7.',
    ].join('\n'),
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `[invariants] Invariant 5 (no hardcoded device sizes): ${violations.length} unexplained literal(s).\n`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    [
      '',
      '640 is one device: a Kraken Z is 320 and a Kraken (2023) is 240. Read the',
      'number from `Geometry` (`window.nzxt.v1`) instead of writing it down.',
      '',
      'If it genuinely is not a panel dimension, say so on the line or the one above:',
      '',
      `    // ${MARKER}: <why this is not a panel dimension>`,
      '',
      'See CONTRIBUTING.md "The platform invariants", row 5.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `[invariants] ok  Invariant 5 (no hardcoded device sizes) — ${String(scanned)} files scanned, ` +
    `${String(marked)} documented exception(s), 0 violations.`,
);
console.log(
  `[invariants] ok  Dead media-query rules — ${String(cssFiles.length)} stylesheet(s), ` +
    `${String(cssRuleCount)} rules, 0 equal-specificity collisions.`,
);
console.log(
  `[invariants] ok  Hover-gated content — 0 rule(s) outside @media (hover: hover) ` +
    `that reveal, hide or move anything.`,
);
console.log('');

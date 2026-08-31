#!/usr/bin/env node
/**
 * Extracts one version's section from `CHANGELOG.md`.
 *
 * The release workflow tags `vX.Y.Z`, and the release notes for that tag should
 * be the notes already written and reviewed in the changelog — not a
 * regenerated commit list, and not something a maintainer retypes into the
 * GitHub UI where it can drift from the file. So the workflow calls this:
 *
 *     node scripts/changelog-section.mjs 1.0.0 > notes.md
 *
 * ## What counts as a section
 *
 * A Keep a Changelog heading of the form
 *
 *     ## [1.0.0] - 2026-09-01
 *
 * and everything up to the next `## ` heading, minus the link-reference
 * definitions at the bottom of the file (`[1.0.0]: https://…`), which are
 * markdown plumbing and read as noise in a release body.
 *
 * Both `## [1.0.0]` and `## 1.0.0` are accepted, with or without a date, and a
 * leading `v` on the argument is tolerated — because `github.ref_name` is
 * `v1.0.0` and forcing the workflow to strip it is one more place to get it
 * wrong.
 *
 * ## Why it fails loudly
 *
 * Exiting non-zero on a missing section is the point. A tag pushed without its
 * changelog entry is a mistake, and the release should stop and say so rather
 * than publish an empty body. `--allow-missing` exists for the one case where
 * that is a deliberate choice, and emits a visible placeholder.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const allowMissing = args.includes('--allow-missing');
const raw = args.find((a) => !a.startsWith('--'));

if (raw === undefined) {
  console.error('usage: node scripts/changelog-section.mjs <version> [--allow-missing]');
  process.exit(2);
}

/** `v1.0.0` and `1.0.0` are the same release. */
const version = raw.replace(/^v/, '');

const lines = readFileSync(new URL('CHANGELOG.md', `file://${root}`), 'utf8').split('\n');

/**
 * Matches `## [1.0.0] - 2026-09-01`, `## [1.0.0]`, `## 1.0.0 - …` and `## 1.0.0`.
 * The brackets are optional because Keep a Changelog only uses them when the
 * heading is also a link reference, and not every project keeps those.
 */
const heading = new RegExp(
  `^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`, //
);

const start = lines.findIndex((line) => heading.test(line));

if (start === -1) {
  if (!allowMissing) {
    console.error(
      [
        `No CHANGELOG.md section for version ${version}.`,
        '',
        'A tag without release notes is a mistake, so this is a hard failure.',
        'Add a section headed',
        '',
        `    ## [${version}] - <YYYY-MM-DD>`,
        '',
        'by promoting the [Unreleased] section, then re-tag.',
      ].join('\n'),
    );
    process.exit(1);
  }
  process.stdout.write(`_No changelog section for ${version}._\n`);
  process.exit(0);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => /^##\s/.test(line));
const body = (end === -1 ? rest : rest.slice(0, end))
  // Link-reference definitions are markdown plumbing, not release notes.
  .filter((line) => !/^\[[^\]]+\]:\s*https?:\/\//.test(line));

// Trim blank lines at both ends without disturbing the ones in the middle.
while (body.length > 0 && body[0].trim() === '') body.shift();
while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();

if (body.length === 0 && !allowMissing) {
  console.error(`The CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}

process.stdout.write(`${body.join('\n')}\n`);

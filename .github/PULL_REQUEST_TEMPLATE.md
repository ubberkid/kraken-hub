# What and why

<!-- What changes, and what problem it solves. Link the issue. -->

Closes #

## Screenshots / GIF

<!--
Required for anything that renders on the LCD. Capture at the real size
(640x640 for an Elite) — a scaled screenshot hides exactly the problems that
matter on a small circular panel.
-->

## Checklist

- [ ] `npm run check` passes locally
- [ ] Added or updated tests
- [ ] Updated the docs affected by this change
- [ ] Added a line under `## [Unreleased]` in `CHANGELOG.md`
- [ ] A `.krakenlook` added under `public/looks/` has its row in `public/looks/index.json` (`public/looks/README.md`)
- [ ] No new runtime dependency (or an ADR is linked below)
- [ ] Bundle budgets still pass (`npm run size`)
- [ ] Verified on real hardware — yes / no / N-A

## Platform invariants I touched

<!-- Tick anything this PR goes near. These are the constraints that make the LCD work. -->

- [ ] Did **not** reassign `window.nzxt` or `window.nzxt.v1` (property assignment only)
- [ ] Did **not** add a top-level navigation (no `pushState`, `location.assign`, `location.href =`)
- [ ] Any new storage key goes through `src/platform/storage.ts` and is namespaced
- [ ] Any IndexedDB access goes through `src/platform/idb.ts`
- [ ] No hardcoded origin or hostname (derived from `location`, or added to the two allowed files)
- [ ] No hardcoded device size — geometry comes from props
- [ ] Respected the import layering zones (platform ← providers ← modules ← app)
- [ ] No CDN script and no remote dynamic import

## ADR

<!-- If this changes an architectural decision, link or add docs/adr/NNNN-*.md. -->

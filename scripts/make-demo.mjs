#!/usr/bin/env node
/**
 * Generates `public/demo/demo.mp4` — the clip a cold display boots into.
 *
 * The demo has one job: prove the whole video path works with no configuration,
 * no network and no third party. So it is generated procedurally rather than
 * shipped as somebody's footage — no licensing question, no surprise, and the
 * exact command that made it lives here in the repo.
 *
 * Every choice below is about CAM's frame compressor (design-videoEngine.md
 * §8.2): the Elite pipeline compresses each captured frame, so achieved FPS
 * depends on frame *content*, not just resolution. Flat colour, a tiny moving
 * region, no gradient noise, no film grain, 30 fps — the exact profile the docs
 * recommend to users, demonstrated by the file we ship.
 *
 *  - 640×640 square: no wasted pixels behind a round 640 bezel.
 *  - 6.0 s at 30 fps, and the motion is a full revolution, so frame 179 hands
 *    over to frame 0 with no visible seam — the loop is genuinely invisible.
 *  - `-an`: the LCD is always muted; audio would be pure waste.
 *  - `+faststart`: the moov atom up front, so the direct-file adapter can start
 *    playing before the whole file has arrived.
 *
 * Usage: node scripts/make-demo.mjs   (requires ffmpeg on PATH)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'public', 'demo', 'demo.mp4');
mkdirSync(dirname(out), { recursive: true });

const SIZE = 640;
const FPS = 30;
const DURATION = 6;
const ORBIT_R = 200;
const DOT = 150;
const DOT_R = 72;
const SMALL = 90;
const SMALL_R = 42;
const SMALL_ORBIT = 110;

/** A soft-edged filled circle, drawn into an otherwise transparent box. */
const disc = (box, radius) =>
  `format=yuva420p,geq=` +
  `lum='p(X,Y)':` +
  `cb='p(X,Y)':cr='p(X,Y)':` +
  `a='clip(255*(${radius}-hypot(X-${box / 2},Y-${box / 2})),0,255)'`;

const args = [
  '-y',
  // Flat near-black ground: the cheapest possible frame for the compressor.
  '-f',
  'lavfi',
  '-i',
  `color=c=0x0d1117:s=${SIZE}x${SIZE}:r=${FPS}:d=${DURATION}`,
  '-f',
  'lavfi',
  '-i',
  `color=c=0x2f81f7:s=${DOT}x${DOT}:r=${FPS}:d=${DURATION}`,
  '-f',
  'lavfi',
  '-i',
  `color=c=0x63d29a:s=${SMALL}x${SMALL}:r=${FPS}:d=${DURATION}`,
  '-filter_complex',
  [
    `[1]${disc(DOT, DOT_R)}[dot]`,
    `[2]${disc(SMALL, SMALL_R)}[small]`,
    // One full revolution over exactly DURATION seconds -> a seamless loop.
    `[0][dot]overlay=` +
      `x='${SIZE / 2}+${ORBIT_R}*cos(2*PI*t/${DURATION})-${DOT / 2}':` +
      `y='${SIZE / 2}+${ORBIT_R}*sin(2*PI*t/${DURATION})-${DOT / 2}'[a]`,
    // Counter-rotating, so the two never overlap the same pixels for long.
    `[a][small]overlay=` +
      `x='${SIZE / 2}-${SMALL_ORBIT}*cos(2*PI*t/${DURATION})-${SMALL / 2}':` +
      `y='${SIZE / 2}-${SMALL_ORBIT}*sin(2*PI*t/${DURATION})-${SMALL / 2}',` +
      `drawbox=x=0:y=0:w=${SIZE}:h=${SIZE}:color=0x1b2430:t=8[v]`,
  ].join(';'),
  '-map',
  '[v]',
  '-r',
  String(FPS),
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-crf',
  '21',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  '-an',
  out,
];

execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`[demo] wrote ${out} (${(statSync(out).size / 1024).toFixed(1)} kB)`);

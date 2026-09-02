/**
 * Wavy gradient — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/wavy_gradient.frag` (which records the
 * Unity original it came from and every deviation). Three mechanical edits were
 * applied to that port, identically for all twelve:
 *
 *  - every `gl_FragCoord` read goes through `khCoord()`, so `uScale` zooms about
 *    the panel centre instead of about the bottom-left corner;
 *  - `uScale` and `uBright` are declared alongside the port's own uniforms;
 *  - the finished frame is multiplied by `uBright`.
 *
 * Loaded only through `effects.ts`, which reaches it with a dynamic import — so
 * this file is its own chunk and the panel only ever downloads the one effect
 * that is actually on screen.
 */

export const FRAG = `#version 300 es
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); } vec3 grad4(float x) { x = clamp(x, 0.0, 1.0) * 3.0; if (x < 1.0) return mix(uColor0, uColor1, x); if (x < 2.0) return mix(uColor1, uColor2, x - 1.0); return mix(uColor2, uColor3, x - 2.0); } float bar(vec2 uv, float start, float height) { return step(uv.y, height + start) - step(uv.y, start); } void main() { vec2 fc = khCoord() / uResolution; vec2 uv = vec2(fc.x * 1.1, fc.y * 0.55); vec3 col = vec3(0.0); for (int k = 0; k < 10; k++) { float i = float(k) * 0.1; uv.y += sin((i + uTime * 2. + uv.x * 5.) * 0.4) * 0.08 * (1. - i); col += vec3(0.2, i * 0.2, i * 0.2) * bar(uv, i, i + 2.); } float bw = ((col.r + col.g + col.b) * 0.33) + .05; float bwRemainder = mod(bw, 0.05); float neededForEven = 0.05 + bwRemainder; bw = bw + neededForEven; vec3 outc = grad4(bw - .1); o = vec4(applyTemp(clamp(outc, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

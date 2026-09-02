/**
 * Lava lamp — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/plasma.frag` (which records the
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
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); }
#define t uTime
mat2 m(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); } float map(vec3 p) { p.xz = m(t * 0.4) * p.xz; p.xy = m(t * 0.3) * p.xy; vec3 q = p * 2. + t; return length(p + vec3(sin(t * 0.7))) * log(length(p) + 1.) + sin(q.x + sin(q.z + sin(q.y))) * 0.5 - 1.; } void main() { vec2 fc = khCoord() / uResolution.y; vec2 p1 = (fc - 0.5) * 2.0; float gx = fc.x * 3.0; vec3 cl = vec3(0.); float d = 2.5; for (int i = 0; i <= 10; i++) { vec3 p = vec3(0, 0, 4) + normalize(vec3(p1.x, p1.y, -1.)) * d; float rz = map(p); float f = clamp((rz - map(p + 0.1)) * 0.5, -0.1, 1.); vec3 l = mix(uColor0, uColor1, gx * f); cl = cl * l + smoothstep(2.5, 0., rz) * 0.7 * l; d += min(rz, 1.); } vec3 bg = mix(uColor2, uColor3, fc.x); vec3 col = clamp(bg + cl, 0.0, 1.0); o = vec4(applyTemp(col, uTemp) * uBright, 1.0); }`;

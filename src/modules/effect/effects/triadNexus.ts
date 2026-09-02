/**
 * Triad nexus — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/triad_nexus.frag` (which records the
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
#define PI 3.1415927
#define TAU (2.*PI)
mat2 ROT(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); } float tri(vec2 p, float r) { p = -p; const float k = sqrt(3.0); p.x = abs(p.x) - r; p.y = p.y + r / k; if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0; p.x -= clamp(p.x, -2.0 * r, 0.0); return -length(p) * sign(p.y); } float dot2(vec2 p) { return dot(p, p); } void main() { vec2 fc = khCoord() / uResolution; vec2 p = (2.0 * khCoord() - uResolution) / uResolution.y; vec3 col = vec3(0.); for (int k = 0; k < 10; k++) { float i = 1.0 - float(k) * 0.1; float r0 = i; vec2 p0 = p; mat2 r = ROT(TAU / 6. * sin(uTime - 2.25 * i)); float sqrt_r0 = sqrt(r0); vec3 gcol0 = vec3(mix(1., 0.125, sqrt_r0)); p0 = r * p0; float d0 = tri(p0, i); if (d0 < 0.) { col = mix(col, gcol0, mix(1., 0.5 * dot2(p), r0)); } } col += col * .5; float bw = (col.r + col.g + col.b) * .3333; vec3 bg = mix(uColor2, uColor3, fc.x); vec3 shape = mix(uColor1, uColor0, clamp(bw, 0.0, 1.0)); vec3 outc = mix(bg, shape, clamp(bw, 0.0, 1.0)); o = vec4(applyTemp(clamp(outc, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

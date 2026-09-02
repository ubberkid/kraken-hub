/**
 * Colour spiral — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/color_spiral.frag` (which records the
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
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); } vec3 grad4(float x) { x = clamp(x, 0.0, 1.0) * 3.0; if (x < 1.0) return mix(uColor0, uColor1, x); if (x < 2.0) return mix(uColor1, uColor2, x - 1.0); return mix(uColor2, uColor3, x - 2.0); } void main() { vec2 I = (khCoord() / uResolution.y - 0.5) * 286.0; float a = uTime - log(length(I) + 1e-6); vec4 c4 = cos(a + vec4(0.0, 11.0, 33.0, 0.0)); vec2 mv = vec2(I.x * c4.x + I.y * c4.z, I.x * c4.y + I.y * c4.w); vec2 v = 9.0 / max(mv + 9.0, 0.1); vec3 base = clamp(vec3(v.x, v.y, v.y), 0.0, 1.0); float lum = dot(base, vec3(0.3333)); vec3 col = grad4(lum); o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

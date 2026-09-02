/**
 * Voronoi cells — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/voronoi.frag` (which records the
 * Unity original it came from and every deviation). Three mechanical edits were
 * applied to that port, identically for all twelve:
 *
 *  - every `gl_FragCoord` read goes through `khCoord()`, so `uScale` zooms about
 *    the panel centre instead of about the bottom-left corner;
 *  - `uScale` and `uBright` are declared alongside the port's own uniforms;
 *  - the finished frame is multiplied by `uBright`.
 *
 * Plus one edit of its own: the port's `i % 10` is written `i - (i / 10) * 10`,
 * because the integer modulus operator is GLSL ES 3.00 and above only and this
 * is the one source that used it. Identical result for i >= 0, and it is what
 * lets the WebGL1 fallback run this effect rather than drop to a still frame.
 *
 * Loaded only through `effects.ts`, which reaches it with a dynamic import — so
 * this file is its own chunk and the panel only ever downloads the one effect
 * that is actually on screen.
 */

export const FRAG = `#version 300 es
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); } vec2 Noise(vec2 P) { vec3 a = fract(P.xyx * vec3(123.45, 345.678, 567.89)); a += dot(a, a + 518.); return fract(a.y * a.xz); } void main() { vec2 U = (khCoord() - 0.5 * uResolution) / uResolution.y + vec2(0.45, 0.20); float d = 9.; for (int i = 0; i < 50; i++) { vec2 P = 0.1 * vec2(float(i - (i / 10) * 10), float(i / 10)) + sin(Noise(vec2(float(i))) * uTime) * 0.4; d = min(d, length(U - P)); } float band = 0.025 * abs(2. * fract(d / 0.03 + 0.6) - 1.); float m = smoothstep(0., 4. / uResolution.y, band); vec3 col = mix(uColor0, uColor1, m); vec2 p = (2.0 * khCoord() - uResolution) / uResolution.y; float rim = smoothstep(0.55, 1.05, length(p)); col = mix(col, mix(uColor2, uColor3, khCoord().y / uResolution.y), rim); o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

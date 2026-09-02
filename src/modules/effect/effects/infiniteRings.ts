/**
 * Infinite rings — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/infinite_rings.frag` (which records the
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
#define ExpBy 0.26303441
mat2 ROT(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); } float hash(float co) { return fract(sin(co * 12.9898) * 13758.545); } vec2 sca(float a) { return vec2(sin(a), cos(a)); } float arc(vec2 p, vec2 sc, float ra, float rb) { p.x = abs(p.x); return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb; } float forward(float n) { return exp2(ExpBy * n); } float reverse(float n) { return log2(n) / ExpBy; } vec2 cell(float n) { float n2 = forward(n); float pn2 = forward(n - 1.); float m = (n2 + pn2) * 0.5; float w = (n2 - pn2) * 0.5; return vec2(m, w); } vec2 df(vec2 p) { const float w = 2. / 3.; float tm = uTime; float m = fract(tm); float f = floor(tm); float z = forward(m); vec2 p0 = p; p0 /= z; float l0 = length(p0); float n0 = ceil(reverse(max(l0, 1e-6))); vec2 c0 = cell(n0); float h0 = hash(n0 - f); float h1 = fract(3677. * h0); float h2 = fract(8677. * h0); float sh2 = (h2 - 0.5) * 2.; float a = TAU * h2 + sqrt(abs(sh2)) * sign(sh2) * uTime * TAU / 20.; p0 = ROT(a) * p0; float d0 = arc(p0, sca(PI / 4. + 0.5 * PI * h1), c0.x, c0.y * w); d0 *= z; return vec2(d0, h0); } void main() { vec2 fc = khCoord() / uResolution; vec2 p = (2.0 * khCoord() - uResolution) / uResolution.y; float aa = 2. / uResolution.y; vec2 d2 = df(p); vec3 bg = mix(uColor0, uColor3, fc.y); vec3 bgL = bg * bg; vec3 col = bgL; float distance = length(p); vec3 ringCol = mix(uColor1, uColor2, d2.y); vec3 barColor = ringCol * ringCol * smoothstep(10. * aa, 20. * aa, distance); barColor = mix(bgL, barColor, smoothstep(0., 1., distance * distance * 45.)); col = mix(col, barColor, smoothstep(aa, -aa, d2.x)); col = sqrt(max(col, 0.0)); o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

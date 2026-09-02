/**
 * Prism — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/prism.frag` (which records the
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
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); } mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); } vec3 glw; float bx(vec3 p, vec3 s) { vec3 q = abs(p) - s; return min(max(q.x - .2, max(q.y + .2, q.z)), 0.) + length(max(q + .3, 0.)); } float mp(vec3 p) { float scl = 0.8; for (int i = 0; i < 3; i++) { p.yz = rot(scl - 0.3) * p.yz; p.y = abs(p.y) - scl; scl -= abs(p.y) * 0.2; p.xz = rot(uTime * 0.4) * p.xz; } float s = length(p - vec3(0, 0, 2)); float b = bx(p, vec3(scl)) - 0.1; b *= 0.5; b = min(s, b); s *= 8.; glw += 0.02 / (0.01 * s * s + 1e-4) * normalize(p * p + 1e-6); return b; } float tr(vec3 ro, vec3 rd, float z) { float d = 0.; for (int i = 0; i < 36; i++) { float s = mp(ro + rd * d) * z; d += s; if (s < 0.0001 || d > 64.) break; } return d; } vec3 nm(vec3 p) { vec2 e = vec2(0.001, 0); return normalize(mp(p) - vec3(mp(p - e.xyy), mp(p - e.yxy), mp(p - e.yyx))); } void main() { vec2 fc = khCoord() / uResolution; vec2 uv = fc - 0.5; glw = vec3(0.); vec3 ro = vec3(0, 0, -5), rd = normalize(vec3(uv, 1)); float hz = 1.0; float io = 1.4; for (int i = 0; i < 3; i++) { float hx = tr(ro, rd, hz); vec3 cp = ro + rd * hx; vec3 cn = nm(cp); vec3 cr = rd; ro = cp - cn * (0.01 * hz); rd = refract(cr, cn * hz, hz > 0. ? 1. / io : io); if (dot(rd, rd) == 0.) rd = reflect(cr, cn * hz); hz *= -1.; if (hx > 64.) break; } vec3 bg = mix(uColor2, uColor3, fc.x); float gi = clamp(dot(glw, vec3(0.3333)), 0.0, 4.0); vec3 glow = mix(uColor0, uColor1, clamp(glw.r, 0.0, 1.0)) * gi; o = vec4(applyTemp(clamp(bg + glow, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

/**
 * Classic — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/classic.frag` (which records the
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
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); } void main() { vec2 uv = khCoord() / uResolution; vec3 col = mix(uColor0, uColor1, smoothstep(1.0, 0.0, uv.y)); const float size = .075; const float alpha = .2; const float rotate = .125; const float xPos = .5; col += uColor2 * step(abs(uv.x - (xPos) - (uv.y * rotate)), size) * alpha; col += uColor3 * step(abs(uv.x - (xPos - .075) - (uv.y * rotate)), size - .01) * (alpha - .1); col += uColor3 * step(abs(uv.x - (xPos + .2) - (uv.y * rotate)), size * .4) * (alpha - .1); col += uColor3 * step(abs(uv.x - (xPos + .4) - (uv.y * rotate)), size * .7) * (alpha - .1); o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

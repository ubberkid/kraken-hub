/**
 * Wave ripple — the fragment source, and nothing else.
 *
 * Ported in W7a from `docs/design/effects-ports/wave_ripple.frag` (which records the
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
precision highp float; uniform float uTime; uniform vec2 uResolution; uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3; uniform float uTemp; uniform float uScale; uniform float uBright; out vec4 o; vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; } vec3 applyTemp(vec3 c, float t) { t = clamp(t, 0.0, 1.0); float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l); vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55); return mix(c, hot, t); } const float RING_SCALE = 8.87; const float RING_THICKNESS = 0.5; const float RING_SHARPNESS = 10.0; const float RING_SPEED = 0.3; const float STAR_POINTS = 3.0; const float STAR_AMPLITUDE = 0.3; float starDistance(vec2 p, float starPts, float starAmp) { float r = length(p); float theta = atan(p.y, p.x); float starMod = 1.0 - starAmp * cos(theta * starPts); return r / starMod; } void main() { vec2 p = (2.0 * khCoord() - uResolution) / uResolution.y; float d = starDistance(p, STAR_POINTS, STAR_AMPLITUDE); float rings = fract(d * RING_SCALE - uTime * RING_SPEED); rings = abs(rings - 0.5) * 2.0; float ringMask = smoothstep(RING_THICKNESS, RING_THICKNESS - RING_THICKNESS / max(1.0, RING_SHARPNESS), rings); vec3 fill = mix(uColor0, uColor1, clamp(1.0 - rings, 0.0, 1.0)); vec3 edge = mix(uColor2, uColor3, clamp(length(p) * 0.7, 0.0, 1.0)); vec3 col = mix(edge, fill, ringMask); o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp) * uBright, 1.0); }`;

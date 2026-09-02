#version 300 es
// Wave ripple — ported from /Users/ubberkid/bingo/Assets/Banners/wave_ripple/wave_ripple_shader.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Rings
uniform vec3  uColor1;   // Ring highlight
uniform vec3  uColor2;   // Edges
uniform vec3  uColor3;   // Edges 2
uniform float uTemp;

out vec4 o;

vec3 applyTemp(vec3 c, float t) {
  t = clamp(t, 0.0, 1.0);
  // Luminance-preserving ember bias, so the shift reads as heat on cool AND warm palettes.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 ember = vec3(1.0, 0.42, 0.12) * (0.25 + 0.90 * l);
  vec3 hot = mix(c * vec3(1.30, 0.92, 0.55), ember, 0.55);
  return mix(c, hot, t);
}

// Values from wave_ripple_banner_material.mat
const float RING_SCALE     = 8.87;
const float RING_THICKNESS = 0.5;
const float RING_SHARPNESS = 10.0;
const float RING_SPEED     = 0.3;
const float STAR_POINTS    = 3.0;
const float STAR_AMPLITUDE = 0.3;

// Star-shaped radial distance — verbatim
float starDistance(vec2 p, float starPts, float starAmp) {
  float r = length(p);
  float theta = atan(p.y, p.x);
  float starMod = 1.0 - starAmp * cos(theta * starPts);
  return r / starMod;
}

void main() {
  // Source already worked in centred -1..1 square coords (p = (uv-0.5)*2 with unit scale),
  // so nothing to un-squeeze here.
  vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

  float d = starDistance(p, STAR_POINTS, STAR_AMPLITUDE);

  float rings = fract(d * RING_SCALE - uTime * RING_SPEED);
  rings = abs(rings - 0.5) * 2.0;   // triangular wave 0 -> 1 -> 0
  float ringMask = smoothstep(RING_THICKNESS,
                              RING_THICKNESS - RING_THICKNESS / max(1.0, RING_SHARPNESS),
                              rings);

  // Source: lerp(_BGColor, _RingColor, ringMask) — two flat colours.
  // Extra slots give the wide band a phase highlight and the thin band a radial shade.
  vec3 fill = mix(uColor0, uColor1, clamp(1.0 - rings, 0.0, 1.0));
  vec3 edge = mix(uColor2, uColor3, clamp(length(p) * 0.7, 0.0, 1.0));
  vec3 col = mix(edge, fill, ringMask);

  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

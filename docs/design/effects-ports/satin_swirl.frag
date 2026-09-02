#version 300 es
// Satin swirl — ported from /Users/ubberkid/bingo/Assets/Banners/satin_swirl/satin_swirl_shader.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Aurora A
uniform vec3  uColor1;   // Aurora B
uniform vec3  uColor2;   // Background top
uniform vec3  uColor3;   // Background bottom
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

// hash21 / noise2D — verbatim from the source
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float noise2D(vec2 uv) {
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  float a = hash21(i);
  float b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1));
  float d = hash21(i + vec2(1, 1));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Values from satin_swirl_banner_material.mat
const float WAVE_FREQ    = 27.97;
const float WAVE_SPEED   = 1.0;
const float STRIPE_WIDTH = 0.5;
const float NOISE_AMP    = 0.756;

void main() {
  // Native square: source vertex stage applied (uv-0.5)*fixed2(1,.25)+fixed2(-.25,0)+0.5.
  // Dropped; uvC now spans -0.5..0.5 on both axes (the authored x extent).
  vec2 fc  = gl_FragCoord.xy / uResolution;
  vec2 uvC = fc - 0.5;

  float theta = atan(uvC.y, uvC.x);
  float r     = length(uvC);

  theta += 1.2 / (r + 0.1);
  vec2 twistUV = r * vec2(cos(theta), sin(theta));

  float grid = sin(twistUV.x * WAVE_FREQ + uTime * WAVE_SPEED) *
               cos(twistUV.y * WAVE_FREQ + uTime * WAVE_SPEED);

  grid += noise2D(twistUV * 6.0 + uTime) * NOISE_AMP;

  float stripe = smoothstep(STRIPE_WIDTH, 0.0, abs(grid));
  float fade   = 1.0 - smoothstep(0.4, 0.8, r);
  stripe *= fade;

  float tt = 0.5 + 0.5 * grid;
  vec3 auroraCol = mix(uColor0, uColor1, clamp(tt, 0.0, 1.0));

  vec3 bg = mix(uColor3, uColor2, fc.y);   // bottom -> top

  vec3 col = bg + auroraCol * stripe;
  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

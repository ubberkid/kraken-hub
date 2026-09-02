#version 300 es
// Wavy gradient — ported from /Users/ubberkid/bingo/Assets/Banners/wavy_gradient/WavyGradient.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Gradient start
uniform vec3  uColor1;   // Gradient mid
uniform vec3  uColor2;   // Gradient mid 2
uniform vec3  uColor3;   // Gradient end
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

vec3 grad4(float x) {
  x = clamp(x, 0.0, 1.0) * 3.0;
  if (x < 1.0) return mix(uColor0, uColor1, x);
  if (x < 2.0) return mix(uColor1, uColor2, x - 1.0);
  return mix(uColor2, uColor3, x - 2.0);
}

float bar(vec2 uv, float start, float height) {
  return step(uv.y, height + start) - step(uv.y, start);
}

void main() {
  // Source: fragCoord = uv * res * fixed2(1,.5); uv = fragCoord/res * 1.1 -> x 0..1.1, y 0..0.55.
  // The 0.5 on y is NOT a banner squeeze here: uv.y is the gradient axis (it selects which
  // slice of the 10-bar ramp is visible), so shrinking it would blow the top half out to the
  // end colour. The x span (which sets the wave frequency) is what carries over to square.
  vec2 fc = gl_FragCoord.xy / uResolution;
  vec2 uv = vec2(fc.x * 1.1, fc.y * 0.55);

  vec3 col = vec3(0.0);
  for (int k = 0; k < 10; k++) {
    float i = float(k) * 0.1;
    uv.y += sin((i + uTime * 2. + uv.x * 5.) * 0.4) * 0.08 * (1. - i);
    col += vec3(0.2, i * 0.2, i * 0.2) * bar(uv, i, i + 2.);
  }

  float bw = ((col.r + col.g + col.b) * 0.33) + .05;

  // Deliberate 0.05 posterization (kept verbatim) — reads well on an LCD.
  float bwRemainder = mod(bw, 0.05);
  float neededForEven = 0.05 + bwRemainder;
  bw = bw + neededForEven;

  // Source: lerp(_Color1, _Color2, bw - .1). Four stops instead of two; set the two mids
  // to the 1/3 and 2/3 blend of start/end for the exact Unity result.
  vec3 outc = grad4(bw - .1);

  o = vec4(applyTemp(clamp(outc, 0.0, 1.0), uTemp), 1.0);
}

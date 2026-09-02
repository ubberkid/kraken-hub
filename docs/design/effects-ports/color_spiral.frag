#version 300 es
// Colour spiral — ported from /Users/ubberkid/bingo/Assets/Banners/color_spiral/ColorSpiral.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Shadow
uniform vec3  uColor1;   // Mid
uniform vec3  uColor2;   // Light
uniform vec3  uColor3;   // Peak
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

void main() {
  // Source: I = (uv + fixed2(-.2,1.5)) * 286 * fixed2(1,.25); I -= iResolution.xy*0.5.
  // Native square at the SAME numeric scale (the log(length(I)) term is scale sensitive):
  // I now spans +/-143 on both axes.
  vec2 I = (gl_FragCoord.xy / uResolution.y - 0.5) * 286.0;

  float a = uTime - log(length(I) + 1e-6);
  vec4 c4 = cos(a + vec4(0.0, 11.0, 33.0, 0.0));
  // HLSL casts float4 -> float2x2 row-major: rows [c4.x c4.y; c4.z c4.w].
  // mul(I, M) is a row-vector product, so:
  vec2 mv = vec2(I.x * c4.x + I.y * c4.z,
                 I.x * c4.y + I.y * c4.w);

  vec2 v = 9.0 / max(mv + 9.0, 0.1);
  // Source wrote .xyyy — red from one axis, green/blue from the other.
  vec3 base = clamp(vec3(v.x, v.y, v.y), 0.0, 1.0);

  // The source had no colour properties at all (a fixed cyan/red golfed rainbow).
  // Its displayed luminance is preserved and mapped through the four adjustable stops.
  float lum = dot(base, vec3(0.3333));
  vec3 col = grad4(lum);

  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

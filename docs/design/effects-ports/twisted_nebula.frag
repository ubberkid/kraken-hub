#version 300 es
// Twisted nebula — ported from /Users/ubberkid/bingo/Assets/Banners/twisted_nebula/twisted_nebula_shader.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Nebula
uniform vec3  uColor1;   // Highlight
uniform vec3  uColor2;   // Background
uniform vec3  uColor3;   // Background 2
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

const float FREQ  = 20.0;  // _Freq from twisted_nebula_banner_material.mat
const float SPEED = 1.0;   // _Speed from the same material (shader default was 2.0)

void main() {
  // Native square: source used uv * fixed2(1,.25) + fixed2(-.25,.37); both dropped, span 1.
  vec2 fc = gl_FragCoord.xy / uResolution;
  vec2 p  = fc - 0.5;

  float r     = length(p);
  float theta = atan(p.y, p.x) + 2.0 / (r + 0.1);
  vec2  d     = r * vec2(cos(theta), sin(theta));

  float pattern = 0.5 * (sin(d.x * FREQ + uTime * SPEED) * cos(d.y * FREQ + uTime * SPEED) + 1.0);

  vec3 col = vec3(0.0);
  col += uColor0 * pattern;
  col += uColor1 * clamp(pattern, 0.0, 1.0) * pattern * 1.2;
  // Source added a flat _ColorC. On a round display a gentle radial falloff to a second
  // background colour reads better; set both slots the same for the exact Unity result.
  col += mix(uColor2, uColor3, clamp(r * 2.0, 0.0, 1.0));

  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

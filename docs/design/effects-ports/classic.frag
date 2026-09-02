#version 300 es
// Classic — ported from /Users/ubberkid/bingo/Assets/Banners/classic/ClassicBanner.shader
precision highp float;

uniform float uTime;     // unused: this effect is static by design
uniform vec2  uResolution;
uniform vec3  uColor0;   // Top
uniform vec3  uColor1;   // Bottom
uniform vec3  uColor2;   // Gloss
uniform vec3  uColor3;   // Accent
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

void main() {
  // Already square-native: the source used raw 0..1 UVs with no squeeze.
  vec2 uv = gl_FragCoord.xy / uResolution;

  // _TopColorPosition = 1, _BottomColorPosition = 0 in every material -> smoothstep(1,0,uv.y)
  vec3 col = mix(uColor0, uColor1, smoothstep(1.0, 0.0, uv.y));

  const float size   = .075;
  const float alpha  = .2;
  const float rotate = .125;
  const float xPos   = .5;

  col += uColor2 * step(abs(uv.x - (xPos)        - (uv.y * rotate)), size)        * alpha;
  col += uColor3 * step(abs(uv.x - (xPos - .075) - (uv.y * rotate)), size - .01)  * (alpha - .1);
  col += uColor3 * step(abs(uv.x - (xPos + .2)   - (uv.y * rotate)), size * .4)   * (alpha - .1);
  col += uColor3 * step(abs(uv.x - (xPos + .4)   - (uv.y * rotate)), size * .7)   * (alpha - .1);

  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

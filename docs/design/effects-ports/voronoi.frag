#version 300 es
// Voronoi cells — ported from /Users/ubberkid/bingo/Assets/Banners/voronoi/Voronoi_Circle.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Contours
uniform vec3  uColor1;   // Cells
uniform vec3  uColor2;   // Rim
uniform vec3  uColor3;   // Rim 2
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

// 2-D hash — verbatim from Voronoi_Circle.shader:83-88
vec2 Noise(vec2 P) {
  vec3 a = fract(P.xyx * vec3(123.45, 345.678, 567.89));
  a += dot(a, a + 518.);
  return fract(a.y * a.xz);
}

void main() {
  // Source sampled a 1.0 x 0.25 window at the origin while its 5x10 point lattice sat at
  // roughly (0.45, 0.20). Native square: a 1.0 x 1.0 window centred ON the lattice.
  vec2 U = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y + vec2(0.45, 0.20);

  float d = 9.;
  for (int i = 0; i < 50; i++) {
    vec2 P = 0.1 * vec2(float(i % 10), float(i / 10))
           + sin(Noise(vec2(float(i))) * uTime) * 0.4;
    d = min(d, length(U - P));
  }

  float band = 0.025 * abs(2. * fract(d / 0.03 + 0.6) - 1.);
  float m = smoothstep(0., 4. / uResolution.y, band);

  vec3 col = mix(uColor0, uColor1, m);

  // Round LCD: fade the rim into a dedicated pair of colours rather than hard-cutting.
  vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
  float rim = smoothstep(0.55, 1.05, length(p));
  col = mix(col, mix(uColor2, uColor3, gl_FragCoord.y / uResolution.y), rim);

  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

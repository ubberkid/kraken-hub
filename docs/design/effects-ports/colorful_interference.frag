#version 300 es
// Interference — ported from /Users/ubberkid/bingo/Assets/Banners/colorful_interference/ColorfulInterference.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Glow A
uniform vec3  uColor1;   // Glow B
uniform vec3  uColor2;   // Background
uniform vec3  uColor3;   // Edge tint
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

// Repeated-ring SDF (verbatim)
float df(vec2 p) {
  const float m = 0.25;
  float l = length(p);
  l = mod(l + 0.5 * m, m) - 0.5 * m;
  return abs(l) - m * 0.25;
}

// Polynomial smooth min/max (verbatim, ColorfulInterference.shader:95-104)
float pmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}
float pmax(float a, float b, float k) { return -pmin(-a, -b, k); }

vec3 effect(vec2 p, vec2 pp) {
  float aa = 2. / uResolution.y;
  float tm = uTime * 0.3;
  vec2 p0 = p + sin(vec2(1., sqrt(0.5)) * (tm + 100.));
  vec2 p1 = p + sin(1.2 * vec2(1., sqrt(0.5)) * (tm + 200.));
  float sm = 0.0666 * length(p);
  float d0 = df(p0);
  float d1 = df(p1);
  float d  = pmax(d0, d1, sm);
  float dd = pmax(-d0, -d1, sm);
  d = min(d, dd);

  const float so = 8.;
  const float co = 0.5;
  // The source hard-coded a sin(vec3(0,1,2)) rainbow here. Same structure — a colour that
  // cycles with radius and time over a 1/(8*dot(p,p)) radial bloom — but driven by the
  // two adjustable glow colours instead of a fixed hue wheel.
  float s0 = 0.5 + 0.5 * sin(co * length(p0) + 1. - uTime);
  float s1 = 0.5 + 0.5 * sin(co * length(p1) + 3. + uTime);
  vec3 bcol0 = mix(uColor0, uColor1, s0) * 2. / (so * dot(p0, p0) + 0.0001);
  vec3 bcol1 = mix(uColor1, uColor0, s1) * 2. / (so * dot(p1, p1) + 0.0001);
  vec3 bcol = bcol0 + bcol1;

  vec3 col = vec3(0.);
  col += 0.005 * bcol / (max(dd + 0.005, 0.) + 0.0001);
  col = mix(col, bcol, smoothstep(aa, -aa, d));
  float l = length(pp);
  col -= 0.25 * uColor3 * l;
  col *= smoothstep(1.5, 0.5, l);   // the source's own vignette, verbatim
  col = clamp(col, 0., 1.);
  col = sqrt(col);
  // Round LCD: the source ran to black past the disc edge; settle onto the background
  // colour there instead, without tinting the interior.
  col = mix(col, uColor2, smoothstep(0.85, 1.20, l));
  return clamp(col, 0., 1.);
}

void main() {
  // Native square: source squeezed with fixed2(1,.25) and offset fixed2(-.4,0). Both dropped.
  vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
  vec3 col = effect(p, p);
  o = vec4(applyTemp(col, uTemp), 1.0);
}

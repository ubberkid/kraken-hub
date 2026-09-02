#version 300 es
// Infinite rings — ported from /Users/ubberkid/bingo/Assets/Banners/infinite_rings/infinite_rings_shader.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Background
uniform vec3  uColor1;   // Rings
uniform vec3  uColor2;   // Rings 2
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

#define PI 3.1415927
#define TAU (2.*PI)
#define ExpBy 0.26303441   // log2(1.2)

mat2 ROT(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float hash(float co) { return fract(sin(co * 12.9898) * 13758.545); }

vec2 sca(float a) { return vec2(sin(a), cos(a)); }

// iq arc SDF — verbatim
float arc(vec2 p, vec2 sc, float ra, float rb) {
  p.x = abs(p.x);
  return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
}

float forward(float n) { return exp2(ExpBy * n); }
float reverse(float n) { return log2(n) / ExpBy; }

vec2 cell(float n) {
  float n2  = forward(n);
  float pn2 = forward(n - 1.);
  float m = (n2 + pn2) * 0.5;
  float w = (n2 - pn2) * 0.5;
  return vec2(m, w);
}

vec2 df(vec2 p) {
  const float w = 2. / 3.;
  float tm = uTime;
  float m = fract(tm);
  float f = floor(tm);
  float z = forward(m);
  vec2 p0 = p;
  p0 /= z;
  float l0 = length(p0);
  float n0 = ceil(reverse(max(l0, 1e-6)));
  vec2 c0 = cell(n0);
  float h0 = hash(n0 - f);
  float h1 = fract(3677. * h0);
  float h2 = fract(8677. * h0);
  float sh2 = (h2 - 0.5) * 2.;
  float a = TAU * h2 + sqrt(abs(sh2)) * sign(sh2) * uTime * TAU / 20.;
  p0 = ROT(a) * p0;
  float d0 = arc(p0, sca(PI / 4. + 0.5 * PI * h1), c0.x, c0.y * w);
  d0 *= z;
  return vec2(d0, h0);
}

void main() {
  // Native square: source used (uv + fixed2(-.2,1.5)) * res * fixed2(1,.25). Both dropped.
  vec2 fc = gl_FragCoord.xy / uResolution;
  vec2 p  = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

  float aa = 2. / uResolution.y;
  vec2 d2 = df(p);

  // The source's final sqrt() implies its working space is squared; pre-square the user
  // colours so they come back out exactly as authored.
  vec3 bg = mix(uColor0, uColor3, fc.y);
  vec3 bgL = bg * bg;

  vec3 col = bgL;
  float distance = length(p);

  // Source picked a random HUE per ring (hsv2rgb(vec3(h0,1,v))). The contract has no hue
  // slot, so each ring lands somewhere between the two adjustable ring colours instead.
  vec3 ringCol = mix(uColor1, uColor2, d2.y);
  vec3 barColor = ringCol * ringCol * smoothstep(10. * aa, 20. * aa, distance);
  barColor = mix(bgL, barColor, smoothstep(0., 1., distance * distance * 45.));
  col = mix(col, barColor, smoothstep(aa, -aa, d2.x));
  col = sqrt(max(col, 0.0));

  o = vec4(applyTemp(clamp(col, 0.0, 1.0), uTemp), 1.0);
}

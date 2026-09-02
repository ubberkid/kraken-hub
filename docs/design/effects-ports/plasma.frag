#version 300 es
// Lava lamp — ported from /Users/ubberkid/bingo/Assets/Banners/plasma/Plasma.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Lava
uniform vec3  uColor1;   // Glow
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

#define t uTime

// HLSL: transpose(float2x2(c,-s,s,c)) with mul(v,M)  ==  GLSL: mat2(c,s,-s,c) * v
mat2 m(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

// PRESERVED VERBATIM from Plasma.shader:97-103 — the entire lava-lamp look lives here.
float map(vec3 p) {
  p.xz = m(t * 0.4) * p.xz;
  p.xy = m(t * 0.3) * p.xy;
  vec3 q = p * 2. + t;
  return length(p + vec3(sin(t * 0.7))) * log(length(p) + 1.) + sin(q.x + sin(q.z + sin(q.y))) * 0.5 - 1.;
}

void main() {
  // Native square framing. The source squeezed this into a 4:1 strip via
  // fragCoord = uv * _Resolution * fixed2(1.5,.5) * 2  and  p1 = fragCoord/res - vec2(2,0.5),
  // giving x in [-2,1] (half-extent 1.5) and y in [-0.5,0.5] (half-extent 0.5).
  // Squeeze and framing offset dropped; half-extent 1.0 (between the two authored extents)
  // is what puts the molten blob in frame as a blob rather than filling the disc — swept
  // against 0.5 / 0.75 / 1.0 / 1.5 and picked by eye.
  vec2 fc = gl_FragCoord.xy / uResolution.y;   // 0..1 across the square
  vec2 p1 = (fc - 0.5) * 2.0;

  // The source's colour split uses raw fragCoord.x, which spanned 0..3 in its units.
  // Preserved so mix() extrapolates by the same amount it did in Unity.
  float gx = fc.x * 3.0;

  vec3 cl = vec3(0.);
  float d = 2.5;
  for (int i = 0; i <= 10; i++) {
    vec3 p = vec3(0, 0, 4) + normalize(vec3(p1.x, p1.y, -1.)) * d;
    float rz = map(p);
    float f = clamp((rz - map(p + 0.1)) * 0.5, -0.1, 1.);
    vec3 l = mix(uColor0, uColor1, gx * f);
    cl = cl * l + smoothstep(2.5, 0., rz) * 0.7 * l;
    d += min(rz, 1.);
  }

  vec3 bg = mix(uColor2, uColor3, fc.x);
  vec3 col = clamp(bg + cl, 0.0, 1.0);
  o = vec4(applyTemp(col, uTemp), 1.0);
}

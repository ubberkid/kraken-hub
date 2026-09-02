#version 300 es
// Triad nexus — ported from /Users/ubberkid/bingo/Assets/Banners/triad_nexus/triad_nexus_shader.shader
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uColor0;   // Triangles
uniform vec3  uColor1;   // Triangle shade
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

#define PI 3.1415927
#define TAU (2.*PI)

// HLSL: transpose(float2x2(cos,sin,-sin,cos)) with mul(v,M)  ==  GLSL: mat2(c,-s,s,c) * v
mat2 ROT(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// iq triangle SDF — verbatim from triad_nexus_shader.shader:103-112
float tri(vec2 p, float r) {
  p = -p;
  const float k = sqrt(3.0);
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float dot2(vec2 p) { return dot(p, p); }

void main() {
  // Native square: source used (uv + fixed2(-.2,1.5)) * res * fixed2(1,.25). Both dropped.
  vec2 fc = gl_FragCoord.xy / uResolution;
  vec2 p  = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;

  vec3 col = vec3(0.);

  // The source's hsv2rgb() is stubbed to return vec3(c.z), so this stack is greyscale
  // by design — the value is a depth ramp that the colour map below reads.
  for (int k = 0; k < 10; k++) {
    float i = 1.0 - float(k) * 0.1;
    float r0 = i;
    vec2 p0 = p;
    mat2 r = ROT(TAU / 6. * sin(uTime - 2.25 * i));
    float sqrt_r0 = sqrt(r0);
    vec3 gcol0 = vec3(mix(1., 0.125, sqrt_r0));
    p0 = r * p0;
    float d0 = tri(p0, i);
    if (d0 < 0.) {
      col = mix(col, gcol0, mix(1., 0.5 * dot2(p), r0));
    }
  }

  col += col * .5;
  float bw = (col.r + col.g + col.b) * .3333;

  vec3 bg = mix(uColor2, uColor3, fc.x);
  // Source: lerp(bg, _Color1, bw). Extra slot: the shapes fade from shade -> full colour
  // with depth. Set uColor1 == uColor0 for the exact Unity result.
  vec3 shape = mix(uColor1, uColor0, clamp(bw, 0.0, 1.0));
  vec3 outc = mix(bg, shape, clamp(bw, 0.0, 1.0));

  o = vec4(applyTemp(clamp(outc, 0.0, 1.0), uTemp), 1.0);
}

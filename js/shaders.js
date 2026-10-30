/*
 * GLSL sources for the renderer.
 *
 * The building is rendered by sphere-tracing a signed distance field. Every
 * floor is the same corridor (measured off the reference photograph) repeated
 * vertically; each floor has its own colours and settings.
 *
 * Lighting model (all in linear HDR):
 *   - End panel: rectangular area light, analytic form factor + stochastic shadow ray.
 *   - LED strips: analytic Lambertian line lights (closed-form irradiance).
 *   - Wall slits: hidden white strips in the pocket behind every wall extension (facing
 *     down the corridor). Never seen directly - their light is seen reflected off the
 *     next panel, the ledge and the floor. Rectangular area lights, pulsing.
 *   - Indirect: per-floor irradiance probe volume, multi-bounce, updated on the GPU.
 *   - Reflections: one GGX (VNDF) sample per pixel, ray traced, accumulated by TAA;
 *     the thin LED strips are added analytically as blurred line reflections.
 *   - Haze: ray-marched single scattering from the panel, LEDs and slits.
 *
 * Output is split in two buffers: "static" light (panel + LEDs, unit intensity) and
 * "slit" light (unit pulse). They are recombined each frame, so the pulse and the
 * light-intensity slider never smear the temporal accumulation.
 *
 * Colour comes from each floor's gradient texture (two rows per floor: strip A light->dark,
 * strip B dark->light). After accumulation, the depth sweep (after DepthVideo / selfish-design)
 * lights depth layers of the corridor in turn, and the final pass grades the image through the
 * gradient for the soft look.
 */
(function () {
  'use strict';

  const header = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

  const common = /* glsl */ `
#define PI 3.14159265359
#define NF 8

uniform vec3 uAlbedo[NF];
uniform vec3 uPanelTop[NF];
uniform vec3 uPanelBot[NF];
uniform vec3 uLedCol[NF];
uniform vec4 uFloorP[NF];      // x: light intensity, y: reflectiveness, z: haze, w: slit glow
uniform int uNumFloors;
uniform float uTime;
uniform int uFrame;
uniform sampler2D uLut;    // gradient texture: row 2f = strip A, row 2f+1 = strip B (sRGB)
uniform int uNumSlits;     // 12 (uniform so compilers keep the loops rolled)
uniform int uFogSteps;
uniform int uQuality;      // 1: ray traced reflections + shadows, 0: analytic fallback for slow GPUs

// ---------------------------------------------------------------- geometry
// Local floor space: x = lateral, y = height above floor, z = depth (towards the end panel).
const float FLOOR_H    = 5.2;
const float WALK_HW    = 2.78;    // half width of the walkway (LED lines)
const float LEDGE_H    = 0.166;   // side ledge height
const float CEIL_H     = 3.685;   // central ceiling height
const float SOFFIT_H   = 3.51;    // side soffit height
const float COFFER_TOP = 4.625;
const float Z_FRONT    = 1.2;     // section cut / open front of the building
const float Z_END      = 17.65;   // back wall behind the panel
const float SIDE_XMAX  = 4.6;
// saw-tooth wall panels
const float WALL_X  = 3.24;       // innermost (far) edge of a panel
const float WALL_K  = 0.29;       // panel yaw (dx/dz)
const float WALL_P  = 2.41;       // panel pitch along the corridor
const float WALL_Z0 = 8.32;       // z of one far edge
// ceiling coffers
const float COF_P  = 4.9;
const float COF_Z0 = 4.275;
const vec2  COF_HS = vec2(2.32, 1.925);
const float COF_R  = 0.65;
// end panel
const float PANEL_Z  = 17.05;
const float PANEL_T  = 0.08;
const float PANEL_HW = 3.40;
const float PANEL_Y0 = 0.17;
const float PANEL_Y1 = 3.55;
const float PANEL_YC = 0.5 * (PANEL_Y0 + PANEL_Y1);
const float PANEL_HH = 0.5 * (PANEL_Y1 - PANEL_Y0);
const float PANEL_R  = 0.24;
const float HEADER_Z = 16.05;     // dark lintel above the lightbox recess
const float HEADER_Y = 3.6;
// LED strips
const float LED_W   = 0.03;
const float LED_Y   = 0.015;
const float LED_LEN = PANEL_Z - Z_FRONT;
// slits: light strips on the hidden back face of every protruding wall extension
// (the step at each far edge, facing +z), i.e. inside the groove behind the extension
const float SLIT_XC  = 3.45;      // |x| of the strip centre (the step spans 3.24 .. 3.94)
const float SLIT_HW  = 0.12;      // half width across the step
const float SLIT_LOBE = 4.0;      // wall-washer beam (cos^n) ...
const vec2  SLIT_AXIS = vec2(0.2079, 0.9781);  // ... tilted 12 deg outwards onto the next panel (|x|, z)
const float SLIT_Y0  = 0.29;
const float SLIT_Y1  = 3.39;
const float SLIT_YC  = 0.5 * (SLIT_Y0 + SLIT_Y1);
const float SLIT_HH  = 0.5 * (SLIT_Y1 - SLIT_Y0);
const float SLIT_KMIN = -2.0;
const float SLIT_KMAX = 3.0;

const vec2 WEDGE_A   = vec2(WALL_X + WALL_K * WALL_P, 0.0);
const vec2 WEDGE_B   = vec2(WALL_X, WALL_P);

const float ROOM_Z0 = Z_FRONT - 2.0;
const float ROOM_ZC = 0.5 * (ROOM_Z0 + Z_END);
const float ROOM_ZH = 0.5 * (Z_END - ROOM_Z0);

// light constants (radiance, linear HDR, unit intensity)
const float LED_RAD  = 6.5;
const float SLIT_RAD = 8.5;
const vec3  SLIT_COL = vec3(1.0, 0.985, 0.96);
const float BACK_ALB = 0.12;
const float PANEL_EXP = 0.5;      // the end panel emits like a lightbox: mostly straight out
const float SKY_GAIN = 1.0;       // coffer cove light, relative to the panel's top colour
const float SLIT_ALB = 0.55;      // diffuser behind the slits when they are dark
const float SECTION_RAD = 0.0025;

#define MAT_ROOM 0
#define MAT_PANEL 1
#define MAT_LED 2
#define MAT_SLIT 3
#define MAT_SECTION 4
#define MAT_BACK 5
#define MAT_PANELBODY 6
#define MAT_SKY 7

// ---------------------------------------------------------------- random
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rand01(inout uint s) { s = pcgHash(s); return float(s >> 8) * (1.0 / 16777216.0); }
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
vec2 r2seq(int n) { return fract(vec2(0.7548776662, 0.5698402910) * float(n % 4096)); }
// low-discrepancy sample per pixel and frame (dimension pair selected by 'dim')
vec2 sample2(vec2 px, int dim) {
  uint h = pcgHash(uint(px.x) * 1973u + uint(px.y) * 9277u + uint(dim) * 26699u);
  vec2 rot = vec2(float(h & 0xffffu), float(h >> 16)) * (1.0 / 65536.0);
  return fract(r2seq(uFrame) + rot);
}

float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
                 mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
                 mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

// ---------------------------------------------------------------- distance field
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// One saw-tooth wall panel as a solid wedge; q = (|x|, u) with u in [0, WALL_P].
float sdWedge(vec2 q) {
  vec2 e = WEDGE_B - WEDGE_A;
  vec2 w = q - WEDGE_A;
  float h = clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
  float d = length(w - e * h);
  d = min(d, q.x >= WEDGE_A.x ? abs(q.y) : length(q - WEDGE_A));
  d = min(d, q.x >= WEDGE_B.x ? abs(q.y - WALL_P) : length(q - WEDGE_B));
  bool inside = q.y > 0.0 && q.y < WALL_P && q.x > WALL_X + WALL_K * (WALL_P - q.y);
  return inside ? -d : d;
}

// Index of the wall panel containing z (its far edge is at WALL_Z0 + k*WALL_P) and local u.
float wallCell(float z, out float u) {
  float k = ceil((z - WALL_Z0) / WALL_P);
  u = z - (WALL_Z0 + (k - 1.0) * WALL_P);
  return k;
}

bool slitValid(float k) { return k >= SLIT_KMIN && k <= SLIT_KMAX; }

// Signed distance to the air of one floor (negative inside the air).
float cellAir(vec3 p) {
  float ax = abs(p.x);
  float d = sdBox(p - vec3(0.0, 0.5 * CEIL_H, ROOM_ZC), vec3(WALK_HW, 0.5 * CEIL_H, ROOM_ZH));
  if (ax > WALK_HW - 0.6) {
    float side = sdBox(vec3(ax - 0.5 * (WALK_HW - 0.05 + SIDE_XMAX), p.y - 0.5 * (LEDGE_H + SOFFIT_H), p.z - ROOM_ZC),
                       vec3(0.5 * (SIDE_XMAX - WALK_HW + 0.05), 0.5 * (SOFFIT_H - LEDGE_H), ROOM_ZH));
    float u;
    float k = wallCell(p.z, u);
    float wall = min(sdWedge(vec2(ax, u)), sdWedge(vec2(ax, u + WALL_P)));
    side = max(side, -wall);
    d = min(d, side);
  }
  if (p.y > CEIL_H - 0.6) {
    float m = clamp(floor((p.z - COF_Z0) / COF_P + 0.5), 0.0, 2.0);
    float c = sdRoundRect(vec2(p.x, p.z - (COF_Z0 + m * COF_P)), COF_HS, COF_R);
    c = max(c, abs(p.y - 0.5 * (CEIL_H - 0.2 + COFFER_TOP)) - 0.5 * (COFFER_TOP - CEIL_H + 0.2));
    d = min(d, c);
  }
  return d;
}

float headerSDF(vec3 p) {
  return sdBox(p - vec3(0.0, 0.5 * (HEADER_Y + CEIL_H + 0.2), 0.5 * (HEADER_Z + Z_END + 1.0)),
               vec3(WALK_HW + 0.2, 0.5 * (CEIL_H + 0.2 - HEADER_Y), 0.5 * (Z_END + 1.0 - HEADER_Z)));
}

float panelSDF(vec3 p) {
  float r = sdRoundRect(vec2(p.x, p.y - PANEL_YC), vec2(PANEL_HW, PANEL_HH), PANEL_R);
  return max(r, abs(p.z - (PANEL_Z + 0.5 * PANEL_T)) - 0.5 * PANEL_T);
}

int floorOf(float y) { return int(floor(y / FLOOR_H)); }
vec3 toLocal(vec3 pw, int f) { return vec3(pw.x, pw.y - float(f) * FLOOR_H, pw.z); }

// Scene distance (positive in air).
float map(vec3 pw) {
  float n = floor(pw.y / FLOOR_H);
  vec3 p = vec3(pw.x, pw.y - n * FLOOR_H, pw.z);
  float air = pw.z - Z_FRONT;
  float dp = 1e3;
  if (n >= 0.0 && n < float(uNumFloors)) {
    air = min(air, cellAir(p));
    dp = min(panelSDF(p), headerSDF(p));
  }
  return min(-air, dp);
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0012;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                   k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

// Sphere tracing. Returns hit distance or -1.
float march(vec3 ro, vec3 rd, float tmax, int maxSteps) {
  float t = 0.0;
  for (int i = 0; i < 160; i++) {
    if (i >= maxSteps) break;
    float d = map(ro + rd * t);
    if (d < 0.0004 + 0.0006 * t) {
      // refine so material classification can use tight thresholds
      for (int j = 0; j < 3; j++) t += map(ro + rd * t);
      return t;
    }
    t += d;
    if (t > tmax) break;
  }
  return -1.0;
}

// Reflection rays: blurry anyway, so a looser hit tolerance.
float marchSecondary(vec3 ro, vec3 rd, float tmax) {
  float t = 0.0;
  for (int i = 0; i < 80; i++) {
    float d = map(ro + rd * t);
    if (d < 0.001 + 0.002 * t) {
      for (int j = 0; j < 2; j++) t += map(ro + rd * t);
      return t;
    }
    t += d;
    if (t > tmax) break;
  }
  return -1.0;
}

// Returns 1 if the segment is unobstructed.
float visible(vec3 ro, vec3 rd, float tmax) {
  float t = 0.0;
  for (int i = 0; i < 48; i++) {
    float d = map(ro + rd * t);
    if (d < 0.0015) return 0.0;
    t += d;
    if (t > tmax) return 1.0;
  }
  return 1.0;
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.02 + 0.2 * float(i);
    float d = map(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.72;
  }
  return clamp(1.0 - 1.0 * occ, 0.0, 1.0);
}

// Slit emitter of wall extension k on side sgn (-1 left, +1 right): a vertical strip on
// the extension's hidden back face at z = WALL_Z0 + k*WALL_P, emitting towards +z.
void slitRect(float k, float sgn, out vec3 c, out vec3 ex, out vec3 ne) {
  c  = vec3(sgn * SLIT_XC, SLIT_YC, WALL_Z0 + k * WALL_P + 0.002);
  ex = vec3(SLIT_HW, 0.0, 0.0);
  ne = vec3(0.0, 0.0, 1.0);
}

int materialAt(vec3 p, vec3 n, out float slitId, out vec2 slitUV) {
  slitId = -1.0; slitUV = vec2(0.0);
  float dPanel = panelSDF(p);
  if (dPanel < 0.02 && dPanel < -cellAir(p)) return n.z < -0.7 ? MAT_PANEL : MAT_PANELBODY;
  if (p.z < Z_FRONT + 0.002) return MAT_SECTION;
  if (p.z > Z_END - 0.004) return MAT_BACK;
  if (p.y > COFFER_TOP - 0.004 && n.y < -0.7) return MAT_SKY;
  float ax = abs(p.x);
  if (abs(ax - WALK_HW) < 0.004 && abs(n.x) > 0.7) {
    if (p.y < LED_W || (p.y > CEIL_H - LED_W && p.y < CEIL_H + 0.01)) return MAT_LED;
  }
  if (n.z > 0.7 && abs(ax - SLIT_XC) < SLIT_HW && p.y > SLIT_Y0 && p.y < SLIT_Y1) {
    float u;
    float kk = wallCell(p.z, u) - 1.0;   // the step face sits just past far edge kk
    if (u < 0.01 && slitValid(kk)) {
      slitId = (kk - SLIT_KMIN) * 2.0 + (p.x < 0.0 ? 0.0 : 1.0);
      slitUV = vec2((ax - SLIT_XC) / (2.0 * SLIT_HW) + 0.5, (p.y - SLIT_Y0) / (SLIT_Y1 - SLIT_Y0));
      return MAT_SLIT;
    }
  }
  return MAT_ROOM;
}

// ---------------------------------------------------------------- gradients
vec3 gradA(int f, float t) { return textureLod(uLut, vec2(t, (float(f * 2) + 0.5) / float(NF * 2)), 0.0).rgb; }
vec3 gradB(int f, float t) { return textureLod(uLut, vec2(t, (float(f * 2 + 1) + 0.5) / float(NF * 2)), 0.0).rgb; }
// HDR radiance that displays as the given colour (inverse of the final tone curve)
float acesInv(float y) {
  y = min(y, 0.985);
  float a = 2.51 - 2.43 * y, b = 0.03 - 0.59 * y, c = -0.14 * y;
  return (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
}
vec3 displayToHdr(vec3 c) { float m = max(max(c.r, c.g), max(c.b, 1e-4)); return c * (acesInv(m) / m); }

// ---------------------------------------------------------------- lights
// The lightbox shows the light half of the floor's gradient, top to bottom.
vec3 panelEmission(vec3 p, int f) {
  float u = clamp(p.x / PANEL_HW, -1.0, 1.0);
  float v = clamp((p.y - PANEL_Y0) / (PANEL_Y1 - PANEL_Y0), 0.0, 1.0);
  // keep it luminous even where the gradient's middle is a dark grey (hue from the gradient)
  vec3 g = gradA(f, 0.66 * (1.0 - v));
  vec3 g1 = gradA(f, 0.0);
  float m = max(max(g.r, g.g), max(g.b, 1e-3)), m1 = max(max(g1.r, g1.g), g1.b);
  vec3 c = displayToHdr(g * max(1.0, 0.92 * m1 / m));
  float fall = (1.0 - 0.5 * u * u) * (1.0 + 0.1 * (v - 0.5));
  return c * fall;
}
vec3 panelAvg(int f) { return 0.5 * (uPanelTop[f] + uPanelBot[f]) * 0.8333; }
// Lightbox directionality, seen from p (1 straight in front, 0 in the panel's plane).
float panelDirAtt(vec3 p) {
  vec3 d = p - vec3(0.0, PANEL_YC, PANEL_Z);
  float c = max(-d.z, 0.0) * inversesqrt(max(dot(d, d), 1e-4));
  return pow(c, PANEL_EXP);
}
vec3 skyEmission(vec3 p, int f) {
  float m = clamp(floor((p.z - COF_Z0) / COF_P + 0.5), 0.0, 2.0);
  float dFar = COF_Z0 + m * COF_P + COF_HS.y - p.z;
  float band = 0.18 + 0.82 * exp(-max(dFar, 0.0) / 0.42);
  return uPanelTop[f] * (SKY_GAIN * band);
}
// Indirect light falls off into the upper side pockets (soffit / wall tops), as in the reference.
float giShade(vec3 p) {
  float pocket = abs(p.x) > WALK_HW + 0.02 ? mix(1.0, 0.55, smoothstep(2.3, 3.5, p.y)) : 1.0;
  return 0.88 * pocket;
}
// darkened surround of the end panel (matte black reveal around the lightbox)
float endShade(vec3 p) {
  if (p.z > HEADER_Z - 0.01 && p.y > HEADER_Y - 0.01) return BACK_ALB;
  return mix(1.0, BACK_ALB, smoothstep(PANEL_Z - 0.55, PANEL_Z - 0.08, p.z));
}

vec3 edgeVFF(vec3 v1, vec3 v2) {
  float x = dot(v1, v2);
  float y = abs(x);
  float a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  float b = 3.4175940 + (4.1616724 + y) * y;
  float v = a / b;
  float ts = (x > 0.0) ? v : 0.5 * inversesqrt(max(1.0 - x * x, 1e-7)) - v;
  return cross(v1, v2) * ts;
}

// Horizon-clipped form factor of a quad (Lambertian emitter) seen from p with normal n.
float quadFF(vec3 p, vec3 n, vec3 c0, vec3 c1, vec3 c2, vec3 c3) {
  vec3 v0 = normalize(c0 - p), v1 = normalize(c1 - p), v2 = normalize(c2 - p), v3 = normalize(c3 - p);
  vec3 F = edgeVFF(v0, v1) + edgeVFF(v1, v2) + edgeVFF(v2, v3) + edgeVFF(v3, v0);
  if (dot(F, c0 + c2 - 2.0 * p) < 0.0) F = -F;
  float l = length(F);
  return max((l * l + dot(F, n)) / (l + 1.0), 0.0);
}

float panelFF(vec3 p, vec3 n) {
  if (p.z > PANEL_Z - 0.001) return 0.0;
  return quadFF(p, n, vec3(-PANEL_HW, PANEL_Y0, PANEL_Z), vec3(PANEL_HW, PANEL_Y0, PANEL_Z),
                      vec3(PANEL_HW, PANEL_Y1, PANEL_Z), vec3(-PANEL_HW, PANEL_Y1, PANEL_Z));
}

// Irradiance (per unit radiance) from a thin Lambertian strip along +z.
// A: start, ne: emitter normal (perpendicular to z), w: strip width.
float stripIrradiance(vec3 p, vec3 n, vec3 A, float len, vec3 ne, float w) {
  vec3 a0 = A - p;
  float gam = -dot(ne, a0);
  if (gam <= 0.0) return 0.0;
  float alpha = dot(n, a0), beta = n.z;
  float t0 = 0.0, t1 = len;
  if (abs(beta) > 1e-5) {
    float tc = -alpha / beta;
    if (beta > 0.0) t0 = max(t0, tc); else t1 = min(t1, tc);
  } else if (alpha <= 0.0) return 0.0;
  if (t1 <= t0) return 0.0;
  float c = a0.z;
  float q = max(dot(a0, a0) - c * c, 2e-4);
  float sq = sqrt(q);
  float s0 = t0 + c, s1 = t1 + c;
  float k = alpha - beta * c;
  float I1 = (s1 / (2.0 * q * (s1 * s1 + q)) + atan(s1 / sq) / (2.0 * q * sq))
           - (s0 / (2.0 * q * (s0 * s0 + q)) + atan(s0 / sq) / (2.0 * q * sq));
  float I2 = 0.5 / (s0 * s0 + q) - 0.5 / (s1 * s1 + q);
  return clamp(w * gam * (k * I1 + beta * I2), 0.0, 1.6);
}

float ledIrradiance(vec3 p, vec3 n) {
  float e = 0.0;
  e += stripIrradiance(p, n, vec3(-WALK_HW, LED_Y, Z_FRONT), LED_LEN, vec3(1, 0, 0), LED_W);
  e += stripIrradiance(p, n, vec3( WALK_HW, LED_Y, Z_FRONT), LED_LEN, vec3(-1, 0, 0), LED_W);
  e += stripIrradiance(p, n, vec3(-WALK_HW, CEIL_H - LED_Y, Z_FRONT), LED_LEN, vec3(1, 0, 0), LED_W);
  e += stripIrradiance(p, n, vec3( WALK_HW, CEIL_H - LED_Y, Z_FRONT), LED_LEN, vec3(-1, 0, 0), LED_W);
  return e;
}

// Direct irradiance from the static lights (unit intensity, panel visibility supplied).
vec3 directStatic(vec3 p, vec3 n, int f, float panelVis) {
  vec3 E = PI * panelAvg(f) * (panelFF(p, n) * panelDirAtt(p) * panelVis);
  E += uLedCol[f] * (LED_RAD * ledIrradiance(p, n));
  return E;
}

// Direct irradiance from all slits at unit pulse.
vec3 directSlit(vec3 p, vec3 n) {
  float ff = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= uNumSlits) break;
    float k = SLIT_KMIN + float(i / 2);
    float sgn = (i % 2 == 0) ? -1.0 : 1.0;
    vec3 c, ex, ne;
    slitRect(k, sgn, c, ex, ne);
    vec3 d = p - c;
    if (d.z <= 0.002) continue;                 // behind the strip
    if (dot(-d, n) <= -SLIT_HH) continue;       // below the receiver's horizon
    float vis = 1.0;
    // on the same wall beyond the next extension: that extension hides the groove
    if (p.x * sgn > 0.0 && p.z > c.z + WALL_P) {
      float axl = mix(SLIT_XC, abs(p.x), WALL_P / d.z);
      vis = 1.0 - smoothstep(WALL_X - 0.3, WALL_X + 0.05, axl);
      if (vis <= 0.0) continue;
    }
    // beam shape, judged from the nearest point of the strip
    vec3 dn = p - vec3(c.x + clamp(p.x - c.x, -SLIT_HW, SLIT_HW), clamp(p.y, SLIT_Y0, SLIT_Y1), c.z);
    float cb = (dn.x * sgn * SLIT_AXIS.x + dn.z * SLIT_AXIS.y) * inversesqrt(max(dot(dn, dn), 1e-4));
    float lobe = pow(max(cb, 0.0), SLIT_LOBE);
    if (lobe < 1e-3) continue;
    float d2 = dot(d, d);
    if (d2 > 12.0) {
      // far field: point source approximation
      float il = inversesqrt(d2);
      ff += vis * lobe * (4.0 * SLIT_HW * SLIT_HH) * max(dot(-d, n) * il, 0.0) * (d.z * il) / (PI * d2);
    } else {
      vec3 ey = vec3(0.0, SLIT_HH, 0.0);
      ff += vis * lobe * quadFF(p, n, c - ex - ey, c + ex - ey, c + ex + ey, c - ex + ey);
    }
  }
  return SLIT_COL * (SLIT_RAD * PI * ff);
}

// Analytic reflection of a thin emitter: a gaussian-blurred line seen along ray (p, r).
float glowFalloff(float delta, float s, float wAng, float sig) {
  float ang = delta / s;
  float sg = max(sig, 0.45 * wAng);
  return wAng * exp(-0.5 * ang * ang / (sg * sg)) / (sg * 2.5066);
}
float lineGlowZ(vec3 p, vec3 r, float tOcc, vec3 A, vec3 ne, float sig) {
  vec3 w0 = p - A;
  if (dot(w0, ne) <= 0.0) return 0.0;
  float b = r.z;
  float denom = max(1.0 - b * b, 1e-4);
  float t = clamp((w0.z - b * dot(r, w0)) / denom, 0.0, LED_LEN);
  vec3 Q = A + vec3(0.0, 0.0, t);
  float s = dot(Q - p, r);
  if (s <= 0.0 || s > tOcc + 0.05) return 0.0;
  float wAng = LED_W * max(abs(dot(r, ne)), 0.12) / s;
  return glowFalloff(length(p + r * s - Q), s, wAng, sig);
}
vec3 ledGlow(vec3 p, vec3 r, float tOcc, int f, float sig) {
  float g = lineGlowZ(p, r, tOcc, vec3(-WALK_HW, LED_Y, Z_FRONT), vec3(1, 0, 0), sig)
          + lineGlowZ(p, r, tOcc, vec3( WALK_HW, LED_Y, Z_FRONT), vec3(-1, 0, 0), sig)
          + lineGlowZ(p, r, tOcc, vec3(-WALK_HW, CEIL_H - LED_Y, Z_FRONT), vec3(1, 0, 0), sig)
          + lineGlowZ(p, r, tOcc, vec3( WALK_HW, CEIL_H - LED_Y, Z_FRONT), vec3(-1, 0, 0), sig);
  return uLedCol[f] * (LED_RAD * g);
}

// ---------------------------------------------------------------- BRDF helpers
float envBRDF(float F0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * AB.x + AB.y;
}

// GGX visible-normal sampling (spherical caps), Ve in tangent space.
vec3 sampleVNDF(vec3 Ve, float alpha, vec2 u) {
  vec3 Vh = normalize(vec3(alpha * Ve.x, alpha * Ve.y, Ve.z));
  float phi = 2.0 * PI * u.x;
  float z = (1.0 - u.y) * (1.0 + Vh.z) - Vh.z;
  float st = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
  vec3 Nh = vec3(st * cos(phi), st * sin(phi), z) + Vh;
  return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}

vec3 cosineSample(vec3 n, vec2 u) {
  vec3 t, b; basis(n, t, b);
  float r = sqrt(u.x), phi = 2.0 * PI * u.y;
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u.x)));
}

// Surface roughness from the reflectiveness setting (walls are a little rougher than floor/ceiling).
float surfRough(int f, vec3 n, int mat) {
  float refl = uFloorP[f].y;
  float r = 0.55 * pow(1.0 - refl, 1.4) + 0.03;
  if (abs(n.y) < 0.5) r = min(r * 1.35 + 0.05, 1.0);
  else if (n.y < 0.0) r *= 0.75;
  if (mat == MAT_BACK) r = max(r, 0.5);
  return r;
}
float surfF0(int f) { return mix(0.02, 0.065, uFloorP[f].y); }

// ---------------------------------------------------------------- probes (irradiance volume)
const int PNX = 13, PNY = 8, PNZ = 24;
const vec2 PROBE_TEX = vec2(78.0, 192.0);
const vec3 PROBE_ORIGIN  = vec3(-4.0, 0.15, 1.4);
const vec3 PROBE_SPACING = vec3(8.0 / 12.0, 4.3 / 7.0, 16.0 / 23.0);

vec4 probeDir(sampler2D tex, float d, vec3 g) {
  float k0 = floor(g.z);
  float k1 = min(k0 + 1.0, float(PNZ - 1));
  vec2 base = vec2(d * float(PNX) + g.x + 0.5, g.y + 0.5);
  vec4 a = textureLod(tex, (base + vec2(0.0, k0 * float(PNY))) / PROBE_TEX, 0.0);
  vec4 b = textureLod(tex, (base + vec2(0.0, k1 * float(PNY))) / PROBE_TEX, 0.0);
  return mix(a, b, g.z - k0);
}
vec4 probeIrr(sampler2D tex, vec3 pl, vec3 n) {
  vec3 g = clamp((pl + n * 0.3 - PROBE_ORIGIN) / PROBE_SPACING, vec3(0.0),
                 vec3(float(PNX - 1), float(PNY - 1), float(PNZ - 1)));
  vec3 w = n * n;
  return w.x * probeDir(tex, n.x >= 0.0 ? 0.0 : 1.0, g)
       + w.y * probeDir(tex, n.y >= 0.0 ? 2.0 : 3.0, g)
       + w.z * probeDir(tex, n.z >= 0.0 ? 4.0 : 5.0, g);
}

// ---------------------------------------------------------------- haze
float hazeSigma(int f, vec3 p) {
  float h = uFloorP[f].z;
  float base = 0.0015 + 0.11 * pow(h, 1.6);
  vec3 q = p * 0.42 + vec3(0.11, 0.035, -0.05) * uTime;
  float nz = vnoise(q);
  return base * (0.55 + 0.9 * nz);
}
float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float triSolidAngle(vec3 a, vec3 b, vec3 c) {
  float la = length(a), lb = length(b), lc = length(c);
  float num = abs(dot(a, cross(b, c)));
  float den = la * lb * lc + dot(a, b) * lc + dot(a, c) * lb + dot(b, c) * la;
  return 2.0 * atan(num, den);
}
float panelSolidAngle(vec3 p) {
  if (p.z > PANEL_Z - 0.01) return 0.0;
  vec3 a = vec3(-PANEL_HW, PANEL_Y0, PANEL_Z) - p, b = vec3(PANEL_HW, PANEL_Y0, PANEL_Z) - p;
  vec3 c = vec3(PANEL_HW, PANEL_Y1, PANEL_Z) - p, d = vec3(-PANEL_HW, PANEL_Y1, PANEL_Z) - p;
  return triSolidAngle(a, b, c) + triSolidAngle(a, c, d);
}
float lineScatter(vec3 p, vec3 A, vec3 ne) {
  vec3 a0 = A - p;
  if (dot(ne, -a0) <= 0.0) return 0.0;
  float c = a0.z;
  float q = max(dot(a0, a0) - c * c, 1e-3);
  float sq = sqrt(q);
  return LED_W * 0.7 * (atan((LED_LEN + c) / sq) - atan(c / sq)) / sq;
}
`;

  // ------------------------------------------------------------------ shading shared by main & probe passes
  // Requires giSample(int f, vec3 pl, vec3 n) to be defined before inclusion.
  const shading = /* glsl */ `
struct Surf { vec3 pw; vec3 pl; vec3 n; int mat; int f; float slitId; vec2 slitUV; };

Surf makeSurf(vec3 pw) {
  Surf s;
  s.pw = pw;
  s.f = clamp(floorOf(pw.y), 0, NF - 1);
  s.pl = toLocal(pw, s.f);
  s.n = calcNormal(pw);
  s.mat = materialAt(s.pl, s.n, s.slitId, s.slitUV);
  return s;
}

// Exit through the open front: treated as a wall facing into the room (keeps the GI closed).
Surf frontSurf(vec3 ro, vec3 rd) {
  float t = (Z_FRONT + 0.02 - ro.z) / min(rd.z, -1e-4);
  Surf s;
  s.pw = ro + rd * max(t, 0.0);
  s.f = clamp(floorOf(s.pw.y), 0, NF - 1);
  s.pl = toLocal(s.pw, s.f);
  s.pl.y = clamp(s.pl.y, 0.05, COFFER_TOP - 0.05);
  s.n = vec3(0.0, 0.0, 1.0);
  s.mat = MAT_ROOM; s.slitId = -1.0; s.slitUV = vec2(0.0);
  return s;
}

// Radiance leaving a surface hit by a secondary ray (reflection / probe ray).
// emitDirect: include the panel and slit emitters (reflections) or not (GI probes, whose
// direct light is evaluated analytically). LED emission is always analytic.
void shadeSecondary(Surf s, bool emitDirect, float panelVis, out vec3 Ls, out vec3 Lt) {
  Ls = vec3(0.0); Lt = vec3(0.0);
  if (s.mat == MAT_PANEL) { if (emitDirect) Ls = panelEmission(s.pl, s.f); return; }
  if (s.mat == MAT_SKY) { Ls = skyEmission(s.pl, s.f); return; }
  if (s.mat == MAT_SECTION || s.mat == MAT_PANELBODY) { Ls = vec3(SECTION_RAD); return; }
  vec3 alb = s.mat == MAT_SLIT ? vec3(SLIT_ALB) : uAlbedo[s.f] * (s.mat == MAT_BACK ? BACK_ALB : endShade(s.pl));
  vec4 gi = giSample(s.f, s.pl, s.n) * giShade(s.pl);
  vec3 Es = directStatic(s.pl, s.n, s.f, panelVis) + gi.rgb;
  vec3 Et = directSlit(s.pl, s.n) + gi.a * uAlbedo[s.f];
  Ls = alb * (1.0 / PI) * Es;
  Lt = alb * (1.0 / PI) * Et;
  if (s.mat == MAT_SLIT && emitDirect) Lt += SLIT_COL * SLIT_RAD;
}

// Glossy floor/ceiling seen in a reflection: approximate their own reflection of the panel
// analytically (planar intersection, roughness-softened edges), so double reflections survive.
vec3 panelMirror(Surf s, vec3 v) {
  if (abs(s.n.y) < 0.5 || s.pl.y > CEIL_H + 0.01) return vec3(0.0);
  float dk = endShade(s.pl);
  if (dk < 0.5) return vec3(0.0);
  vec3 r = reflect(-v, s.n);
  if (r.z <= 0.05) return vec3(0.0);
  float t = (PANEL_Z - s.pl.z) / r.z;
  if (t <= 0.0) return vec3(0.0);
  vec3 q = s.pl + r * t;
  float rough = surfRough(s.f, s.n, MAT_ROOM);
  float soft = 0.03 + 1.2 * rough * rough * t;
  float w = smoothstep(PANEL_HW + soft, PANEL_HW - soft, abs(q.x)) *
            smoothstep(PANEL_Y0 - soft, PANEL_Y0 + soft, q.y) * smoothstep(PANEL_Y1 + soft, PANEL_Y1 - soft, q.y);
  float NoV = max(dot(s.n, v), 1e-3);
  return envBRDF(surfF0(s.f), rough, NoV) * w * panelEmission(q, s.f);
}

// Stochastic visibility of the end panel from p.
float panelVisibility(vec3 pw, vec3 pl, vec3 n, vec2 u) {
  vec3 q = vec3(mix(-PANEL_HW + 0.1, PANEL_HW - 0.1, u.x), mix(PANEL_Y0 + 0.05, PANEL_Y1 - 0.05, u.y), PANEL_Z - 0.002);
  vec3 dv = q - pl;
  float dist = length(dv);
  vec3 dir = dv / dist;
  if (dot(dir, n) <= 0.0) return 0.0;
  return visible(pw + n * 0.004, dir, dist - 0.04);
}
`;

  // ------------------------------------------------------------------ main pass
  const mainPass = /* glsl */ `
uniform vec3 uCamPos;
uniform vec2 uRes;
uniform float uFocal;
uniform vec2 uPrincipal;
uniform vec2 uJitter;
uniform sampler2D uProbe0;
uniform sampler2D uProbe1;
uniform int uProbeFloor0;
uniform int uProbeFloor1;
uniform int uDebug;

layout(location = 0) out vec4 outStatic;
layout(location = 1) out vec4 outSlit;

vec4 giSample(int f, vec3 pl, vec3 n) {
  if (f == uProbeFloor0) return probeIrr(uProbe0, pl, n);
  if (f == uProbeFloor1) return probeIrr(uProbe1, pl, n);
  return vec4(0.0);
}
` + shading + /* glsl */ `

void fogIntegrate(vec3 ro, vec3 rd, float tEnd, vec2 px, out vec3 inS, out vec3 inT, out float trans) {
  inS = vec3(0.0); inT = vec3(0.0); trans = 1.0;
  float t0 = 0.0;
  if (ro.z < Z_FRONT) { if (rd.z <= 1e-4) return; t0 = (Z_FRONT - ro.z) / rd.z; }
  float t1 = min(tEnd, 60.0);
  if (t1 <= t0) return;
  int N = uFogSteps;
  float dt = (t1 - t0) / float(N);
  float jit = fract(ign(px + 3.7) + 0.61803398 * float(uFrame % 64));
  // ambient (indirect) in-scattering: one probe lookup at the middle of the segment
  vec3 pm = ro + rd * (0.5 * (t0 + t1));
  int fm = clamp(floorOf(pm.y), 0, NF - 1);
  vec4 giM = giSample(fm, toLocal(pm, fm), rd) * (1.0 / (2.0 * PI));
  for (int i = 0; i < 32; i++) {
    if (i >= N) break;
    float t = t0 + (float(i) + jit) * dt;
    vec3 pw = ro + rd * t;
    int f = floorOf(pw.y);
    if (f < 0 || f >= uNumFloors) continue;
    vec3 p = toLocal(pw, f);
    if (p.y > COFFER_TOP || p.y < 0.0) continue;
    float sigma = hazeSigma(f, p);
    // panel (forward scattering produces the glow around it)
    vec3 toPanel = normalize(vec3(clamp(p.x, -PANEL_HW, PANEL_HW), clamp(p.y, PANEL_Y0, PANEL_Y1), PANEL_Z) - p);
    float ph = phaseHG(dot(toPanel, rd), 0.55) * 0.75 + 0.25 / (4.0 * PI);
    vec3 S = panelAvg(f) * (panelSolidAngle(p) * ph);
    float led = lineScatter(p, vec3(-WALK_HW, LED_Y, Z_FRONT), vec3(1, 0, 0))
              + lineScatter(p, vec3( WALK_HW, LED_Y, Z_FRONT), vec3(-1, 0, 0))
              + lineScatter(p, vec3(-WALK_HW, CEIL_H - LED_Y, Z_FRONT), vec3(1, 0, 0))
              + lineScatter(p, vec3( WALK_HW, CEIL_H - LED_Y, Z_FRONT), vec3(-1, 0, 0));
    S += uLedCol[f] * (LED_RAD * led / (4.0 * PI));
    S += giM.rgb;
    float st = 0.0;
    for (int j = 0; j < 12; j++) {
      if (j >= uNumSlits) break;
      vec3 c, ex, ne;
      slitRect(SLIT_KMIN + float(j / 2), (j % 2 == 0) ? -1.0 : 1.0, c, ex, ne);
      vec3 d = p - c;
      float d2 = max(dot(d, d), 0.2);
      float ce = d.z * inversesqrt(d2);
      float cb = (d.x * ((j % 2 == 0) ? -1.0 : 1.0) * SLIT_AXIS.x + d.z * SLIT_AXIS.y) * inversesqrt(d2);
      if (ce > 0.0 && cb > 0.0) st += ce * pow(cb, SLIT_LOBE) / d2;
    }
    vec3 St = SLIT_COL * (SLIT_RAD * 4.0 * SLIT_HW * SLIT_HH * st / (4.0 * PI));
    St += giM.a * uAlbedo[f];
    float Ts = exp(-sigma * dt);
    inS += trans * S * (1.0 - Ts);
    inT += trans * St * (1.0 - Ts);
    trans *= Ts;
  }
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 frag = px + uJitter;
  vec3 rd = normalize(vec3((frag.x - uPrincipal.x) / uFocal, (frag.y - uPrincipal.y) / uFocal, 1.0));
  vec3 ro = uCamPos;

  float t = march(ro, rd, 80.0, 150);
  vec3 Ls = vec3(0.0), Lt = vec3(0.0);
  int fOut = clamp(floorOf(ro.y), 0, NF - 1);
  float depth = 80.0;
  vec3 dbg = vec3(0.0);

  if (t > 0.0) {
    depth = t;
    Surf s = makeSurf(ro + rd * t);
    fOut = s.f;
    vec3 V = -rd;
    if (s.mat == MAT_PANEL) {
      Ls = panelEmission(s.pl, s.f);
    } else if (s.mat == MAT_SKY) {
      Ls = skyEmission(s.pl, s.f);
    } else if (s.mat == MAT_LED) {
      Ls = uLedCol[s.f] * LED_RAD;
    } else if (s.mat == MAT_SLIT) {
      vec3 ds, dt;
      shadeSecondary(s, false, 1.0, ds, dt);
      Ls = ds;
      Lt = dt + SLIT_COL * SLIT_RAD;
    } else if (s.mat == MAT_SECTION || s.mat == MAT_PANELBODY) {
      Ls = vec3(SECTION_RAD);
    } else {
      vec3 n = s.n;
      vec3 alb = uAlbedo[s.f] * (s.mat == MAT_BACK ? BACK_ALB : endShade(s.pl));
      float NoV = max(dot(n, V), 1e-3);
      float rough = surfRough(s.f, n, s.mat);
      float specW = envBRDF(surfF0(s.f), rough, NoV) * mix(0.12, 1.0, smoothstep(0.2, 0.9, endShade(s.pl)));
      float ao = calcAO(s.pw, n);
      vec4 gi = giSample(s.f, s.pl, n) * giShade(s.pl);
      float ffp = panelFF(s.pl, n);
      float vis = ffp > 1e-4 ? (uQuality > 0 ? panelVisibility(s.pw, s.pl, n, sample2(px, 1)) : 1.0) : 0.0;
      vec3 Edir = PI * panelAvg(s.f) * (ffp * panelDirAtt(s.pl) * vis) + uLedCol[s.f] * (LED_RAD * ledIrradiance(s.pl, n));
      vec3 Es = Edir + gi.rgb * ao;
      vec3 Et = directSlit(s.pl, n) + gi.a * uAlbedo[s.f] * ao;
      vec3 kd = (1.0 - specW) * alb * (1.0 / PI);
      Ls = kd * Es;
      Lt = kd * Et;

      float alpha = max(rough * rough, 0.0008);
      vec3 R = reflect(-V, n);
      vec3 Rs = vec3(0.0), Rt = vec3(0.0);
      float tOcc = 80.0;
      if (uQuality > 0) {
      // ray traced glossy reflection
      vec3 T, B; basis(n, T, B);
      vec3 Vt = vec3(dot(V, T), dot(V, B), dot(V, n));
      vec3 Ht = sampleVNDF(Vt, alpha, sample2(px, 2));
      vec3 H = T * Ht.x + B * Ht.y + n * Ht.z;
      vec3 L = reflect(-V, H);
      if (dot(L, n) > 0.0) {
        vec3 o = s.pw + n * 0.004;
        float tr = marchSecondary(o, L, 60.0);
        if (tr > 0.0) {
          tOcc = tr;
          Surf h = makeSurf(o + L * tr);
          shadeSecondary(h, true, 1.0, Rs, Rt);
          if (h.mat == MAT_PANEL) Rs *= pow(max(L.z, 0.0), PANEL_EXP * 0.5);
          else if (h.mat == MAT_ROOM) Rs += panelMirror(h, -L);
          float fogT = exp(-hazeSigma(s.f, s.pl) * tr);
          Rs *= fogT; Rt *= fogT;
        } else if (L.z < 0.0) {
          Surf h = frontSurf(o, L);
          shadeSecondary(h, true, 1.0, Rs, Rt);
        }
      }
      } else {
        // fallback: blurred environment from the GI volume + analytic panel mirror
        vec4 gr = giSample(s.f, s.pl, R);
        Rs = gr.rgb * (1.0 / PI) + panelMirror(s, V);
        Rt = gr.a * uAlbedo[s.f] * (1.0 / PI);
      }
      float sig = 1.5 * alpha + 0.004;
      Rs += ledGlow(s.pl, R, tOcc, s.f, sig);
      Ls += specW * Rs;
      Lt += specW * Rt;

      if (uDebug == 1) dbg = alb;
      else if (uDebug == 2) dbg = n * 0.5 + 0.5;
      else if (uDebug == 3) dbg = kd * Edir;
      else if (uDebug == 4) dbg = kd * gi.rgb * ao;
      else if (uDebug == 5) dbg = specW * Rs;
      else if (uDebug == 6) dbg = vec3(ao);
      else if (uDebug == 7) dbg = vec3(vis);
    }
  }

  vec3 inS, inT; float trans;
  fogIntegrate(ro, rd, depth, px, inS, inT, trans);
  Ls = Ls * trans + inS;
  Lt = Lt * trans + inT;
  if (uDebug > 0) { Ls = dbg; Lt = vec3(0.0); }
  outStatic = vec4(Ls, depth);
  outSlit = vec4(Lt, float(fOut));
}
`;

  // ------------------------------------------------------------------ probe update pass
  const probePass = /* glsl */ `
uniform sampler2D uProbePrev;
uniform int uProbeFloor;
uniform float uProbeAlpha;
uniform int uProbeRays;

out vec4 outProbe;

vec4 giSample(int f, vec3 pl, vec3 n) { return probeIrr(uProbePrev, pl, n); }
` + shading + /* glsl */ `

const vec3 PDIRS[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int d = tc.x / PNX, i = tc.x % PNX, k = tc.y / PNY, j = tc.y % PNY;
  int f = uProbeFloor;
  vec3 pl = PROBE_ORIGIN + vec3(float(i), float(j), float(k)) * PROBE_SPACING;
  vec3 pw = pl + vec3(0.0, float(f) * FLOOR_H, 0.0);
  // push probes that sit inside geometry back into the room
  for (int it = 0; it < 8; it++) {
    float dist = map(pw);
    if (dist > 0.22) break;
    vec3 g = calcNormal(pw);
    pw += g * (0.25 - dist);
  }
  vec3 axis = PDIRS[d];
  uint seed = uint(tc.x * 7919 + tc.y * 104729) ^ (uint(uFrame) * 2654435761u);
  vec3 sumS = vec3(0.0), sumT = vec3(0.0);
  for (int r = 0; r < 64; r++) {
    if (r >= uProbeRays) break;
    vec2 u = vec2(rand01(seed), rand01(seed));
    vec3 w = cosineSample(axis, u);
    float t = march(pw, w, 40.0, 96);
    Surf s;
    if (t > 0.0) s = makeSurf(pw + w * t);
    else if (w.z < 0.0) s = frontSurf(pw, w);
    else continue;
    float vis = 1.0;
    if (s.mat == MAT_ROOM || s.mat == MAT_BACK || s.mat == MAT_LED || s.mat == MAT_SLIT) {
      vis = panelFF(s.pl, s.n) > 1e-4 ? panelVisibility(s.pw, s.pl, s.n, vec2(rand01(seed), rand01(seed))) : 0.0;
    }
    vec3 Ls, Lt;
    shadeSecondary(s, false, vis, Ls, Lt);
    sumS += Ls; sumT += Lt;
  }
  float inv = PI / float(max(uProbeRays, 1));
  vec3 Es = sumS * inv, Et = sumT * inv;
  vec3 alb = uAlbedo[f];
  float tcoef = dot(Et, alb) / max(dot(alb, alb), 1e-6);
  vec4 prev = texelFetch(uProbePrev, tc, 0);
  outProbe = mix(prev, vec4(Es, tcoef), uProbeAlpha);
}
`;

  // ------------------------------------------------------------------ fullscreen vertex shader
  const fullscreenVS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  // ------------------------------------------------------------------ temporal accumulation
  const taaPass = /* glsl */ `
uniform sampler2D uCur0;
uniform sampler2D uCur1;
uniform sampler2D uHist0;
uniform sampler2D uHist1;
uniform vec3 uCamPos;
uniform vec3 uPrevCamPos;
uniform float uFocal;
uniform vec2 uPrincipal;
uniform vec2 uRes;
uniform float uAlpha;
uniform float uHistValid;
uniform float uClampGamma;

layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;

vec3 toYCoCg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

vec3 clipToBox(vec3 h, vec3 mu, vec3 sig) {
  vec3 lo = mu - sig, hi = mu + sig;
  vec3 c = 0.5 * (lo + hi), e = 0.5 * (hi - lo) + 1e-5;
  vec3 v = h - c;
  vec3 a = abs(v / e);
  float m = max(a.x, max(a.y, a.z));
  return m > 1.0 ? c + v / m : h;
}

void main() {
  ivec2 ic = ivec2(gl_FragCoord.xy);
  vec4 c0 = texelFetch(uCur0, ic, 0);
  vec4 c1 = texelFetch(uCur1, ic, 0);

  vec3 m0 = vec3(0.0), q0 = vec3(0.0), m1 = vec3(0.0), q1 = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 sc = clamp(ic + ivec2(x, y), ivec2(0), ivec2(uRes) - 1);
    vec3 a = toYCoCg(texelFetch(uCur0, sc, 0).rgb);
    vec3 b = toYCoCg(texelFetch(uCur1, sc, 0).rgb);
    m0 += a; q0 += a * a; m1 += b; q1 += b * b;
  }
  m0 /= 9.0; q0 /= 9.0; m1 /= 9.0; q1 /= 9.0;
  vec3 s0 = sqrt(max(q0 - m0 * m0, 0.0)) * uClampGamma;
  vec3 s1 = sqrt(max(q1 - m1 * m1, 0.0)) * uClampGamma;

  // reproject (camera only translates)
  vec2 px = gl_FragCoord.xy;
  vec3 rd = normalize(vec3((px.x - uPrincipal.x) / uFocal, (px.y - uPrincipal.y) / uFocal, 1.0));
  vec3 wp = uCamPos + rd * c0.a;
  vec3 pv = wp - uPrevCamPos;
  vec2 ppx = uPrincipal + uFocal * pv.xy / max(pv.z, 1e-3);
  vec2 puv = ppx / uRes;
  float valid = uHistValid;
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) valid = 0.0;

  vec3 h0 = texture(uHist0, puv).rgb;
  vec3 h1 = texture(uHist1, puv).rgb;
  h0 = fromYCoCg(clipToBox(toYCoCg(h0), m0, s0));
  h1 = fromYCoCg(clipToBox(toYCoCg(h1), m1, s1));
  float a = valid > 0.5 ? uAlpha : 1.0;
  out0 = vec4(max(mix(h0, c0.rgb, a), 0.0), c0.a);
  out1 = vec4(max(mix(h1, c1.rgb, a), 0.0), c1.a);
}
`;

  // ------------------------------------------------------------------ combine + depth sweep
  // Depth Sweep after DepthVideo / selfish-design: the corridor depth is cut into N layers, an
  // eased pulse travels through them (wrapping), the layer masks are feathered, and the swept
  // layers are recoloured with the floor's gradient (strip B) and glow. The geometry gives exact
  // depth, so it also lights the haze inside each layer (analytic slab integral along the ray).
  const combinePass = /* glsl */ `
uniform sampler2D uHist0;
uniform sampler2D uHist1;
uniform sampler2D uLut;
uniform float uPulse;
uniform vec4 uFloorQ[NF];      // x: sweep on
uniform vec3 uCamPos;
uniform float uFocal;
uniform vec2 uPrincipal;
uniform float uSweepPhase;     // 0..1 position of the pulse in the loop
uniform float uSweepLayers;
uniform float uSweepWidth;     // pulse width as a share of the loop
uniform float uSweepFeather;   // soft edge, in layer units (0..0.5)
uniform float uSweepGain;
uniform float uSweepAir;
out vec4 outColor;

const float Z_START = 1.2;
const float Z_STOP = 17.05;
const float FLOOR_H = 5.2;

vec3 gradB(int f, float t) { return textureLod(uLut, vec2(t, (float(f * 2 + 1) + 0.5) / float(NF * 2)), 0.0).rgb; }
float acesInv(float y) {
  y = min(y, 0.985);
  float a = 2.51 - 2.43 * y, b = 0.03 - 0.59 * y, c = -0.14 * y;
  return (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
}
vec3 displayToHdr(vec3 c) { float m = max(max(c.r, c.g), max(c.b, 1e-4)); return c * (acesInv(m) / m); }

float easeInOut(float x) { return x * x * (3.0 - 2.0 * x); }
// eased tent centred on layer i, wrapping around the loop
float layerPulse(float i) {
  float diff = uSweepPhase - (i + 0.5) / uSweepLayers;
  diff -= floor(diff + 0.5);
  float hw = 0.5 * uSweepWidth;
  float ad = abs(diff);
  return ad >= hw ? 0.0 : easeInOut(1.0 - ad / hw);
}
// feathered box for layer j (the masks of neighbouring layers sum to one)
float layerMask(float x, float j) {
  float fe = uSweepFeather;
  return smoothstep(j - fe, j + fe, x) - smoothstep(j + 1.0 - fe, j + 1.0 + fe, x);
}
float sweepAt(float zn) {
  float x = zn * uSweepLayers;
  float l = floor(x);
  float a = 0.0;
  for (int k = -1; k <= 1; k++) {
    float j = l + float(k);
    if (j < 0.0 || j >= uSweepLayers) continue;
    a += layerPulse(j) * layerMask(x, j);
  }
  return a;
}
vec3 bandColour(int f, float s) { return displayToHdr(gradB(f, 0.5 + 0.5 * s)); }

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uHist0, c, 0);
  vec4 b = texelFetch(uHist1, c, 0);
  int f = clamp(int(b.a + 0.5), 0, NF - 1);
  vec3 col = a.rgb * uFloorP[f].x + b.rgb * (uFloorP[f].w * uPulse);

  if (uFloorQ[f].x > 0.5) {
    vec3 rd = normalize(vec3((gl_FragCoord.x - uPrincipal.x) / uFocal, (gl_FragCoord.y - uPrincipal.y) / uFocal, 1.0));
    vec3 wp = uCamPos + rd * a.a;
    float L = Z_STOP - Z_START;
    float ly = wp.y - float(f) * FLOOR_H;
    float zn = (wp.z - Z_START) / L;
    if (zn > 0.0 && zn < 1.03 && ly > -0.05 && ly < 4.7) {
      float sw = sweepAt(min(zn, 0.9999));
      vec3 sc = bandColour(f, sw);
      col = mix(col, sc * 0.5, 0.3 * sw) + sc * (uSweepGain * sw);
    }
    // haze inside the swept layers along the view ray
    float z0 = max(Z_START, uCamPos.z), z1 = min(wp.z, Z_STOP);
    if (z1 > z0 && rd.z > 1e-3) {
      float N = uSweepLayers;
      float centre = floor(uSweepPhase * N);
      vec3 air = vec3(0.0);
      for (int k = -2; k <= 2; k++) {
        float j = centre + float(k);
        j -= N * floor(j / N);
        float p = layerPulse(j);
        if (p <= 0.0) continue;
        float za = Z_START + j * L / N;
        float ov = max(0.0, min(z1, za + L / N) - max(z0, za));
        air += bandColour(f, p) * (p * ov);
      }
      col += air * ((0.02 + 0.07 * uFloorP[f].z) * uSweepAir / rd.z);
    }
  }
  outColor = vec4(col, float(f));
}
`;

  // ------------------------------------------------------------------ bloom
  const bloomDown = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uDstRes;
uniform int uFirst;
out vec4 outColor;
vec3 karis(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b)) * 0.25); }
void main() {
  vec2 uv = gl_FragCoord.xy / uDstRes;
  vec2 t = uSrcTexel;
  vec3 a = texture(uSrc, uv + t * vec2(-2, 2)).rgb, b = texture(uSrc, uv + t * vec2(0, 2)).rgb, c = texture(uSrc, uv + t * vec2(2, 2)).rgb;
  vec3 d = texture(uSrc, uv + t * vec2(-2, 0)).rgb, e = texture(uSrc, uv).rgb, f = texture(uSrc, uv + t * vec2(2, 0)).rgb;
  vec3 g = texture(uSrc, uv + t * vec2(-2, -2)).rgb, h = texture(uSrc, uv + t * vec2(0, -2)).rgb, i = texture(uSrc, uv + t * vec2(2, -2)).rgb;
  vec3 j = texture(uSrc, uv + t * vec2(-1, 1)).rgb, k = texture(uSrc, uv + t * vec2(1, 1)).rgb;
  vec3 l = texture(uSrc, uv + t * vec2(-1, -1)).rgb, m = texture(uSrc, uv + t * vec2(1, -1)).rgb;
  vec3 col;
  if (uFirst == 1) {
    col = karis((j + k + l + m) * 0.25) * 0.5 + karis((a + b + d + e) * 0.25) * 0.125 + karis((b + c + e + f) * 0.25) * 0.125
        + karis((d + e + g + h) * 0.25) * 0.125 + karis((e + f + h + i) * 0.25) * 0.125;
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(col, 1.0);
}
`;

  const bloomUp = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uDstRes;
uniform float uRadius;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uDstRes;
  vec2 t = uSrcTexel * uRadius;
  vec3 c = texture(uSrc, uv).rgb * 4.0;
  c += (texture(uSrc, uv + vec2(-t.x, 0)).rgb + texture(uSrc, uv + vec2(t.x, 0)).rgb +
        texture(uSrc, uv + vec2(0, -t.y)).rgb + texture(uSrc, uv + vec2(0, t.y)).rgb) * 2.0;
  c += texture(uSrc, uv + vec2(-t.x, -t.y)).rgb + texture(uSrc, uv + vec2(t.x, -t.y)).rgb +
       texture(uSrc, uv + vec2(-t.x, t.y)).rgb + texture(uSrc, uv + vec2(t.x, t.y)).rgb;
  outColor = vec4(c / 16.0, 1.0);
}
`;

  // ------------------------------------------------------------------ final: upscale, bloom, tone map
  const finalPass = /* glsl */ `
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform sampler2D uLut;
uniform float uGrade;
uniform float uLift;
uniform vec2 uOutRes;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uFade;
out vec4 outColor;

// Catmull-Rom upsampling (9 taps)
vec3 sampleCatmull(sampler2D tex, vec2 uv) {
  vec2 size = vec2(textureSize(tex, 0));
  vec2 sp = uv * size;
  vec2 tp = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 tc12 = (tp + w2 / w12) / size;
  vec2 tc0 = (tp - 1.0) / size;
  vec2 tc3 = (tp + 2.0) / size;
  vec3 r = texture(tex, vec2(tc12.x, tc0.y)).rgb * (w12.x * w0.y)
         + texture(tex, vec2(tc0.x, tc12.y)).rgb * (w0.x * w12.y)
         + texture(tex, vec2(tc12.x, tc12.y)).rgb * (w12.x * w12.y)
         + texture(tex, vec2(tc3.x, tc12.y)).rgb * (w3.x * w12.y)
         + texture(tex, vec2(tc12.x, tc3.y)).rgb * (w12.x * w3.y);
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, 0.0);
}

float acesFit(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

vec3 tonemap(vec3 c) {
  // hue-preserving: compress the largest channel, then roll very bright light towards white
  float m = max(c.r, max(c.g, c.b));
  if (m <= 1e-6) return vec3(0.0);
  float tm = acesFit(m);
  vec3 o = c * (tm / m);
  float wt = smoothstep(1.4, 9.0, m) * 0.45;
  return mix(o, vec3(tm), wt);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uOutRes;
  vec3 hdr = sampleCatmull(uHdr, uv);
  vec3 bloom = texture(uBloom, uv).rgb;
  hdr = mix(hdr, bloom * (1.0 / 6.0), uBloomStrength);
  vec3 c = tonemap(hdr * uExposure);
  // soft gradient grade: colour from the floor's gradient at this tone, brightness kept
  int f = clamp(int(textureLod(uHdr, uv, 0.0).a + 0.5), 0, NF - 1);
  float rowA = (float(f * 2) + 0.5) / float(NF * 2);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 g = textureLod(uLut, vec2(1.0 - clamp(pow(lum, 0.75) * 1.1, 0.0, 1.0), rowA), 0.0).rgb;
  float gl = dot(g, vec3(0.2126, 0.7152, 0.0722));
  vec3 gs = min(g * (lum / max(gl, 0.02)), vec3(1.0));
  c = mix(c, gs, uGrade);
  // lifted, tinted shadows instead of black
  vec3 floorTint = textureLod(uLut, vec2(0.9, rowA), 0.0).rgb;
  c = c * (1.0 - uLift) + floorTint * uLift;
  vec2 q = uv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  c = toSRGB(clamp(c, 0.0, 1.0));
  c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(c * uFade, 1.0);
}
`;

  window.AtriumShaders = {
    fullscreenVS,
    main: header + common + mainPass,
    probe: header + common + probePass,
    taa: header + taaPass,
    combine: header + '#define NF 8\nuniform vec4 uFloorP[NF];\n' + combinePass,
    bloomDown: header + bloomDown,
    bloomUp: header + bloomUp,
    final: header + '#define NF 8\nfloat ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }\n' + finalPass,
  };
})();

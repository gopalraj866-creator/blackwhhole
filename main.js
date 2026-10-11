import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ===========================================================================
//  Physical constants (CODATA / IAU nominal values)
// ===========================================================================
const K = {
  GMsun_c2_km: 1.476625,        // GM☉/c²  [km]
  GMsun_c3_s: 4.925491e-6,      // GM☉/c³  [s]
  c_kms: 299792.458,
  AU_km: 149597870.7,
  pc_km: 3.0856776e13,
  ly_per_pc: 3.261564,
  uas_per_rad: 206264806247.1,  // micro-arcseconds per radian
};

// ===========================================================================
//  PUBLISHED MEASUREMENTS  (each value carries its source)
// ===========================================================================
const PRESETS = {
  sgra: {
    name: "Sagittarius A*",
    sub: "Supermassive black hole · centre of the Milky Way",
    massSun: 4.297e6,            // GRAVITY stellar orbits, as quoted in EHT Paper I
    distPc: 8277,                // GRAVITY stellar orbits, as quoted in EHT Paper I
    distText: "≈ 8.277 kpc  (≈ 27,000 ly)",
    measured: [
      ["Mass", "4.297 ± 0.013 × 10⁶ M☉", "GRAVITY stellar orbits (VLTI), quoted in EHT Sgr A* Paper I"],
      ["Distance", "≈ 8.277 kpc  (≈ 27,000 ly)", "GRAVITY stellar orbits, quoted in EHT Sgr A* Paper I"],
      ["EHT ring diameter", "51.8 ± 2.3 μas", "EHT Sgr A* Paper I, ApJL 930, L12 (2022)"],
      ["EHT shadow diameter", "48.7 ± 7.0 μas", "EHT Sgr A* Paper I, Table 1"],
      ["Viewing angle", "i > 50° disfavoured", "EHT Sgr A* Paper I, model comparison"],
      ["Spin", "non-spinning disfavoured", "EHT Sgr A* Paper I, model comparison"],
      ["S2 star: GR precession", "f_SP = 1.10 ± 0.19", "GRAVITY, A&A 636, L5 (2020)"],
    ],
    note: "Sgr A* is thought to spin; this simulation uses a non-rotating (Schwarzschild) black hole as a simplification.",
  },
  m87: {
    name: "M87*",
    sub: "Supermassive black hole · centre of galaxy Messier 87",
    massSun: 6.5e9,              // EHT Paper VI
    distPc: 16.8e6,              // EHT Paper VI (assumed distance)
    distText: "16.8 (+0.8 / −0.7) Mpc",
    measured: [
      ["Mass", "6.5 ± 0.2 (stat) ± 0.7 (sys) × 10⁹ M☉", "EHT M87* Paper VI, ApJL 875, L6 (2019)"],
      ["Distance (assumed)", "16.8 (+0.8 / −0.7) Mpc", "EHT M87* Paper VI"],
      ["EHT ring diameter", "42 ± 3 μas", "EHT M87* Paper VI"],
    ],
    note: "The viewing angle in this simulation is a camera setting, not an M87* measurement. Spin is not modelled.",
  },
};

// ===========================================================================
//  Simulation settings (visual — NOT measurements)
// ===========================================================================
const params = new URLSearchParams(location.search);
const MANUAL = params.get("manual") === "1";                // deterministic frame-by-frame mode (video render)
document.body.classList.toggle("manual", MANUAL);

const R_IN = 3.0;                       // ISCO of a Schwarzschild black hole = 3 r_s
const R_OUT = 15.0;                     // outer visual edge of the disk
const T_PEAK = 6200;                    // illustrative colour temperature scale [K]
const ISCO_SCREEN_PERIOD = 14.0;        // seconds on screen for one ISCO orbit at speed 1.0×
const ISCO_PERIOD_RS = 2 * Math.PI * Math.pow(3, 1.5) / Math.sqrt(0.5);   // in r_s / c   (≈ 46.2)
const TIME_RATE = ISCO_PERIOD_RS / ISCO_SCREEN_PERIOD;                    // sim time (r_s/c) per real second at 1×
const B_CRIT = 3 * Math.sqrt(3) / 2;    // critical impact parameter (shadow radius) in r_s
const FOV_DEG = 42;
const TAN_HALF = Math.tan((FOV_DEG * Math.PI) / 360);

const state = {
  preset: "sgra",
  yaw: 0.6, pitch: THREE.MathUtils.degToRad(15), dist: 21,        // camera (r_s units)
  tYaw: 0.6, tPitch: THREE.MathUtils.degToRad(15), tDist: 21,
  speed: 1, bright: 1, auto: !MANUAL, labels: true, stars: true, data: true, paused: false,
  quality: "med", scale: 1, diskTime: 0, shift: 0,
};
if (PRESETS[params.get("preset")]) state.preset = params.get("preset");
if (params.get("labels") === "0") state.labels = false;
if (params.get("data") === "0") state.data = false;
if (!MANUAL && innerWidth < 900) state.data = false;

const STEPS = { low: 110, med: 190, high: 300 };
const PHI_MAX = 10.5;

// ===========================================================================
//  Renderer: full-screen ray-marcher + bloom
// ===========================================================================
const canvas = document.getElementById("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setClearColor(0x000000, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes, uCenter;
uniform vec3 uCam, uRight, uUp, uFwd;
uniform float uTanHalf, uTime, uBright, uStars, uRin, uROut, uTpeak, uH;
uniform int uSteps;
varying vec2 vUv;
#define MAXSTEPS 320
#define PI 3.14159265359

float hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 4; k++){ s += a * vnoise(p); p = p * 2.03 + vec3(7.1, 3.7, 1.3); a *= 0.5; } return s / 0.9375; }

// approximate black-body colour (linear RGB, max-normalised)
vec3 blackbody(float T){
  float t = clamp(T, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  float g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  float b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  vec3 c = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  return pow(c, vec3(2.2));
}

vec3 starfield(vec3 d){
  vec3 p = d * 80.0, ip = floor(p), f = fract(p) - 0.5;
  float h = hash13(ip);
  if (h < 0.965) return vec3(0.0);
  vec3 off = (vec3(hash13(ip + 1.7), hash13(ip + 5.1), hash13(ip + 9.3)) - 0.5) * 0.5;
  float dd = length(f - off);
  float b = (1.0 - smoothstep(0.0, 0.11, dd)) * (0.25 + 0.75 * hash13(ip + 3.3));
  vec3 tint = mix(vec3(1.0, 0.82, 0.65), vec3(0.7, 0.82, 1.0), hash13(ip + 8.8));
  return tint * b * 1.6;
}

vec2 deriv(vec2 s){ return vec2(s.y, -s.x + 1.5 * s.x * s.x); }   // u'' + u = (3/2) r_s u²   (r_s = 1)

void main(){
  vec2 uv = (gl_FragCoord.xy - uCenter) / uRes.y * 2.0;
  vec3 d = normalize(uFwd + uTanHalf * (uv.x * uRight + uv.y * uUp));

  float r0 = length(uCam);
  vec3 e1 = uCam / r0;
  float cosA = dot(d, e1);
  vec3 dp = d - cosA * e1;
  float sinA = max(length(dp), 1e-4);
  vec3 e2 = length(dp) > 1e-5 ? dp / sinA : normalize(cross(e1, vec3(0.0, 1.0, 0.0)));

  float u0 = 1.0 / r0;
  float sfObs = sqrt(1.0 - u0);
  vec2 st = vec2(u0, -u0 * sfObs * cosA / sinA);       // (u, du/dphi)

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float c = 1.0, s = 0.0;                              // cos(phi), sin(phi)
  float ch = cos(uH), sh = sin(uH);
  float sgPrev = e1.y;
  float umax = st.x;
  bool captured = false;
  int nCross = 0;

  for (int i = 0; i < MAXSTEPS; i++){
    if (i >= uSteps) break;
    vec2 sPrev = st;
    vec2 k1 = deriv(st);
    vec2 k2 = deriv(st + 0.5 * uH * k1);
    vec2 k3 = deriv(st + 0.5 * uH * k2);
    vec2 k4 = deriv(st + uH * k3);
    st += uH / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
    float cn = c * ch - s * sh, sn = s * ch + c * sh; c = cn; s = sn;

    float sg = e1.y * c + e2.y * s;                    // height above disk plane (sign)
    if (sg * sgPrev < 0.0 && trans > 0.01){
      float t = sgPrev / (sgPrev - sg);
      float uc = mix(sPrev.x, st.x, t), wc = mix(sPrev.y, st.y, t);
      float rc = 1.0 / uc;
      if (rc > 1.15 && rc < uROut){
        bool plunge = rc < uRin;
        float phic = -uH * (1.0 - t);                   // offset from current phi
        float cc = c * cos(phic) - s * sin(phic), sc = s * cos(phic) + c * sin(phic);
        vec3 rhat = cc * e1 + sc * e2;
        vec3 phat = -sc * e1 + cc * e2;
        float f = max(1.0 - uc, 1e-4), sf = sqrt(f);
        float drdphi = -wc / (uc * uc);
        vec3 dloc = normalize((drdphi / sf) * rhat + rc * phat);   // marching direction (static frame)
        vec3 khat = -dloc;                                        // photon direction towards observer
        vec3 vdir = normalize(vec3(rhat.z, 0.0, -rhat.x));         // disk rotation direction
        float beta = sqrt(0.5 / max(max(rc, uRin) - 1.0, 0.01));              // circular-orbit speed (static observer)
        float gam = inversesqrt(1.0 - beta * beta);
        float g = (sf / sfObs) / (gam * (1.0 - beta * dot(vdir, khat)));   // Doppler + gravitational shift

        float x = max(rc, uRin) / uRin;
        float prof = plunge ? 0.34 * pow((rc - 1.0) / (uRin - 1.0), 2.2)
                            : pow(x, -0.75) * pow(max(1.0 - inversesqrt(x), 0.0), 0.25) / 0.4875;   // Novikov–Thorne-like T(r)
        float om = 0.70710678 / (rc * sqrt(rc));                    // Keplerian angular speed
        float pd = atan(rhat.z, rhat.x) - om * uTime;
        vec3 q = vec3(cos(pd) * 3.0, sin(pd) * 3.0, rc * 1.7);
        float n = fbm(q);
        float fine = fbm(q * 2.7 + 11.0);
        float tex = 0.10 + 2.1 * pow(n, 1.7) * (0.5 + 0.95 * fine);
        if (nCross > 0) tex = mix(tex, 0.85 + 0.45 * n, min(1.0, 0.65 * float(nCross)));   // higher-order images: smoother (avoids aliasing)
        nCross++;
        float edge = plunge ? smoothstep(1.15, 1.6, rc) * 0.7 : 1.0 - smoothstep(uROut - 4.0, uROut, rc);
        float Tobs = uTpeak * prof * g;
        float I = pow(prof * g, 4.0) * tex * uBright * 0.55;
        vec3 em = blackbody(Tobs) * I;
        float alpha = 0.80 * edge;
        acc += trans * alpha * em;
        trans *= (1.0 - alpha);
      }
    }
    sgPrev = sg;
    umax = max(umax, st.x);
    if (st.x >= 1.0){ captured = true; break; }
    if (st.x < 0.005 && st.y < 0.0) break;               // escaped to r > 200 r_s
  }

  if (!captured){
    // thin photon-ring glow from rays that skim the photon sphere (u = 2/3)
    float dm = max(2.0 / 3.0 - umax, 0.0);
    acc += trans * vec3(1.0, 0.86, 0.68) * 0.30 * exp(-dm * 95.0) * uBright;
    if (uStars > 0.5) acc += trans * starfield(normalize(c * e1 + s * e2));
  }
  gl_FragColor = vec4(acc, 1.0);
}
`;

const bhMaterial = new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
  uniforms: {
    uRes: { value: new THREE.Vector2(1280, 720) }, uCenter: { value: new THREE.Vector2(640, 360) },
    uCam: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() },
    uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
    uTanHalf: { value: TAN_HALF }, uTime: { value: 0 }, uBright: { value: 1 }, uStars: { value: 1 },
    uRin: { value: R_IN }, uROut: { value: R_OUT }, uTpeak: { value: T_PEAK },
    uH: { value: PHI_MAX / STEPS.med }, uSteps: { value: STEPS.med },
  },
});
const scene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bhMaterial));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, quadCam));
const bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.42, 0.55, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const PANEL_SHIFT = 165;   // px the image moves left when the data panel is open
function applyCenter() {
  const u = bhMaterial.uniforms, k = u.uRes.value.x / innerWidth;
  u.uCenter.value.set(u.uRes.value.x / 2 - state.shift * k, u.uRes.value.y / 2);
}
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * state.scale;
  const w = Math.max(2, Math.floor(innerWidth * dpr)), h = Math.max(2, Math.floor(innerHeight * dpr));
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(1);
  composer.setSize(w, h);
  bhMaterial.uniforms.uRes.value.set(w, h);
  applyCenter();
}
addEventListener("resize", resize);

function setQuality(q) {
  state.quality = q;
  bhMaterial.uniforms.uSteps.value = STEPS[q];
  bhMaterial.uniforms.uH.value = PHI_MAX / STEPS[q];
}

// ===========================================================================
//  Camera
// ===========================================================================
const camPos = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), camFwd = new THREE.Vector3();
function updateCamera() {
  const { yaw, pitch, dist } = state;
  camPos.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)).multiplyScalar(dist);
  camFwd.copy(camPos).normalize().negate();
  camRight.crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).normalize();
  camUp.crossVectors(camRight, camFwd).normalize();
  const u = bhMaterial.uniforms;
  u.uCam.value.copy(camPos); u.uRight.value.copy(camRight); u.uUp.value.copy(camUp); u.uFwd.value.copy(camFwd);
}

// ===========================================================================
//  CPU ray tracer (same geodesic equation) — used to place the labels
// ===========================================================================
function traceFirstDiskRadius(r0, camP, camR, camU, camF, xNdc) {
  const d = camF.clone().addScaledVector(camR, TAN_HALF * xNdc).normalize();
  const e1 = camP.clone().divideScalar(r0);
  const cosA = d.dot(e1);
  const dp = d.clone().addScaledVector(e1, -cosA);
  const sinA = Math.max(dp.length(), 1e-4);
  const e2 = dp.divideScalar(sinA);
  const u0 = 1 / r0;
  let u = u0, w = -u0 * Math.sqrt(1 - u0) * cosA / sinA;
  const h = 0.02;
  let phi = 0, sgPrev = e1.y;
  for (let i = 0; i < 600; i++) {
    const f = (a, b) => [b, -a + 1.5 * a * a];
    const k1 = f(u, w), k2 = f(u + 0.5 * h * k1[0], w + 0.5 * h * k1[1]);
    const k3 = f(u + 0.5 * h * k2[0], w + 0.5 * h * k2[1]), k4 = f(u + h * k3[0], w + h * k3[1]);
    const un = u + h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const wn = w + h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    phi += h;
    const sg = e1.y * Math.cos(phi) + e2.y * Math.sin(phi);
    if (sg * sgPrev < 0) { const t = sgPrev / (sgPrev - sg); return 1 / (u + (un - u) * t); }
    sgPrev = sg; u = un; w = wn;
    if (u >= 1) return null;
    if (u < 0.004 && w < 0) return null;
  }
  return null;
}
// screen-x (NDC, in units of half-height) where the first disk crossing has radius rTarget on side sgn (+1 right / −1 left)
function findDiskX(rTarget, sgn, xStart) {
  let prevX = xStart, prevR = null;
  for (let x = xStart; x < 2.4; x += 0.004) {
    const r = traceFirstDiskRadius(state.dist, camPos, camRight, camUp, camFwd, sgn * x);
    if (r !== null && prevR !== null && prevR < rTarget && r >= rTarget) return prevX + (x - prevX) * (rTarget - prevR) / (r - prevR);
    if (r !== null) { prevR = r; prevX = x; }
  }
  return null;
}

// ===========================================================================
//  Overlay (scientific labels)
// ===========================================================================
const svg = document.getElementById("overlay");
const NS = "http://www.w3.org/2000/svg";
const mk = (tag, cls) => { const e = document.createElementNS(NS, tag); if (cls) e.setAttribute("class", cls); svg.appendChild(e); return e; };
const L = {
  ring: mk("circle", "ring"),
  ringLn: mk("polyline", "ln"), ringT: mk("text"), ringS: mk("text", "sub"),
  ehLn: mk("polyline", "ln"), ehDot: mk("circle", "dot"), ehT: mk("text"), ehS: mk("text", "sub"),
  iscoLn: mk("polyline", "ln"), iscoDot: mk("circle", "dot"), iscoT: mk("text"), iscoS: mk("text", "sub"),
  appLn: mk("polyline", "ln"), appDot: mk("circle", "dot"), appT: mk("text"), appS: mk("text", "sub"),
  recLn: mk("polyline", "ln"), recDot: mk("circle", "dot"), recT: mk("text"), recS: mk("text", "sub"),
};
L.ehDot.setAttribute("r", 2); L.iscoDot.setAttribute("r", 2.5); L.appDot.setAttribute("r", 2.5); L.recDot.setAttribute("r", 2.5);
let anchorCache = { key: "", isco: null, app: null, rec: null, appSide: 1 };
function setText(el, x, y, txt, anchor = "start") { el.setAttribute("x", x); el.setAttribute("y", y); el.setAttribute("text-anchor", anchor); el.textContent = txt; }
const setPoly = (el, pts) => el.setAttribute("points", pts.map((p) => p.join(",")).join(" "));

function updateLabels() {
  const on = state.labels;
  svg.style.display = on ? "block" : "none";
  if (!on) return;
  const W = innerWidth, H = innerHeight, cx = W / 2 - state.shift, cy = H / 2, r0 = state.dist;
  const sinA = B_CRIT * Math.sqrt(1 - 1 / r0) / r0;
  const rPx = (Math.tan(Math.asin(sinA)) / TAN_HALF) * (H / 2);
  L.ring.setAttribute("cx", cx); L.ring.setAttribute("cy", cy); L.ring.setAttribute("r", rPx);

  // shadow / photon ring label (upper-left of the ring)
  const a = (-135 * Math.PI) / 180, px = cx + rPx * Math.cos(a), py = cy + rPx * Math.sin(a);
  const tx = px - 46, ty = py - 34;
  setPoly(L.ringLn, [[px, py], [tx, ty], [tx - 150, ty]]);
  setText(L.ringT, tx - 150, ty - 6, "Shadow edge · photon ring");
  setText(L.ringS, tx - 150, ty + 14, "critical curve, ≈ 5.2 r_s across");

  // event horizon label (below the centre, leader line leaves the shadow)
  const hx = cx + rPx * 0.35, hy = cy + rPx * 0.35;
  const bx = cx + rPx * Math.cos(0.9) + 40, by = cy + rPx * Math.sin(0.9) + 44;
  L.ehDot.setAttribute("cx", cx); L.ehDot.setAttribute("cy", cy);
  setPoly(L.ehLn, [[cx, cy], [hx, hy], [bx, by], [bx + 150, by]]);
  setText(L.ehT, bx + 4, by - 6, "Event horizon · r = r_s");
  setText(L.ehS, bx + 4, by + 14, "inside the shadow · no light escapes");

  // disk anchors from CPU ray tracing (re-computed only when the view changes)
  const key = [state.dist.toFixed(1), state.pitch.toFixed(2), W, H, state.shift.toFixed(0)].join("|");
  if (key !== anchorCache.key) {
    anchorCache.key = key;
    const x0 = (rPx / (H / 2)) * 1.0 + 0.002;
    // which side approaches the observer? (disk rotates along  y × r)
    const P = camRight.clone().multiplyScalar(6);
    const vel = new THREE.Vector3(P.z, 0, -P.x);
    anchorCache.appSide = vel.dot(camPos.clone().sub(P)) > 0 ? 1 : -1;
    anchorCache.isco = findDiskX(R_IN * 1.02, -anchorCache.appSide, x0);
    anchorCache.app = findDiskX(7.5, anchorCache.appSide, x0);
    anchorCache.rec = findDiskX(7.5, -anchorCache.appSide, x0);
  }
  const place = (x, sgn, ln, dot, t, s, title, sub, dy, dx) => {
    // (W is the viewport width)
    if (x === null) { [ln, dot, t, s].forEach((e) => (e.style.display = "none")); return; }
    [ln, dot, t, s].forEach((e) => (e.style.display = ""));
    const ax = cx + sgn * x * (H / 2), ay = cy;
    dot.setAttribute("cx", ax); dot.setAttribute("cy", ay);
    let ex = ax + sgn * dx; const ey = ay + dy;
    const maxX = (state.data ? W - 350 : W - 24) - 190;
    if (sgn > 0) ex = Math.min(ex, maxX); else ex = Math.max(ex, 210);
    setPoly(ln, [[ax, ay], [ex, ey], [ex + sgn * 120, ey]]);
    const anchor = sgn > 0 ? "start" : "end";
    setText(t, ex + sgn * 4, ey - 6, title, anchor);
    setText(s, ex + sgn * 4, ey + 14, sub, anchor);
  };
  const side = anchorCache.appSide;
  place(anchorCache.isco, -side, L.iscoLn, L.iscoDot, L.iscoT, L.iscoS, "Inner disk edge · ISCO", "3 r_s · innermost stable orbit", 70, 26);
  place(anchorCache.app, side, L.appLn, L.appDot, L.appT, L.appS, "Approaching side", "Doppler-boosted: brighter, bluer", -70, 26);
  place(anchorCache.rec, -side, L.recLn, L.recDot, L.recT, L.recS, "Receding side", "Doppler-dimmed: fainter, redder", -70, 26);
}

// ===========================================================================
//  Data panel  (measured / derived / simulated)
// ===========================================================================
const dataEl = document.getElementById("data");
const fmt = (x, d = 3) => Number(x.toPrecision(d)).toLocaleString("en-US", { maximumFractionDigits: 6 });
function fmtTime(sec) {
  if (sec < 120) return fmt(sec, 3) + " s";
  if (sec < 7200) return fmt(sec / 60, 3) + " min";
  if (sec < 172800) return fmt(sec / 3600, 3) + " h";
  return fmt(sec / 86400, 3) + " days";
}
function derived(p) {
  const rs = 2 * K.GMsun_c2_km * p.massSun;                 // km
  const shadowKm = 2 * B_CRIT * rs;
  const thetaUas = (shadowKm / (p.distPc * K.pc_km)) * K.uas_per_rad;
  const iscoPeriodS = ISCO_PERIOD_RS * (rs / K.c_kms);
  return { rs, shadowKm, thetaUas, tCross: rs / K.c_kms, iscoPeriodS };
}
let liveRefs = {};
function buildDataPanel() {
  const p = PRESETS[state.preset], d = derived(p);
  const rsAU = d.rs / K.AU_km;
  const row = (a, b, src) => `<div class="row"><span>${a}</span><b>${b}</b></div>${src ? `<span class="src">${src}</span>` : ""}`;
  dataEl.innerHTML = `
  <div class="m"><h3>Measured<small>published observations</small></h3>
    ${p.measured.map((m) => row(m[0], m[1], m[2])).join("")}
  </div>
  <div class="d"><h3>Derived<small>computed here from the measured mass &amp; distance (Schwarzschild formulas)</small></h3>
    ${row("Horizon radius r_s = 2GM/c²", rsAU >= 0.01 ? `${fmt(d.rs / 1e6, 4)} million km (${fmt(rsAU, 3)} AU)` : `${fmt(d.rs / 1e6, 4)} million km`)}
    ${row("Photon sphere / ISCO", `1.5 r_s / 3 r_s`)}
    ${row("Shadow diameter (5.196 r_s)", `${fmt(d.shadowKm / 1e6, 4)} million km`)}
    ${row("Shadow angular size", `${fmt(d.thetaUas, 3)} μas`)}
    ${row("Light-crossing time of r_s", fmtTime(d.tCross))}
    ${row("Orbital period at ISCO", fmtTime(d.iscoPeriodS))}
  </div>
  <div class="s live"><h3>Simulated<small>visual model — not measured</small></h3>
    <div class="row"><span>Camera distance</span><b id="lvDist">—</b></div>
    <div class="row"><span>Viewing inclination</span><b id="lvInc">—</b></div>
    <div class="row"><span>Disk speed</span><b id="lvSpeed">—</b></div>
    <div class="row"><span>ISCO orbit on screen</span><b id="lvPeriod">—</b></div>
    <div class="row"><span>Time compression</span><b id="lvComp">—</b></div>
    <div class="row"><span>Spacetime</span><b>Schwarzschild (no spin)</b></div>
    <div class="row"><span>Disk</span><b>thin, T ∝ r<sup>−3/4</sup></b></div>
    <div class="row"><span>Colours · turbulence · glow</span><b>illustrative</b></div>
    <div class="note">${p.note}</div>
  </div>`;
  liveRefs = { dist: document.getElementById("lvDist"), inc: document.getElementById("lvInc"), speed: document.getElementById("lvSpeed"),
    period: document.getElementById("lvPeriod"), comp: document.getElementById("lvComp") };
  document.getElementById("bhName").textContent = p.name;
  document.getElementById("bhSub").textContent = p.sub;
  dataEl.classList.toggle("hidden", !state.data);
  document.body.classList.toggle("withdata", state.data);
}
let lastLive = 0;
function updateLive(now) {
  if (now - lastLive < 120 || !liveRefs.dist) return;
  lastLive = now;
  const p = PRESETS[state.preset], d = derived(p);
  const kmDist = state.dist * d.rs;
  liveRefs.dist.textContent = `${fmt(state.dist, 3)} r_s  (${kmDist >= 1e8 ? fmt(kmDist / K.AU_km, 3) + " AU" : fmt(kmDist / 1e6, 3) + " M km"})`;
  liveRefs.inc.textContent = `${fmt(90 - THREE.MathUtils.radToDeg(state.pitch), 3)}° (camera setting)`;
  liveRefs.speed.textContent = state.paused ? "paused" : `${state.speed.toFixed(2)}×`;
  const periodScreen = state.speed > 0 ? ISCO_SCREEN_PERIOD / state.speed : Infinity;
  liveRefs.period.textContent = isFinite(periodScreen) ? `${fmt(periodScreen, 3)} s` : "—";
  liveRefs.comp.textContent = isFinite(periodScreen) ? `1 s ≈ ${fmtTime(d.iscoPeriodS / periodScreen)} real` : "—";
}

// ===========================================================================
//  Controls
// ===========================================================================
const $ = (id) => document.getElementById(id);
const bar = $("bar"), hint = $("hint");
let lastInput = performance.now();
const touch = () => { lastInput = performance.now(); bar.classList.remove("dim"); hint.style.opacity = 1; };
window.addEventListener("pointermove", touch, { passive: true });
window.addEventListener("keydown", touch);
const clampPitch = (p) => Math.max(THREE.MathUtils.degToRad(-87), Math.min(THREE.MathUtils.degToRad(87), p));
const clampDist = (d) => Math.max(5.5, Math.min(400, d));

const pointers = new Map();
let pinchBase = 0;
canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); state.auto = false; $("bAuto").classList.remove("on"); touch(); if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchBase = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); touch();
  if (pointers.size === 1) { state.tYaw -= (e.clientX - prev[0]) * 0.005; state.tPitch = clampPitch(state.tPitch + (e.clientY - prev[1]) * 0.005); }
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const dd = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinchBase) state.tDist = clampDist(state.tDist * pinchBase / dd); pinchBase = dd; }
});
const up = (e) => { pointers.delete(e.pointerId); pinchBase = 0; };
canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); state.tDist = clampDist(state.tDist * Math.exp(e.deltaY * 0.0012)); touch(); }, { passive: false });
addEventListener("mousemove", touch);

function toggle(id, key, cb) {
  const b = $(id);
  const apply = () => { b.classList.toggle("on", state[key]); cb && cb(); };
  b.addEventListener("click", () => { state[key] = !state[key]; apply(); touch(); });
  apply();
  return () => { state[key] = !state[key]; apply(); };
}
const tAuto = toggle("bAuto", "auto");
const tLabels = toggle("bLabels", "labels");
const tStars = toggle("bStars", "stars", () => (bhMaterial.uniforms.uStars.value = state.stars ? 1 : 0));
const tData = toggle("bData", "data", () => { dataEl.classList.toggle("hidden", !state.data); document.body.classList.toggle("withdata", state.data); });
$("speed").addEventListener("input", (e) => { state.speed = parseFloat(e.target.value); $("speedV").textContent = state.speed.toFixed(1) + "×"; touch(); });
$("bright").addEventListener("input", (e) => { state.bright = parseFloat(e.target.value); bhMaterial.uniforms.uBright.value = state.bright; touch(); });
$("quality").addEventListener("change", (e) => { setQuality(e.target.value); touch(); });
$("preset").addEventListener("change", (e) => { state.preset = e.target.value; buildDataPanel(); anchorCache.key = ""; touch(); });
$("view").addEventListener("change", (e) => {
  const inc = { cinematic: 75, eht: 30, face: 5, edge: 88 }[e.target.value];
  state.tPitch = clampPitch(THREE.MathUtils.degToRad(90 - inc)); state.auto = false; $("bAuto").classList.remove("on"); touch();
});
addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "l") tLabels(); else if (k === "d") tData(); else if (k === "s") tStars(); else if (k === "a") tAuto();
  else if (k === " ") { state.paused = !state.paused; e.preventDefault(); }
  else if (k === "+" || k === "=") state.tDist = clampDist(state.tDist * 0.9);
  else if (k === "-") state.tDist = clampDist(state.tDist / 0.9);
  else if (k === "arrowleft") state.tYaw += 0.08; else if (k === "arrowright") state.tYaw -= 0.08;
  else if (k === "arrowup") state.tPitch = clampPitch(state.tPitch - 0.05); else if (k === "arrowdown") state.tPitch = clampPitch(state.tPitch + 0.05);
  touch();
});

// ===========================================================================
//  Main loop
// ===========================================================================
resize(); setQuality(params.get("q") === "high" ? "high" : params.get("q") === "low" ? "low" : "med");
$("quality").value = state.quality; $("preset").value = state.preset;
buildDataPanel();

const FIX_INC = params.get("inc"), FIX_DIST = params.get("dist");
function applyCinematic(T) {
  // seamless 120 s loop: slow dolly + inclination sweep + yaw (moves the lensed star field)
  const L = 120, a = (T / L) * Math.PI * 2;
  state.dist = state.tDist = 21 + 6 * Math.cos(a);
  state.pitch = state.tPitch = THREE.MathUtils.degToRad(15 + 12 * Math.sin(a) + 6 * Math.sin(2 * a));
  state.yaw = state.tYaw = 0.6 + a;
  if (FIX_INC !== null) state.pitch = state.tPitch = THREE.MathUtils.degToRad(90 - parseFloat(FIX_INC));
  if (FIX_DIST !== null) state.dist = state.tDist = parseFloat(FIX_DIST);
}
function renderOnce() {
  updateCamera(); applyCenter();
  bhMaterial.uniforms.uTime.value = state.diskTime;
  composer.render();
  updateLabels();
}
window.__ready = true;
window.__total = 120;
window.renderAt = (T) => {
  applyCinematic(T);
  state.shift = state.data ? PANEL_SHIFT : 0;
  state.diskTime = T * TIME_RATE * state.speed;
  renderOnce(); updateLive(1e9); return true;
};

let last = performance.now(), fpsAcc = 0, fpsN = 0, lowT = 0, highT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (state.auto) state.tYaw += dt * 0.05;
  if (state.auto) { state.tPitch += (THREE.MathUtils.degToRad(15 + 10 * Math.sin(now / 40000)) - state.tPitch) * Math.min(1, dt * 0.6); }
  const k = 1 - Math.exp(-dt * 8);
  state.shift += ((state.data && innerWidth > 900 ? PANEL_SHIFT : 0) - state.shift) * k;
  state.yaw += (state.tYaw - state.yaw) * k; state.pitch += (state.tPitch - state.pitch) * k; state.dist += (state.tDist - state.dist) * k;
  if (!state.paused) state.diskTime += dt * TIME_RATE * state.speed;
  renderOnce(); updateLive(now);

  // idle UI fade + adaptive resolution
  if (now - lastInput > 5000) { bar.classList.add("dim"); hint.style.opacity = 0; }
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 1) {
    const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    $("fps").textContent = `${fps.toFixed(0)} fps · ${(state.scale * 100).toFixed(0)}% res`;
    if (fps < 26) { lowT++; highT = 0; } else if (fps > 56) { highT++; lowT = 0; } else { lowT = highT = 0; }
    if (lowT >= 2 && state.scale > 0.35) { state.scale = Math.max(0.35, state.scale * 0.85); resize(); lowT = 0; }
    if (highT >= 5 && state.scale < 1) { state.scale = Math.min(1, state.scale * 1.12); resize(); highT = 0; }
  }
  requestAnimationFrame(frame);
}
if (!MANUAL) requestAnimationFrame(frame); else { applyCinematic(0); state.shift = state.data ? PANEL_SHIFT : 0; renderOnce(); updateLive(1e9); }

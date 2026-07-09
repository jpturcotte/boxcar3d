// src/sim/features.js — pure feature geometry (NO Rapier).
//
// Boulder hulls: each vertex is a Marsaglia-sampled unit direction (disk
// rejection + sqrt — the same trig-free construction generateFeatures uses
// for yaw) scaled by radius × a jitter factor. Vertices draw from
// new Rng(feature.seed).fork(i) — the trailing per-feature seed is exactly
// "PR #8's handle for hull-vertex jitter" (terrain.js), and per-vertex forks
// keep the rejection loop's variable draw count from ever shifting a sibling
// vertex (rule 1). Coordinates are Math.fround-quantized once, here, so the
// Rapier collider (f32) and the Three mesh share bit-identical vertices.
//
// The single source of truth for descriptor -> geometry: quaternions, boulder
// hull points, per-type collider shape parameters, and seating support
// samples. The adapter (physics/adapter.js) and the render scene (main.js)
// both consume these exact numbers so collider and mesh can never drift.
// terrain.js stays pure placement data and never imports this module (its
// locked fingerprints must not depend on realization geometry).
//
// Determinism (D7/F4): everything here is integer Rng draws, +, *, / and
// Math.sqrt — the only correctly-rounded IEEE-754 transcendental. Quaternions
// come from the half-angle identities, never Math.sin/cos:
//   w = sqrt((1 + cos)/2),  y = sign(sin) * sqrt((1 - cos)/2)
// Radicands are clamped at 0: a unit yaw can carry cos = 1 + ulp from its own
// normalization, and sqrt(-tiny) is NaN, which would poison the whole pose.

import { Rng } from './prng.js';

// sign with sgn(0) = +1: Math.sign(0) is 0, which would zero the sin(θ/2)
// term at yaw = 180° where it must be ±1.
const sgn = (v) => (v < 0 ? -1 : 1);

// Geometry knobs: they shape the realized collider, not where it goes (so
// they live here, not in terrain config, and cannot touch the locked terrain
// fingerprints). Validated fail-loud below — degenerate values would produce
// NaN poses or a null Rapier hull deep inside the adapter (F16).
export const FEATURE_GEOMETRY_DEFAULTS = Object.freeze({
  boulderVertexCount: 12, // >= 4: a 3D convex hull needs 4+ non-coplanar points
  boulderJitterRange: Object.freeze([0.7, 1.0]), // radial factor; 0 < min <= max <= 1 keeps dims.radius the true max extent
  rampThickness: 0.3, // slab thickness in metres, > 0
});

function validateGeometryOptions(cfg) {
  const n = cfg.boulderVertexCount;
  if (!Number.isInteger(n) || n < 4) {
    throw new Error('featureGeometry: boulderVertexCount must be an integer >= 4');
  }
  const j = cfg.boulderJitterRange;
  if (!Array.isArray(j) || j.length !== 2 || !Number.isFinite(j[0]) || !Number.isFinite(j[1]) || !(j[0] > 0) || !(j[0] <= j[1]) || !(j[1] <= 1)) {
    throw new Error('featureGeometry: boulderJitterRange must be [min, max] with 0 < min <= max <= 1');
  }
  if (!Number.isFinite(cfg.rampThickness) || !(cfg.rampThickness > 0)) {
    throw new Error('featureGeometry: rampThickness must be a finite number > 0');
  }
}

// Marsaglia (1972) uniform unit direction: (u, v) rejected to the open unit
// disk, then x = 2u√(1-s), y = 2v√(1-s), z = 1-2s with s = u² + v². Trig-free;
// the variable draw count is safe because each vertex runs on its own fork.
function marsagliaDirection(rng) {
  for (;;) {
    const u = rng.range(-1, 1);
    const v = rng.range(-1, 1);
    const s = u * u + v * v;
    if (s >= 1 || s < 1e-12) continue;
    const k = 2 * Math.sqrt(1 - s);
    return { x: u * k, y: v * k, z: 1 - 2 * s };
  }
}

function boulderHullPoints(feature, cfg) {
  const [jitterMin, jitterMax] = cfg.boulderJitterRange;
  const hullRng = new Rng(feature.seed);
  const points = new Array(cfg.boulderVertexCount * 3);
  for (let i = 0; i < cfg.boulderVertexCount; i++) {
    const vr = hullRng.fork(i);
    // Fixed draw order per vertex: direction (variable rejection draws), then jitter.
    const dir = marsagliaDirection(vr);
    const r = feature.dims.radius * vr.range(jitterMin, jitterMax);
    points[i * 3] = Math.fround(dir.x * r);
    points[i * 3 + 1] = Math.fround(dir.y * r);
    points[i * 3 + 2] = Math.fround(dir.z * r);
  }
  return points;
}

// Hamilton product a ⊗ b (apply b first, then a), renormalized: the product
// of two unit quaternions drifts off unit length by ulps, and a non-unit
// rotation handed to the physics engine is geometrically wrong.
export function quatMultiply(a, b) {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const inv = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  return { x: x * inv, y: y * inv, z: z * inv, w: w * inv };
}

// Yaw {cos, sin} (unit heading in world XZ) -> quaternion {x, y, z, w} that
// rotates local +X onto that heading: rot(q, +X) == (cos, 0, sin). This is the
// convention the support samples and render both assume (a feature's length
// axis points along its heading vector). It is a rotation about +Y by −θ in the
// right-handed Y-up frame, because a right-handed +Y rotation carries +X toward
// −Z; the negated y-term is what sends +X toward +sin·Z instead. Locked by the
// heading discriminator test in tests/features.test.js.
// Throws on a non-unit heading: a corrupt yaw would silently tilt a collider.
export function yawToQuaternion({ cos, sin } = {}) {
  if (!Number.isFinite(cos) || !Number.isFinite(sin) || Math.abs(cos * cos + sin * sin - 1) > 1e-9) {
    throw new Error('yawToQuaternion: yaw must be a unit {cos, sin} heading');
  }
  return {
    x: 0,
    y: -sgn(sin) * Math.sqrt(Math.max(0, (1 - cos) / 2)),
    z: 0,
    w: Math.sqrt(Math.max(0, (1 + cos) / 2)),
  };
}

// Half-angle quaternion about +Z from a full-angle {cos, sin} in [0, π):
// used for the ramp pitch (φ < π/2, so sin(φ/2) is always the + root) and,
// with the exact constant sqrt(1/2) pair, the log roll.
const zRotationQuaternion = (cos, sin) => ({
  x: 0,
  y: 0,
  z: sgn(sin) * Math.sqrt(Math.max(0, (1 - cos) / 2)),
  w: Math.sqrt(Math.max(0, (1 + cos) / 2)),
});

// Rolls the capsule's local +Y axis onto +X: −90° about Z, half-angle sqrt(1/2)
// exactly (no trig, no drift). Composed with the yaw (which carries +X onto the
// heading), the capsule axis then lies along the heading — same convention as
// the ramp's length axis. The capsule is axis-symmetric, so only the sign of
// the roll's z-term distinguishes this from the +90° roll; −90° is the one that
// sends +Y to +X (not −X).
const LOG_ROLL = Object.freeze({ x: 0, y: 0, z: -Math.sqrt(0.5), w: Math.sqrt(0.5) });

// Descriptor -> pure realization geometry. The adapter builds the collider
// from `shape`/`quat` and seats it by casting rays at `supportSamples`
// (horizontal offsets from the descriptor's x/z, each with the feature-local
// bottom height at that footprint point); the render scene builds the mesh
// from the same numbers. Seating rule (adapter): rest on the HIGHEST support,
// then embed slightly — bodyY = max_i(surfaceY_i - bottomOffset_i) - embedDepth.
//
// Ramp sign convention (locked by the ordering test in tests/features.test.js):
// pitch is +φ about Z (cosφ = L/hyp, sinφ = H/hyp, hyp = sqrt(L² + H²)), which
// rotates the slab's local +X UPHILL; the low end is local -X, so a vehicle
// driving +X meets the low edge of a roughly-+X-facing ramp first. The slab
// bottom face is local y = -t/2; a bottom point at local x sits at world
// x·sinφ - (t/2)·cosφ, giving the support table:
//   low end  (-hyp/2): -H/2 - (t/2)·cosφ      (the slab's lowest point)
//   center   (0):            - (t/2)·cosφ
//   high end (+hyp/2): +H/2 - (t/2)·cosφ
// The ~t·cosφ lip this leaves at the low edge is intended obstacle character
// (spec §4 says cuboid ramps); a feathered wedge would be a spec amendment.
export function featureGeometry(feature, options = {}) {
  const cfg = { ...FEATURE_GEOMETRY_DEFAULTS, ...options };
  validateGeometryOptions(cfg);
  const { type, yaw, dims } = feature;
  const yawQ = yawToQuaternion(yaw);
  if (type === 'boulder') {
    const points = boulderHullPoints(feature, cfg);
    // Lowest hull vertex (yaw rotates about +Y, so vertex heights are
    // rotation-invariant); footprint sampled at center + 4 compass points at
    // the guaranteed-solid inner radius (radius × jitterMin).
    let minY = Infinity;
    for (let i = 1; i < points.length; i += 3) minY = Math.min(minY, points[i]);
    const r = dims.radius * cfg.boulderJitterRange[0];
    return {
      quat: yawQ,
      points,
      shape: { kind: 'convexHull', points },
      supportSamples: [
        { dx: 0, dz: 0, bottomOffset: minY },
        { dx: -r, dz: 0, bottomOffset: minY },
        { dx: r, dz: 0, bottomOffset: minY },
        { dx: 0, dz: -r, bottomOffset: minY },
        { dx: 0, dz: r, bottomOffset: minY },
      ],
    };
  }
  if (type === 'log') {
    const half = dims.length / 2;
    return {
      quat: quatMultiply(yawQ, LOG_ROLL),
      points: null,
      shape: { kind: 'capsule', halfHeight: half, radius: dims.radius },
      supportSamples: [
        { dx: 0, dz: 0, bottomOffset: -dims.radius },
        { dx: -half * yaw.cos, dz: -half * yaw.sin, bottomOffset: -dims.radius },
        { dx: half * yaw.cos, dz: half * yaw.sin, bottomOffset: -dims.radius },
      ],
    };
  }
  if (type === 'ramp') {
    const { length: L, width: W, height: H } = dims;
    const t = cfg.rampThickness;
    const hyp = Math.sqrt(L * L + H * H);
    const cosP = L / hyp;
    const sinP = H / hyp;
    const halfSpan = L / 2; // horizontal projection of the slab half-extent
    const lip = (t / 2) * cosP;
    return {
      quat: quatMultiply(yawQ, zRotationQuaternion(cosP, sinP)),
      points: null,
      shape: { kind: 'cuboid', hx: hyp / 2, hy: t / 2, hz: W / 2 },
      supportSamples: [
        { dx: -halfSpan * yaw.cos, dz: -halfSpan * yaw.sin, bottomOffset: -H / 2 - lip },
        { dx: 0, dz: 0, bottomOffset: -lip },
        { dx: halfSpan * yaw.cos, dz: halfSpan * yaw.sin, bottomOffset: H / 2 - lip },
      ],
    };
  }
  throw new Error(`featureGeometry: unknown feature type '${type}'`);
}

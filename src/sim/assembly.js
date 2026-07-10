// src/sim/assembly.js — the assembly compiler (pure, NO Rapier).
//
// Genotype -> repaired assembly IR, per the PR #10 schema ruling (the genome
// contract: locked by fingerprint, versioned like the terrain seed format).
// Realization of the chassis lives in physics/adapter.js (realizeChassis);
// axle modules are decoded/bounded/snapped/repaired here as IR DATA ONLY —
// S0 physical realization is PR #11.
//
// Contract headline: DOMAIN validation fails loud; PHYSICAL invalidity
// repairs. A non-finite / out-of-[0,1] gene, wrong version, or wrong
// structural shape is an operator bug and throws with {path, value} — never
// clamped over (mutation clamps to [0,1] per legacy/SALVAGE.md, so anything
// outside the domain reaching this module means a broken operator). A
// physically bad but domain-valid genotype is repaired (clamp/separate/
// re-seat), never rejected — spec §3.1 constructive encoding.
//
// Determinism (D7): affine arithmetic, Math.sqrt/fround/floor/min/max/abs and
// Math.PI only (the ESLint sim ban allows exactly these). Randomness appears
// only in randomGenotype, which draws from an injected src/sim/prng.js Rng.
//
// Repair idempotence (the load-bearing invariant — tests/assembly.test.js
// proves it corpus-wide by byte-equality, which is non-negotiable): every
// correction is a FUSED CLAMP on the target gene,
//     g <- min(hi, max(g, min(lo, hi)))          // "hard cap wins" tie-break
// where lo/hi derive from constants and genes finalized by STRICTLY EARLIER
// rules, inverted through the target's affine decoder once. The target gene
// never round-trips decode -> modify -> re-encode (that ULP drift is exactly
// what breaks repair(repair(g)) === repair(g) bitwise). IEEE min/max are
// exact selections, each gene has a single writing rule, the pipeline is a
// forward DAG (no rule reads what a later rule writes), and every clearance
// bound is position-independent (maxHalfHeight over active nodes, never
// heightAt(posX) — the posX->height->radius feedback loop is the known
// idempotence killer, severed by construction).

export const GENOTYPE_VERSION = 1;

// Array index doubles as the enum/fingerprint id — append-only, never
// reorder (same rule as terrain.js FEATURE_TYPES).
export const FRAME_FAMILIES = Object.freeze(['spine', 'ladder', 'hull']);
export const SUSPENSION_TYPES = Object.freeze(['S0', 'S1', 'S2']);

// Compiler options (user-facing knobs). maxAxles = 6 paired modules <= 12
// wheels — ruling O1's "generous default, e.g. 12" exactly. The locked corpus
// fingerprint is pinned to these defaults; an "uncapped experimental" mode
// later raises only the live draw bound, never the lock.
export const ASSEMBLY_DEFAULTS = Object.freeze({
  corridorHalfWidth: 6, // metres to the wall inner face (terrain width 12)
  maxAxles: 6,
});

// Repair/build constants. CLEAR echoes the chassis-drop gate's buried tooth
// (floorY + 0.10). Mass bands are per-body density clamps — a global mass
// budget would need a proportional rescale that is NOT exactly idempotent
// (rejected in the schema ruling). MIN_PART_HALF_EXTENT floors every emitted
// collider half-extent so no sliver colliders reach the solver and the
// physics-test teeth stay calibratable (PR #9's bounds assumed no dimension
// thinner than ~0.25; the floor keeps compiled chassis in the same regime).
export const ASSEMBLY_RULES = Object.freeze({
  clearance: 0.1, // metres of belly clearance at rest pose (S0 worst case)
  wheelGap: 0.05, // metres between adjacent wheel surfaces / L-R wheel faces
  wallMargin: 0.3, // metres kept clear of the corridor wall inner face
  wheelMass: Object.freeze([2, 80]), // kg per wheel
  chassisMass: Object.freeze([5, 500]), // kg per chassis body
  minPartHalfExtent: 0.12, // metres — construction floor on every half-extent
});

// Affine decoder ranges — the single scaling table (SALVAGE convention: genes
// stay [0,1]; these do all physical scaling). Changing ANY range changes the
// compiled population for every shared seed: deliberate re-lock + version
// bump only. Divergences from the recovered legacy mappings are the schema
// ruling's D1-D7 table (docs + CLAUDE.md); wheelRadius is SALVAGE verbatim.
export const GENE_RANGES = Object.freeze({
  power: Object.freeze([0, 500]), // global torque-factor budget (SALVAGE g*500, now global)
  frameDensity: Object.freeze([30, 1200]), // kg/m³ (floor 30 keeps big frames inside the mass band)
  nodeGap: Object.freeze([0.3, 1.0]), // m spacing -> monotone node x by construction
  nodeHeight: Object.freeze([0.15, 0.45]), // m half-height
  nodeHalfWidth: Object.freeze([0.15, 1.2]), // m
  nodeThickness: Object.freeze([0.12, 0.35]), // m beam cross-section
  spineBeamWidthFrac: Object.freeze([0.15, 1.0]),
  ladderCrossFrac: Object.freeze([0.1, 1.0]),
  hullBulge: Object.freeze([0.6, 1.4]),
  trackHalf: Object.freeze([0.2, 3.0]), // m
  wheelRadius: Object.freeze([0.2, 0.7]), // m — SALVAGE g*0.5+0.2 verbatim
  wheelWidth: Object.freeze([0.1, 0.5]), // m
  wheelDensity: Object.freeze([100, 1200]), // kg/m³ ([2,80] kg feasible for every r,w)
  stiffness: Object.freeze([2000, 50000]), // N/m — provisional until PR #11 binds S1/S2
  damping: Object.freeze([0, 5000]), // N·s/m — provisional
  travel: Object.freeze([0, 0.4]), // m — provisional
  restLength: Object.freeze([0.05, 0.5]), // m — provisional
  centerOffset: Object.freeze([-1.5, 1.5]), // m — SALVAGE posZ span kept for single wheels
  sizeBiasFactor: Object.freeze([0.6, 1.4]), // right-wheel radius ratio from asym.sizeBias
});

export const NODE_SLOTS = 6; // fixed slots; nodeCount selects the active prefix
export const NODE_COUNT_RANGE = Object.freeze([2, 6]);

const affine = (g, [lo, hi]) => lo + (hi - lo) * g;
// Physical bound -> gene-space constant (used on CLAMP BOUNDS only — never on
// a target gene value, which would be the forbidden round-trip).
const encode = (v, [lo, hi]) => (v - lo) / (hi - lo);
const enumIdx = (g, k) => Math.min(k - 1, Math.floor(g * k));
const boolGene = (g) => g >= 0.5;
const countGene = (g, lo, hi) => lo + Math.min(hi - lo, Math.floor(g * (hi - lo + 1)));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Fused two-sided clamp with the "hard cap wins" tie-break: lo is first
// capped at hi, so an infeasible (lo > hi) pair resolves deterministically
// instead of oscillating between two one-sided clamps.
const fusedClamp = (g, lo, hi) => Math.min(hi, Math.max(g, Math.min(lo, hi)));

// --- Domain validation (fail-loud layer) -----------------------------------

function fail(path, value) {
  throw new Error(`assembly: invalid genotype at ${path} (${String(value)})`);
}

function checkGene(v, path) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail(path, v);
}

const AXLE_GENES = Object.freeze([
  'posX01', 'paired', 'trackHalf', 'radius', 'width', 'density',
  'suspType', 'stiffness', 'damping', 'travel', 'restLength',
  'driven', 'share',
]);
const ASYM_GENES = Object.freeze(['driveBias', 'sizeBias', 'centerOffset']);
const NODE_GENES = Object.freeze(['gap', 'height', 'halfWidth', 'thickness']);

export function validateGenotype(genotype) {
  if (typeof genotype !== 'object' || genotype === null) fail('genotype', genotype);
  if (genotype.version !== GENOTYPE_VERSION) fail('version', genotype.version);
  checkGene(genotype.hue, 'hue');
  checkGene(genotype.symmetric, 'symmetric');
  checkGene(genotype.power, 'power');
  checkGene(genotype.frameDensity, 'frameDensity');
  const frame = genotype.frame;
  if (typeof frame !== 'object' || frame === null) fail('frame', frame);
  checkGene(frame.family, 'frame.family');
  if (!Array.isArray(frame.segments) || frame.segments.length !== 1) {
    fail('frame.segments.length', Array.isArray(frame.segments) ? frame.segments.length : frame.segments);
  }
  const seg = frame.segments[0];
  if (typeof seg !== 'object' || seg === null) fail('frame.segments[0]', seg);
  checkGene(seg.nodeCount, 'frame.segments[0].nodeCount');
  if (!Array.isArray(seg.nodes) || seg.nodes.length !== NODE_SLOTS) {
    fail('frame.segments[0].nodes.length', Array.isArray(seg.nodes) ? seg.nodes.length : seg.nodes);
  }
  seg.nodes.forEach((n, i) => {
    if (typeof n !== 'object' || n === null) fail(`nodes[${i}]`, n);
    for (const k of NODE_GENES) checkGene(n[k], `nodes[${i}].${k}`);
  });
  const fam = seg.fam;
  if (typeof fam !== 'object' || fam === null) fail('fam', fam);
  checkGene(fam.spine && fam.spine.beamWidthFrac, 'fam.spine.beamWidthFrac');
  checkGene(fam.ladder && fam.ladder.crossFrac, 'fam.ladder.crossFrac');
  checkGene(fam.hull && fam.hull.bulge, 'fam.hull.bulge');
  if (!Array.isArray(genotype.axles)) fail('axles', genotype.axles);
  genotype.axles.forEach((a, i) => {
    if (typeof a !== 'object' || a === null) fail(`axles[${i}]`, a);
    for (const k of AXLE_GENES) checkGene(a[k], `axles[${i}].${k}`);
    if (typeof a.asym !== 'object' || a.asym === null) fail(`axles[${i}].asym`, a.asym);
    for (const k of ASYM_GENES) checkGene(a.asym[k], `axles[${i}].asym.${k}`);
  });
}

function validateOptions(cfg) {
  if (!Number.isFinite(cfg.corridorHalfWidth) || cfg.corridorHalfWidth <= ASSEMBLY_RULES.wallMargin + GENE_RANGES.wheelWidth[1] / 2) {
    throw new Error('assembly: corridorHalfWidth must be a finite number leaving room inside the wall margin');
  }
  if (!Number.isInteger(cfg.maxAxles) || cfg.maxAxles < 0) {
    throw new Error('assembly: maxAxles must be an integer >= 0');
  }
}

// Explicit structural clone in canonical field shape. Unknown extra fields do
// not survive (the clone enumerates the schema, so the repaired output is
// always in canonical shape); all leaves are f64 copied exactly.
function cloneGenotype(g) {
  const seg = g.frame.segments[0];
  return {
    version: g.version,
    hue: g.hue,
    symmetric: g.symmetric,
    power: g.power,
    frameDensity: g.frameDensity,
    frame: {
      family: g.frame.family,
      segments: [{
        nodeCount: seg.nodeCount,
        nodes: seg.nodes.map((n) => ({ gap: n.gap, height: n.height, halfWidth: n.halfWidth, thickness: n.thickness })),
        fam: {
          spine: { beamWidthFrac: seg.fam.spine.beamWidthFrac },
          ladder: { crossFrac: seg.fam.ladder.crossFrac },
          hull: { bulge: seg.fam.hull.bulge },
        },
      }],
    },
    axles: g.axles.map((a) => ({
      posX01: a.posX01,
      paired: a.paired,
      trackHalf: a.trackHalf,
      radius: a.radius,
      width: a.width,
      density: a.density,
      suspType: a.suspType,
      stiffness: a.stiffness,
      damping: a.damping,
      travel: a.travel,
      restLength: a.restLength,
      driven: a.driven,
      share: a.share,
      asym: { driveBias: a.asym.driveBias, sizeBias: a.asym.sizeBias, centerOffset: a.asym.centerOffset },
    })),
  };
}

// --- Frame geometry (shared by repair and buildIR) --------------------------
//
// Deterministic function of frame genes only — none of which repair ever
// writes — so repair (span/maxHalfHeight/volume) and buildIR (colliders)
// recompute identical values from the same genotype.

const floorExtent = (v) => Math.max(ASSEMBLY_RULES.minPartHalfExtent, v);

function decodeFrame(genotype) {
  const seg = genotype.frame.segments[0];
  const family = FRAME_FAMILIES[enumIdx(genotype.frame.family, 3)];
  const nodeCount = countGene(seg.nodeCount, NODE_COUNT_RANGE[0], NODE_COUNT_RANGE[1]);
  const raw = seg.nodes.slice(0, nodeCount).map((n) => ({
    gap: affine(n.gap, GENE_RANGES.nodeGap),
    height: affine(n.height, GENE_RANGES.nodeHeight),
    halfWidth: affine(n.halfWidth, GENE_RANGES.nodeHalfWidth),
    thickness: affine(n.thickness, GENE_RANGES.nodeThickness),
  }));
  // Cumulative spacing -> monotone x by construction (node[0].gap is latent);
  // recenter so the frame straddles the body origin.
  let x = 0;
  const xs = raw.map((n, i) => (i === 0 ? 0 : (x += n.gap)));
  const span = x;
  const half = span / 2;
  const nodes = raw.map((n, i) => ({ x: xs[i] - half, height: n.height, halfWidth: n.halfWidth, thickness: n.thickness }));
  let maxHalfHeight = -Infinity;
  for (const n of nodes) maxHalfHeight = Math.max(maxHalfHeight, n.height);
  return {
    family,
    nodeCount,
    nodes,
    span,
    maxHalfHeight,
    beamWidthFrac: affine(seg.fam.spine.beamWidthFrac, GENE_RANGES.spineBeamWidthFrac),
    crossFrac: affine(seg.fam.ladder.crossFrac, GENE_RANGES.ladderCrossFrac),
    bulge: affine(seg.fam.hull.bulge, GENE_RANGES.hullBulge),
  };
}

const cuboid = (hx, hy, hz, cx, cy, cz) => ({
  kind: 'cuboid',
  hx: floorExtent(hx),
  hy: floorExtent(hy),
  hz: floorExtent(hz),
  cx, cy, cz,
  rot: { x: 0, y: 0, z: 0, w: 1 }, // identity in v1; field reserved for angled beams
});

// Chassis colliders + analytic volume per family. Volume is exact for the
// cuboid families (Rapier sums per-collider mass, so overlapping ladder parts
// contribute additively there too); the hull family uses the documented
// cross-section × spacing proxy (a spine-shaped chain widened by bulge) —
// cheap, deterministic, and the same formula the mass-bound clamp uses, so
// massEstimate is self-consistent even though Rapier's realized hull mass
// (true hull volume × density) differs.
function buildChassis(frame) {
  const { family, nodes } = frame;
  const colliders = [];
  let volume = 0;
  const boxVol = (c) => 8 * c.hx * c.hy * c.hz;
  if (family === 'hull') {
    const points = [];
    for (const n of nodes) {
      const zExt = floorExtent(n.halfWidth * frame.bulge);
      // fround ONCE (features.js vertex discipline): the Rapier f32 collider
      // and the render mesh consume these exact values. >= 2 nodes at
      // distinct x (gaps >= 0.3) with positive extents ⇒ never coplanar, so
      // a valid genotype can never produce a degenerate hull.
      const x = Math.fround(n.x);
      const y = Math.fround(n.height);
      const z = Math.fround(zExt);
      points.push(x, y, z, x, y, -z, x, -y, z, x, -y, -z);
    }
    // Proxy volume: per inter-node segment, the full box of the local mean
    // cross-section (documented approximation — the mass-bound clamp and
    // massEstimate use this same formula, so they stay self-consistent).
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      const hx = (b.x - a.x) / 2;
      const hy = (a.height + b.height) / 2;
      const hz = (floorExtent(a.halfWidth * frame.bulge) + floorExtent(b.halfWidth * frame.bulge)) / 2;
      volume += 8 * floorExtent(hx) * floorExtent(hy) * floorExtent(hz);
    }
    colliders.push({ kind: 'convexHull', points });
  } else if (family === 'spine') {
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      const c = cuboid(
        (b.x - a.x) / 2,
        (a.height + b.height) / 2,
        frame.beamWidthFrac * ((a.halfWidth + b.halfWidth) / 2),
        (a.x + b.x) / 2, 0, 0
      );
      colliders.push(c);
      volume += boxVol(c);
    }
  } else { // ladder
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      const meanTh = (a.thickness + b.thickness) / 2;
      const railZ = Math.max(0, (a.halfWidth + b.halfWidth) / 2 - meanTh / 2);
      for (const s of [-1, 1]) {
        const c = cuboid((b.x - a.x) / 2, (a.height + b.height) / 2, meanTh / 2, (a.x + b.x) / 2, 0, s * railZ);
        colliders.push(c);
        volume += boxVol(c);
      }
    }
    for (const n of nodes) {
      const c = cuboid(frame.crossFrac * n.thickness, n.height, n.halfWidth, n.x, 0, 0);
      colliders.push(c);
      volume += boxVol(c);
    }
  }
  return { colliders, volume };
}

// Axis-aligned support extents + AABB + reach for the physics-test teeth:
// minFace = min over the 6 face directions of the compound support (a body
// resting flat on any face keeps its origin at least ~minFace above the
// contact plane; edge/corner rests only raise it), reach = max origin-to-
// geometry distance (a rest pose cannot hold the origin higher than reach
// above its lowest contact).
function supportsOf(colliders) {
  let px = -Infinity, nx = -Infinity, py = -Infinity, ny = -Infinity, pz = -Infinity, nz = -Infinity;
  let reach = 0;
  for (const c of colliders) {
    if (c.kind === 'cuboid') {
      px = Math.max(px, c.cx + c.hx);
      nx = Math.max(nx, -c.cx + c.hx);
      py = Math.max(py, c.cy + c.hy);
      ny = Math.max(ny, -c.cy + c.hy);
      pz = Math.max(pz, c.cz + c.hz);
      nz = Math.max(nz, -c.cz + c.hz);
      const dx = Math.abs(c.cx) + c.hx;
      const dy = Math.abs(c.cy) + c.hy;
      const dz = Math.abs(c.cz) + c.hz;
      reach = Math.max(reach, Math.sqrt(dx * dx + dy * dy + dz * dz));
    } else {
      for (let i = 0; i < c.points.length; i += 3) {
        const [x, y, z] = [c.points[i], c.points[i + 1], c.points[i + 2]];
        px = Math.max(px, x);
        nx = Math.max(nx, -x);
        py = Math.max(py, y);
        ny = Math.max(ny, -y);
        pz = Math.max(pz, z);
        nz = Math.max(nz, -z);
        reach = Math.max(reach, Math.sqrt(x * x + y * y + z * z));
      }
    }
  }
  return {
    minFace: Math.min(px, nx, py, ny, pz, nz),
    reach,
    aabb: { min: { x: -nx, y: -ny, z: -nz }, max: { x: px, y: py, z: pz } },
  };
}

// --- Repair (gene space, exactly idempotent) --------------------------------

export function repairGenotype(genotype, options = {}) {
  const cfg = { ...ASSEMBLY_DEFAULTS, ...options };
  validateOptions(cfg);
  validateGenotype(genotype);
  const g = cloneGenotype(genotype);

  // R1 — axle-count cap (structural truncation; deterministic, idempotent).
  if (g.axles.length > cfg.maxAxles) g.axles = g.axles.slice(0, cfg.maxAxles);

  // Derived read-only frame quantities. Node genes are never repaired (their
  // decoder ranges make per-gene validity intrinsic), so these are fixed for
  // every pass — the position-independence that keeps the pipeline a DAG.
  const frame = decodeFrame(g);
  const zLimit = cfg.corridorHalfWidth - ASSEMBLY_RULES.wallMargin;

  // R2 — wheels-below-frame + ground clearance, fused on the radius gene.
  // Rest-pose model (S0 worst case): wheels mount at the frame vertical
  // center (mountY = 0), contact at -r, belly at -maxHalfHeight, so clearance
  // = r - maxHalfHeight; suspension drop only adds clearance. Feasible by
  // ranges: bound <= 0.45 + 0.10 = 0.55 <= 0.7 = rMax.
  const rLo = clamp01(encode(frame.maxHalfHeight + ASSEMBLY_RULES.clearance, GENE_RANGES.wheelRadius));
  for (const a of g.axles) {
    a.radius = Math.min(1, Math.max(a.radius, rLo));

    // R3 — wheel mass bound via the density gene (reads repaired radius).
    const r = affine(a.radius, GENE_RANGES.wheelRadius);
    const w = affine(a.width, GENE_RANGES.wheelWidth);
    const vol = Math.PI * r * r * w;
    const dLo = clamp01(encode(ASSEMBLY_RULES.wheelMass[0] / vol, GENE_RANGES.wheelDensity));
    const dHi = clamp01(encode(ASSEMBLY_RULES.wheelMass[1] / vol, GENE_RANGES.wheelDensity));
    a.density = fusedClamp(a.density, dLo, dHi);

    // R4 — track-width sanity (paired: wheels clear each other and the wall;
    // single: the offset wheel clears the wall). Reads width + options only.
    const tLo = clamp01(encode(w / 2 + ASSEMBLY_RULES.wheelGap, GENE_RANGES.trackHalf));
    const tHi = clamp01(encode(zLimit - w / 2, GENE_RANGES.trackHalf));
    a.trackHalf = fusedClamp(a.trackHalf, tLo, tHi);
    const oLo = clamp01(encode(-(zLimit - w / 2), GENE_RANGES.centerOffset));
    const oHi = clamp01(encode(zLimit - w / 2, GENE_RANGES.centerOffset));
    a.asym.centerOffset = fusedClamp(a.asym.centerOffset, oLo, oHi);
  }

  // R5 — longitudinal non-overlap: stable sort by (posX01 gene, slot index)
  // for PROCESSING ORDER only, forward max-sweep in gene units (1 gene unit =
  // span metres), capped at 1. Storage order is untouched; residual overlap
  // at the cap is collision-inert (CHASSIS/WHEEL groups filter GROUND only —
  // the ghost-vehicle matrix makes self-pairs contactless) and accepted,
  // mirroring the terrain "features may overlap" ruling. Idempotent: pass 2
  // re-derives the identical order (pushed genes stay sorted; cap ties all
  // clamp to exactly 1 regardless of tie order) and every max is a no-op.
  if (g.axles.length > 1) {
    const order = g.axles.map((_, i) => i).sort((i, j) => {
      const d = g.axles[i].posX01 - g.axles[j].posX01;
      return d !== 0 ? d : i - j;
    });
    let cursor = null;
    let prevR = 0;
    for (const idx of order) {
      const a = g.axles[idx];
      const r = affine(a.radius, GENE_RANGES.wheelRadius);
      if (cursor !== null) {
        const minGapGene = (prevR + r + ASSEMBLY_RULES.wheelGap) / frame.span;
        a.posX01 = Math.min(1, Math.max(a.posX01, cursor + minGapGene));
      }
      cursor = a.posX01;
      prevR = r;
    }
  }

  // R6 — chassis mass bound via the frameDensity gene. Volume from the same
  // construction buildIR uses (construction floors included), a function of
  // never-repaired frame genes. Feasible by ranges: V ∈ [0.0216, ~15.4] m³
  // vs band [5, 500] kg and density [30, 1200] kg/m³.
  const { volume } = buildChassis(frame);
  const fLo = clamp01(encode(ASSEMBLY_RULES.chassisMass[0] / volume, GENE_RANGES.frameDensity));
  const fHi = clamp01(encode(ASSEMBLY_RULES.chassisMass[1] / volume, GENE_RANGES.frameDensity));
  g.frameDensity = fusedClamp(g.frameDensity, fLo, fHi);

  return g;
}

// --- Build (decode + symmetry expansion + IR assembly; runs once) -----------

function buildIR(repaired, cfg) {
  const frame = decodeFrame(repaired);
  const { colliders, volume } = buildChassis(frame);
  const { minFace, reach, aabb } = supportsOf(colliders);
  const density = affine(repaired.frameDensity, GENE_RANGES.frameDensity);
  const symmetric = boolGene(repaired.symmetric);
  const P = affine(repaired.power, GENE_RANGES.power);

  // Axle records (IR data only; PR #11 realizes). Symmetry gates the asym
  // genes at BUILD time — the stored genes are never overwritten, so a later
  // symmetry flip re-expresses them (count-stable, non-destructive).
  const axles = repaired.axles.map((a, index) => {
    const paired = boolGene(a.paired);
    const r = affine(a.radius, GENE_RANGES.wheelRadius);
    const w = affine(a.width, GENE_RANGES.wheelWidth);
    const rho = affine(a.density, GENE_RANGES.wheelDensity);
    const driven = boolGene(a.driven);
    const driveBias = symmetric ? 0.5 : a.asym.driveBias;
    const sizeBias = symmetric ? 0.5 : a.asym.sizeBias;
    const centerOffset = symmetric ? 0 : affine(a.asym.centerOffset, GENE_RANGES.centerOffset);
    const trackHalf = affine(a.trackHalf, GENE_RANGES.trackHalf);
    const wheelOf = (z, radius, shareFrac) => ({
      z,
      radius,
      width: w,
      density: rho,
      mass: Math.PI * radius * radius * w * rho,
      driven,
      shareFrac, // module share × side split; torque filled after Σ below
      driveTorque: 0,
    });
    const wheels = paired
      ? [
          wheelOf(trackHalf, r, a.share * driveBias),
          wheelOf(-trackHalf, r * affine(sizeBias, GENE_RANGES.sizeBiasFactor), a.share * (1 - driveBias)),
        ]
      : [wheelOf(centerOffset, r, a.share)];
    return {
      index,
      posX: a.posX01 * frame.span - frame.span / 2, // anchor ∈ [-span/2, +span/2] by construction
      mountY: 0, // explicit so PR #11 can move the anchor without a schema change
      kind: paired ? 'paired' : 'single',
      trackHalf: paired ? trackHalf : null,
      centerOffset: paired ? null : centerOffset,
      wheels,
      suspension: {
        type: SUSPENSION_TYPES[enumIdx(a.suspType, 3)],
        stiffness: affine(a.stiffness, GENE_RANGES.stiffness),
        damping: affine(a.damping, GENE_RANGES.damping),
        travel: affine(a.travel, GENE_RANGES.travel),
        restLength: affine(a.restLength, GENE_RANGES.restLength),
      },
    };
  });

  // Global power budget split by normalized shares (Σ=0 → equal split; no
  // driven wheels → no torques). driveTorque is PRE-computed here so the
  // split never appears inside a force/velocity expression in later PRs
  // (the legacy timeScale-in-physics bug class, legacy/SALVAGE.md).
  const drivenWheels = axles.flatMap((ax) => ax.wheels).filter((wh) => wh.driven);
  const shareSum = drivenWheels.reduce((s, wh) => s + wh.shareFrac, 0);
  for (const wh of drivenWheels) {
    wh.driveTorque = shareSum > 0 ? (P * wh.shareFrac) / shareSum : P / drivenWheels.length;
  }
  for (const ax of axles) for (const wh of ax.wheels) delete wh.shareFrac;

  const wheelsTotal = axles.flatMap((ax) => ax.wheels).reduce((s, wh) => s + wh.mass, 0);
  return {
    version: GENOTYPE_VERSION,
    render: { hue: repaired.hue },
    genotype: repaired,
    chassis: {
      family: frame.family,
      colliders,
      density,
      massEstimate: volume * density,
      aabb,
      supports: { minFace, reach },
    },
    axles,
    power: { budget: P, drivenWheelCount: drivenWheels.length },
    mass: { chassis: volume * density, wheelsTotal, total: volume * density + wheelsTotal },
    meta: { corridorHalfWidth: cfg.corridorHalfWidth, maxAxles: cfg.maxAxles },
  };
}

// Genotype -> repaired assembly IR. Never mutates its input (repair works on
// an explicit structural clone; the IR embeds that clone as ir.genotype).
export function compileAssembly(genotype, options = {}) {
  const cfg = { ...ASSEMBLY_DEFAULTS, ...options };
  const repaired = repairGenotype(genotype, cfg); // validates options + domain
  return buildIR(repaired, cfg);
}

// --- Canonical flat encoding -------------------------------------------------
//
// The schema's serialization contract: explicit little-endian bytes in the
// documented fixed order below — NEVER object key order. hue is the first
// gene serialized (canonical flat index 0 — the SALVAGE gene[0]=hue
// convention under nesting). tests/assembly.test.js FNV-1a's this stream for
// the locked corpus fingerprint and the double-repair byte-equality guard.
//
// Walk: u16 version; f64 hue, symmetric, power, frameDensity; f64 family;
// u8 segmentCount; f64 nodeCount; 6 × f64 (gap, height, halfWidth,
// thickness); f64 spine.beamWidthFrac, ladder.crossFrac, hull.bulge;
// u8 axleCount; per axle IN ARRAY ORDER: f64 posX01, paired, trackHalf,
// radius, width, density, suspType, stiffness, damping, travel, restLength,
// driven, share, driveBias, sizeBias, centerOffset.
export function serializeGenotype(genotype) {
  validateGenotype(genotype);
  const seg = genotype.frame.segments[0];
  const n = genotype.axles.length;
  const bytes = 2 + 4 * 8 + 8 + 1 + 8 + NODE_SLOTS * 4 * 8 + 3 * 8 + 1 + n * 16 * 8;
  const view = new DataView(new ArrayBuffer(bytes));
  let o = 0;
  const u8 = (v) => { view.setUint8(o, v); o += 1; };
  const u16 = (v) => { view.setUint16(o, v, true); o += 2; };
  const f64 = (v) => { view.setFloat64(o, v, true); o += 8; };
  u16(genotype.version);
  f64(genotype.hue);
  f64(genotype.symmetric);
  f64(genotype.power);
  f64(genotype.frameDensity);
  f64(genotype.frame.family);
  u8(genotype.frame.segments.length);
  f64(seg.nodeCount);
  for (const node of seg.nodes) {
    f64(node.gap);
    f64(node.height);
    f64(node.halfWidth);
    f64(node.thickness);
  }
  f64(seg.fam.spine.beamWidthFrac);
  f64(seg.fam.ladder.crossFrac);
  f64(seg.fam.hull.bulge);
  u8(n);
  for (const a of genotype.axles) {
    for (const k of AXLE_GENES) f64(a[k]);
    for (const k of ASYM_GENES) f64(a.asym[k]);
  }
  return new Uint8Array(view.buffer);
}

// --- Random genotype (test corpus / dev scene) -------------------------------
//
// Draws in EXACTLY the serialization order above (auditable re-locks). Corpus
// callers fork per index — new Rng(SEED).fork(i) — so the corpus is
// order-independent (rule 1). symmetric draws uniform here (branch coverage);
// "default-on" is the live population initializer's bias (a later GA PR).
export function randomGenotype(rng) {
  const hue = rng.nextFloat();
  const symmetric = rng.nextFloat();
  const power = rng.nextFloat();
  const frameDensity = rng.nextFloat();
  const family = rng.nextFloat();
  const nodeCount = rng.nextFloat();
  const nodes = [];
  for (let i = 0; i < NODE_SLOTS; i++) {
    nodes.push({ gap: rng.nextFloat(), height: rng.nextFloat(), halfWidth: rng.nextFloat(), thickness: rng.nextFloat() });
  }
  const fam = {
    spine: { beamWidthFrac: rng.nextFloat() },
    ladder: { crossFrac: rng.nextFloat() },
    hull: { bulge: rng.nextFloat() },
  };
  const axles = [];
  const axleCount = rng.int(0, ASSEMBLY_DEFAULTS.maxAxles + 1); // 0..6 — 0-axle sleds are legal
  for (let i = 0; i < axleCount; i++) {
    const axle = {};
    for (const k of AXLE_GENES) axle[k] = rng.nextFloat();
    axle.asym = {};
    for (const k of ASYM_GENES) axle.asym[k] = rng.nextFloat();
    axles.push(axle);
  }
  return {
    version: GENOTYPE_VERSION,
    hue,
    symmetric,
    power,
    frameDensity,
    frame: { family, segments: [{ nodeCount, nodes, fam }] },
    axles,
  };
}

// src/sim/assembly.js — the assembly compiler (pure, NO Rapier).
//
// Genotype -> repaired assembly IR, per the PR #10 schema ruling (the genome
// contract: locked by fingerprint, versioned like the terrain seed format).
// Realization lives in physics/adapter.js — realizeChassis for the frame,
// realizeVehicle for the S0/S1 dispatch (realizeS0Vehicle remains the
// S0-only compatibility wrapper); axle modules are decoded/bounded/snapped/
// repaired here, and S1 wheels additionally carry the compiler-owned hub
// record (S2 stays IR data until its own PR).
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
//
// Repair bounds the EMITTED vehicle, not just base genes: a paired module's
// second wheel is r × sizeBias-factor, so R3b re-derives clearance and the
// mass band through the sizeBias gene and R5 spaces by the emitted max
// radius (tests assert the invariants over every wheel the corpus emits).

// TWO version constants, deliberately split (S1 PR ruling):
//   GENOTYPE_VERSION — the serialized GENE schema + decoder contract (what
//     serializeGenotype writes at byte 0 and the corpus fingerprint covers).
//     Stays 1: the S1 calibration matrix (npm run probe:s1) measured every
//     provisional suspension range binding to real physics UNCHANGED, so no
//     gene meaning moved and the 24cd0dd5 corpus lock stands.
//   ASSEMBLY_IR_VERSION — the compiled PHYSICAL-RECORD contract the realizers
//     consume. Bumped to 2 by the S1 PR: v2 IRs carry a per-wheel `hub`
//     record on S1 axles, `mass.hubsTotal`, and the `genotypeVersion` field —
//     required realization data a hubless v1 IR does not have, so a consumer
//     can never confuse the two shapes under one number.
export const GENOTYPE_VERSION = 1;
export const ASSEMBLY_IR_VERSION = 2;

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
  power: Object.freeze([0, 500]), // global stall-torque budget, N·m (SALVAGE g*500; per-wheel shares are each wheel's stall torque via the S0 gain conversion)
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
  // Suspension ranges — BOUND by the S1 PR's calibration matrix (npm run
  // probe:s1; measured on both flavors) to configureMotorPosition(restLength,
  // stiffness, damping) + setLimits(0, travel) on the chassis→hub prismatic.
  // The numbers survived measurement UNCHANGED (honest N/m under ForceBased —
  // the [V12] ruling; breadth spans bottomed/preload-rigid/locked poor
  // phenotypes through mid-travel compliant riders), so this binding is
  // deliberately NOT a re-lock: the corpus fingerprint hashes raw [0,1]
  // genes, no decoded meaning moved, and GENOTYPE_VERSION stays 1. S2 will
  // re-interpret the same four genes per type (spec §3.2 "meaning per type").
  stiffness: Object.freeze([2000, 50000]), // N/m — honest spring rate at the joint (in-chain convergence caveat: see the probe header)
  damping: Object.freeze([0, 5000]), // N·s/m — decay tuning; high c × light unsprung rides soft/bottomed (measured, legal phenotypes)
  travel: Object.freeze([0, 0.4]), // m — prismatic limits [0, travel]; 0 = locked suspension (legal)
  restLength: Object.freeze([0.05, 0.5]), // m — motor target; beyond travel = preload pinned at the stop (legal static state)
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

// Solid-cylinder wheel mass — the ONE source for π·r²·w·ρ. wheelOf stores it
// in the IR; the S0 realizer re-checks the stored mass against this to catch
// hand-edited IR data (adapter.js realizeS0Vehicle). Single-sourced so the
// two sites cannot silently diverge if the formula is ever revised — and the
// realizer's guard still catches a tampered `mass` field, since only the
// stored value (not the recomputed one) is corrupted there.
// Arguments are validated because this is a PUBLIC export, and an unguarded
// product is the silent-invalid-output class: `wheelMass(NaN, 1, 1)` returned
// NaN, `wheelMass(-2, 1, 1)` returned a POSITIVE mass (radius is squared, so
// the sign launders away), and a numeric string coerced through `*`. The
// internal callers always pass repaired genes; this guards the exported
// formula, which the adapter's tamper check also consumes.
export const wheelMass = (radius, width, density) => {
  for (const [name, v] of [['radius', radius], ['width', width], ['density', density]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`assembly: invalid wheelMass ${name} (${String(v)})`);
    }
  }
  return Math.PI * radius * radius * width * density;
};

// --- S1 hub policy (single-sourced, the wheelMass pattern) ------------------
// The S1 topology interposes a hub body between the chassis prismatic and the
// wheel revolute. The hub is NOT a gene, but it is real physics: the compiler
// stores one record per S1 wheel (wheel.hub), sums ir.mass.hubsTotal from the
// STORED records, and the realizer consumes those records — recomputing them
// through these SAME exports only to validate that a hand-edited record
// disagrees loud (the wheelMass tamper-guard pattern; recomputing both sides
// from one helper would only prove the helper agrees with itself).
//
// Representation (measured ruling, tests/s1-prismatic.test.js): the hub is a
// COLLIDER-CARRYING body — a small solid cylinder coaxial with the wheel —
// because colliderless additional-mass bodies read mass()/inertia() ZERO
// until the first world.step() in rapier 0.19.3, which would defeat the
// mandated creation-time readback cross-check. The collider is collision-
// inert (HUB_GROUPS filters NOTHING) and its geometry is derived from the
// wheel, so the inertia is scale-aware in BOTH wheel radius and width: two
// equal-mass hubs on differently shaped wheels get different inertia.
//
// principalInertia is the solid cylinder about its own axis (the axle, body-
// local +Z after the shared Y→Z collider rotation): axial = m·r²/2 on z,
// transverse = m·(3r² + L²)/12 on x/y. NOTE (measured): Rapier's
// invPrincipalInertia() reports principal values in the PRINCIPAL frame's
// ordering — for this rotated cylinder the axial value appears on the y
// slot — so readback checks compare the value SET, not slot-by-slot.
export const HUB_MASS_FRACTION = 0.25; // of the carried wheel's mass
export const HUB_MASS_RANGE = Object.freeze([0.5, 20]); // kg — 0.25 × the [2, 80] wheel band, so the clamp NEVER bites for a legal wheel; it floors degenerate hand-edited IR only
export const HUB_RADIUS_FRACTION = 0.4; // of the wheel radius
export const HUB_LENGTH_FRACTION = 0.5; // of the wheel width

export function hubMassProperties(wheel) {
  // Fail-loud on the record's shape and the three inputs the formulas
  // consume: without this, `hubMassProperties(null)` leaked a foreign
  // TypeError and — worse — `hubMassProperties({})` returned a SILENT
  // all-NaN record, and radius 0 a density of Infinity. The internal callers
  // (buildIR, the adapter's tamper guard) always pass validated wheel
  // records, so this guards direct consumers of the exported policy only.
  if (typeof wheel !== 'object' || wheel === null) {
    throw new Error(`assembly: invalid hub wheel record (${String(wheel)})`);
  }
  // Capture the three inputs as they are checked, and compute from the
  // captures. Reading `wheel.mass` again below would let an accessor pass the
  // domain check and then feed the formulas a different number — and the
  // HUB_MASS_RANGE clamp would LAUNDER it into a legal-looking 0.5–20 kg hub,
  // so the substitution left no trace anywhere downstream.
  const src = {};
  for (const k of ['mass', 'radius', 'width']) {
    const v = wheel[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`assembly: invalid hub wheel record at ${k} (${String(v)})`);
    }
    src[k] = v;
  }
  const mass = Math.min(HUB_MASS_RANGE[1], Math.max(HUB_MASS_RANGE[0], HUB_MASS_FRACTION * src.mass));
  const radius = HUB_RADIUS_FRACTION * src.radius;
  const halfWidth = (HUB_LENGTH_FRACTION * src.width) / 2;
  const length = 2 * halfWidth;
  const transverse = (mass * (3 * radius * radius + length * length)) / 12;
  const density = mass / (Math.PI * radius * radius * length); // kg/m³ — realizes the mass through the collider
  const axial = mass * radius * radius * 0.5;
  // Validate the DERIVED record too, not only the three inputs. Guarding the
  // inputs made `hubMassProperties({})` loud but left the arithmetic's own
  // failure modes silent: finite in-domain magnitudes can still underflow
  // radius² to 0 (density Infinity, zero principal inertia) or overflow it
  // (inertia Infinity), and a physically impossible hub record then flows
  // into ir.mass and on to the realizer's readback cross-check, where it
  // reads as an engine disagreement rather than as bad input. A function that
  // validates what it consumes and not what it returns has only moved the
  // silence one step downstream.
  for (const [name, v] of [['mass', mass], ['radius', radius], ['halfWidth', halfWidth],
    ['density', density], ['principalInertia.transverse', transverse], ['principalInertia.axial', axial]]) {
    if (!Number.isFinite(v) || v <= 0) {
      // Diagnostics quote the CAPTURES — the numbers that actually entered
      // the arithmetic. Re-reading the caller here printed values that never
      // did, which is the worst possible time to be reporting a fiction.
      throw new Error(`assembly: hub record for wheel (mass ${src.mass}, radius ${src.radius}, `
        + `width ${src.width}) derives a non-physical ${name} (${String(v)})`);
    }
  }
  return {
    mass, // kg
    radius, // m — hub cylinder radius
    halfWidth, // m — hub cylinder half-length along the axle
    density,
    principalInertia: Object.freeze({ x: transverse, y: transverse, z: axial }), // kg·m², body frame (axle = z)
  };
}

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

// The gene leaves whose DECODE is DISCRETE rather than a continuous
// magnitude — enum band (`family`: 3 frame families; `suspType`: 3 suspension
// types via enumIdx), boolean threshold (`symmetric`, `paired`, `driven` via
// boolGene ≥ 0.5), or slot count (`nodeCount` via countGene). Declared HERE —
// the genome contract's single source — for perturbation/mutation code to
// consume: a PARAMETRIC operator (continuous jitter around a parent) must
// preserve these verbatim, because crossing a decode boundary is a
// STRUCTURAL mutation (spec §3.1.3's separate operator class, with its own
// rates), not continuous drift — and a `suspType` crossing into the S2 band
// additionally produces a legal-but-unrealizable IR on the current backend
// (realizers reject S2 pre-world), which would abort a neighborhood
// experiment mid-flight. Key names are unique gene ROLES across the genotype
// schema (no continuous gene shares a name with a discrete one), so
// key-based matching identifies them at any depth. NOT a schema change: the
// gene layout, decoders, and both locked fingerprints are untouched.
export const DISCRETE_GENE_KEYS = Object.freeze([
  'family', 'suspType', 'symmetric', 'paired', 'driven', 'nodeCount',
]);

// Read a caller property ONCE and require it to be a non-null object. The
// idiomatic `typeof x.k !== 'object' || x.k === null` shape reads the caller
// TWICE before anyone touches the value, so every such guard was itself an
// instance of the defect it was written to prevent.
function requireObject(v, path) {
  if (typeof v !== 'object' || v === null) fail(path, v);
  return v;
}

/**
 * THE ONE WALK — the genotype ownership boundary.
 *
 * Reads every caller-owned container and leaf EXACTLY once, validating each
 * value as it is captured, and returns a module-owned genotype in canonical
 * shape. Everything downstream (repair, serialization, the field walk) then
 * consumes the CAPTURE, so the values that were validated are necessarily the
 * values that are repaired, encoded, and attested.
 *
 * This replaces the former validate-then-clone pair. That shape read the
 * caller twice — `validateGenotype(genotype)` followed by
 * `cloneGenotype(genotype)` — so an ordinary own accessor could pass the
 * domain check on its first read and hand a different value to the clone.
 * Measured (round-10 external review): a `hue` getter returning 0.5 then 1e6
 * produced a REPAIRED genotype carrying 1e6 in a [0,1] gene slot, an IR with
 * a 300 km chassis half-extent, and a `serializeGenotype` NaN write that the
 * module's own decoder then rejected. Unknown extra fields still do not
 * survive: the walk enumerates the schema, never the caller's key order.
 */
function captureGenotype(genotype) {
  requireObject(genotype, 'genotype');
  const version = genotype.version;
  if (version !== GENOTYPE_VERSION) fail('version', version);
  const hue = genotype.hue;
  checkGene(hue, 'hue');
  const symmetric = genotype.symmetric;
  checkGene(symmetric, 'symmetric');
  const power = genotype.power;
  checkGene(power, 'power');
  const frameDensity = genotype.frameDensity;
  checkGene(frameDensity, 'frameDensity');
  const frame = requireObject(genotype.frame, 'frame');
  const family = frame.family;
  checkGene(family, 'frame.family');
  const segments = frame.segments;
  if (!Array.isArray(segments) || segments.length !== 1) {
    fail('frame.segments.length', Array.isArray(segments) ? segments.length : segments);
  }
  const seg = requireObject(segments[0], 'frame.segments[0]');
  const nodeCount = seg.nodeCount;
  checkGene(nodeCount, 'frame.segments[0].nodeCount');
  const nodes = seg.nodes;
  if (!Array.isArray(nodes) || nodes.length !== NODE_SLOTS) {
    fail('frame.segments[0].nodes.length', Array.isArray(nodes) ? nodes.length : nodes);
  }
  // Indexed, never forEach: forEach SKIPS HOLES, so a sparse array (`nodes`
  // grown by a length assignment, the shape a structural operator produces)
  // would pass validation with its holes unchecked and then die inside
  // serializeGenotype as a foreign TypeError reading a gene off undefined.
  // Validation must cover exactly the slots the serializer writes. The bound
  // is the module constant, already proven equal to the captured length.
  const outNodes = [];
  for (let i = 0; i < NODE_SLOTS; i += 1) {
    const n = requireObject(nodes[i], `nodes[${i}]`);
    const node = {};
    for (const k of NODE_GENES) {
      const v = n[k];
      checkGene(v, `nodes[${i}].${k}`);
      node[k] = v;
    }
    outNodes.push(node);
  }
  const fam = requireObject(seg.fam, 'fam');
  // Explicit object checks per block: a falsy-but-valid-gene value
  // (fam.spine = 0) would slip through a `fam.spine && fam.spine.gene`
  // truthiness chain AS the gene 0, then clone to undefined and surface as
  // NaN geometry — exactly the operator-bug class this layer exists to stop
  // at the door (external review finding, PR #10).
  const spine = requireObject(fam.spine, 'fam.spine');
  const ladder = requireObject(fam.ladder, 'fam.ladder');
  const hull = requireObject(fam.hull, 'fam.hull');
  const beamWidthFrac = spine.beamWidthFrac;
  checkGene(beamWidthFrac, 'fam.spine.beamWidthFrac');
  const crossFrac = ladder.crossFrac;
  checkGene(crossFrac, 'fam.ladder.crossFrac');
  const bulge = hull.bulge;
  checkGene(bulge, 'fam.hull.bulge');
  const axles = genotype.axles;
  if (!Array.isArray(axles)) fail('axles', axles);
  // CAPTURE THE BOUND. `axles.length` cannot be an ACCESSOR (it is a
  // non-configurable own data property on a genuine Array) — but it IS
  // writable, and the loop body below reads caller gene leaves, which may be
  // ordinary own accessors, i.e. caller CODE running between two readings of
  // the bound. Measured (round-11): a `radius` getter that assigned
  // `axles.length = 1` on its first call made a 3-axle genotype serialize to
  // 396 bytes with axleCount 1 — a short, well-formed, cleanly-decodable
  // stream attesting a genotype the caller's object did not hold. The earlier
  // comment here asserted the opposite and was false; "no accessor" is not
  // "cannot change".
  const axleCount = axles.length;
  const outAxles = [];
  for (let i = 0; i < axleCount; i += 1) { // indexed: see nodes above
    const a = requireObject(axles[i], `axles[${i}]`);
    const axle = {};
    for (const k of AXLE_GENES) {
      const v = a[k];
      checkGene(v, `axles[${i}].${k}`);
      axle[k] = v;
    }
    const asymIn = requireObject(a.asym, `axles[${i}].asym`);
    const asym = {};
    for (const k of ASYM_GENES) {
      const v = asymIn[k];
      checkGene(v, `axles[${i}].asym.${k}`);
      asym[k] = v;
    }
    axle.asym = asym;
    outAxles.push(axle);
  }
  return {
    version,
    hue,
    symmetric,
    power,
    frameDensity,
    frame: {
      family,
      segments: [{
        nodeCount,
        nodes: outNodes,
        fam: { spine: { beamWidthFrac }, ladder: { crossFrac }, hull: { bulge } },
      }],
    },
    axles: outAxles,
  };
}

/**
 * Domain validation. Retained as the public predicate (it throws or returns
 * undefined); every INTERNAL consumer uses `captureGenotype` instead, so no
 * caller-owned value is ever validated here and read again elsewhere.
 */
export function validateGenotype(genotype) {
  captureGenotype(genotype);
}

function validateOptions(cfg) {
  if (!Number.isFinite(cfg.corridorHalfWidth) || cfg.corridorHalfWidth <= ASSEMBLY_RULES.wallMargin + GENE_RANGES.wheelWidth[1] / 2) {
    throw new Error('assembly: corridorHalfWidth must be a finite number leaving room inside the wall margin');
  }
  if (!Number.isInteger(cfg.maxAxles) || cfg.maxAxles < 0) {
    throw new Error('assembly: maxAxles must be an integer >= 0');
  }
}

// Unknown option keys reject loud (the repo-wide runner convention — a typo'd
// knob must never silently become a no-op that compiles a different vehicle
// than the caller believes it configured).
const ASSEMBLY_OPTION_KEYS = Object.freeze(Object.keys(ASSEMBLY_DEFAULTS));
function checkOptionKeys(options) {
  // Structural check FIRST: an explicit `options: null` on repairGenotype /
  // compileAssembly reached Object.keys(null) and leaked a foreign TypeError,
  // so the "explicit null fails where absent defaults" ruling was enforced at
  // createInitialPopulation and skipped at the two assembly entry points that
  // share the idiom.
  if (typeof options !== 'object' || options === null) {
    throw new Error(`assembly: invalid options (${String(options)})`);
  }
  for (const k of Object.keys(options)) {
    if (!ASSEMBLY_OPTION_KEYS.includes(k)) {
      throw new Error(`assembly: unknown option key '${k}' (known: ${ASSEMBLY_OPTION_KEYS.join(', ')})`);
    }
  }
}

// (`cloneGenotype` lived here. It was a SECOND walk of the caller's genotype,
// performed after `validateGenotype` had already walked it — the structure
// that let a validated value and an encoded value differ. `captureGenotype`
// above subsumes it: one walk that validates and copies in the same step, so
// the ownership boundary and the domain check can no longer disagree. Its
// INDEXED-reads ruling is preserved verbatim there — `.map`/`.forEach` are
// looked up on the caller's arrays and would run caller code inside the
// "owned" clone.)

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
  checkOptionKeys(options);
  const cfg = { ...ASSEMBLY_DEFAULTS, ...options };
  validateOptions(cfg);
  // ONE walk: validate and capture together, so repair operates on exactly
  // the values that were checked (see captureGenotype's ruling).
  const g = captureGenotype(genotype);

  // R1 — axle-count cap (structural truncation; deterministic, idempotent).
  if (g.axles.length > cfg.maxAxles) g.axles = g.axles.slice(0, cfg.maxAxles);

  // Derived read-only frame quantities. Node genes are never repaired (their
  // decoder ranges make per-gene validity intrinsic), so these are fixed for
  // every pass — the position-independence that keeps the pipeline a DAG.
  const frame = decodeFrame(g);
  const zLimit = cfg.corridorHalfWidth - ASSEMBLY_RULES.wallMargin;
  // Expression gate for R5's emitted-radius sweep. Read-only: symmetric and
  // paired are never repaired, so the gate cannot create a DAG back-edge.
  const symmetric = boolGene(g.symmetric);

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

    // R3b — size-bias feasibility. A paired module EMITS a second wheel of
    // radius r × f, f = affine(sizeBias, [0.6, 1.4]) (buildIR), and repair
    // must bound what the genotype emits, not just the base genes — an
    // unrepaired bias re-broke clearance, the mass band, and the R5 spacing
    // AFTER repair had finished (external review blocker, PR #10). Fused
    // clamp on the sizeBias gene so the biased wheel also satisfies
    //   clearance: r·f >= maxHalfHeight + clearance   ->  f >= fClear
    //   mass:      f²·mBase ∈ [2, 80] kg              ->  f ∈ [√(2/m), √(80/m)]
    // Always feasible: R2 gives fClear <= 1 (± ulp) and R3 gives mBase ∈
    // [2, 80], so both bands bracket f = 1; the fused tie-break absorbs the
    // ulp corner where r and mBase sit exactly on their bounds. Clamped
    // UNCONDITIONALLY — the same treatment the wall clamp below already
    // gives the latent centerOffset: repair bounds every asym gene's
    // physical feasibility; expression stays buildIR's gate (A.3 ruling).
    const mBase = vol * affine(a.density, GENE_RANGES.wheelDensity);
    const fClear = (frame.maxHalfHeight + ASSEMBLY_RULES.clearance) / r;
    const fLo = Math.max(fClear, Math.sqrt(ASSEMBLY_RULES.wheelMass[0] / mBase));
    const fHi = Math.sqrt(ASSEMBLY_RULES.wheelMass[1] / mBase);
    a.asym.sizeBias = fusedClamp(
      a.asym.sizeBias,
      clamp01(encode(fLo, GENE_RANGES.sizeBiasFactor)),
      clamp01(encode(fHi, GENE_RANGES.sizeBiasFactor))
    );

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
      // EMITTED max longitudinal radius: an asymmetric paired module's second
      // wheel is r × f (f finalized by R3b above — a forward DAG edge), so
      // spacing must use the larger of the two; the base gene alone under-
      // spaced enlarged wheels (external review). The gate matters the other
      // way too: a symmetric or single module emits only r, and a LATENT
      // bias must never shape the phenotype (A.3 — expression is buildIR's).
      const base = affine(a.radius, GENE_RANGES.wheelRadius);
      const r = symmetric || !boolGene(a.paired)
        ? base
        : base * Math.max(1, affine(a.asym.sizeBias, GENE_RANGES.sizeBiasFactor));
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

  // Axle records (the adapter's realizeVehicle dispatches S0 and S1; S2
  // stays IR data until its PR). Symmetry gates the asym
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
      mass: wheelMass(radius, w, rho),
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
    const suspension = {
      type: SUSPENSION_TYPES[enumIdx(a.suspType, 3)],
      stiffness: affine(a.stiffness, GENE_RANGES.stiffness),
      damping: affine(a.damping, GENE_RANGES.damping),
      travel: affine(a.travel, GENE_RANGES.travel),
      restLength: affine(a.restLength, GENE_RANGES.restLength),
    };
    // Compiler-owned hub records: one per S1 wheel (an asymmetric paired
    // module's two wheels differ in mass, hence in hub record), null
    // elsewhere. The realizer consumes THESE — it never invents bodies.
    for (const wh of wheels) {
      wh.hub = suspension.type === 'S1' ? hubMassProperties(wh) : null;
    }
    return {
      index,
      posX: a.posX01 * frame.span - frame.span / 2, // anchor ∈ [-span/2, +span/2] by construction
      mountY: 0, // the chassis-side anchor Y: S0 wheel center AND the S1 prismatic full-compression anchor (the reserved move landed)
      kind: paired ? 'paired' : 'single',
      trackHalf: paired ? trackHalf : null,
      centerOffset: paired ? null : centerOffset,
      wheels,
      suspension,
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

  // Canonical mass accounting, axle-then-wheel float-add order for BOTH sums
  // (documented so tests recompute to exact toBe equality). These are the
  // CANONICAL estimates — exact for cuboid families, the documented proxy
  // volume for hull chassis; the realizer's returned mass block is the
  // realized Rapier readback, a separate (f32-bounded) quantity.
  const wheelsTotal = axles.flatMap((ax) => ax.wheels).reduce((s, wh) => s + wh.mass, 0);
  const hubsTotal = axles.flatMap((ax) => ax.wheels).reduce((s, wh) => s + (wh.hub ? wh.hub.mass : 0), 0);
  return {
    version: ASSEMBLY_IR_VERSION,
    genotypeVersion: GENOTYPE_VERSION,
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
    mass: { chassis: volume * density, wheelsTotal, hubsTotal, total: volume * density + wheelsTotal + hubsTotal },
    meta: { corridorHalfWidth: cfg.corridorHalfWidth, maxAxles: cfg.maxAxles },
  };
}

// Genotype -> repaired assembly IR. Never mutates its input (repair works on
// an explicit structural clone; the IR embeds that clone as ir.genotype).
export function compileAssembly(genotype, options = {}) {
  checkOptionKeys(options);
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
  // The bytes are written from the CAPTURE, never from a second reading of
  // the caller: what was validated is what is encoded. Before this, a gene
  // accessor could pass `validateGenotype` and then hand the writer a NaN —
  // emitting a stream this module's own decoder rejects, which broke the
  // exact-inverse property the codec exists to guarantee.
  const g = captureGenotype(genotype);
  const seg = g.frame.segments[0];
  const n = g.axles.length;
  // Wire representability: the axle count is a u8. validateGenotype imposes no
  // axle cap (repair's maxAxles is policy, not domain), so without this guard a
  // 256+-axle genotype would emit a WRAPPED count byte disagreeing with its own
  // payload — malformed bytes produced silently. No reachable input hits this
  // (repair and the initializer both cap at 6) and no valid stream changes;
  // this only converts a silent corruption into a loud failure.
  //
  // The guard keeps its own diagnostic (it names the FIELD a caller controls,
  // which `axleCount` would not), but the ALLOCATION comes from
  // genotypeByteLength — the same function deserializeGenotype checks an
  // incoming length against. One geometry, so the encoder's buffer and the
  // decoder's exact-length identity cannot drift apart; they agreed as two
  // independent literals, and agreeing by construction is the point.
  if (n > 0xff) fail('axles.length', `${n} exceeds the u8 wire bound (255)`);
  const view = new DataView(new ArrayBuffer(genotypeByteLength(n)));
  let o = 0;
  const u8 = (v) => { view.setUint8(o, v); o += 1; };
  const u16 = (v) => { view.setUint16(o, v, true); o += 2; };
  const f64 = (v) => { view.setFloat64(o, v, true); o += 8; };
  u16(g.version);
  f64(g.hue);
  f64(g.symmetric);
  f64(g.power);
  f64(g.frameDensity);
  f64(g.frame.family);
  u8(g.frame.segments.length);
  f64(seg.nodeCount);
  // INDEXED, never for...of: the byte count above is derived from NODE_SLOTS
  // and `n`, so iterating instead would let an array with an overridden
  // Symbol.iterator write fewer values than the header promises and leave a
  // zero-filled hole — a stream that stays the right SIZE, decodes cleanly,
  // and means something else (measured: an under-yielding `axles` decoded to a
  // genotype whose extra axle was all-zero genes, which are legal values).
  // validateGenotype's own checks are index-based, so they do not catch it.
  for (let i = 0; i < NODE_SLOTS; i += 1) {
    const node = seg.nodes[i];
    f64(node.gap);
    f64(node.height);
    f64(node.halfWidth);
    f64(node.thickness);
  }
  f64(seg.fam.spine.beamWidthFrac);
  f64(seg.fam.ladder.crossFrac);
  f64(seg.fam.hull.bulge);
  u8(n);
  for (let i = 0; i < n; i += 1) {
    const a = g.axles[i];
    for (const k of AXLE_GENES) f64(a[k]);
    for (const k of ASYM_GENES) f64(a.asym[k]);
  }
  // receiver `view` is the module-owned DataView allocated above, not caller data.
  // eslint-disable-next-line no-restricted-syntax
  return new Uint8Array(view.buffer);
}

// --- The schema walk: a validated MIRROR of the serializer ------------------
//
// ROLES, stated once so they cannot blur: `serializeGenotype` above is the
// CANONICAL BYTE-LAYOUT AUTHORITY — it alone produces the stream the 24cd0dd5
// corpus fingerprint hashes, and it stays hand-written. What follows is a
// validated METADATA MIRROR of that walk: the same fields, in the same order,
// at the same offsets, annotated with the classification a future parametric
// mutation operator needs. tests/genotype-schema.test.js proves the two agree
// exactly (a copy-declared literal walk, byte-offset exclusivity under
// single-leaf perturbation, and the tiling identity), so the mirror cannot
// drift silently. Refactoring serialization ONTO this walk is a deliberate
// later PR, never an accident of this one.
//
// SERIALIZATION ORDER ONLY. This walk describes the byte layout. It is NOT the
// draw order of any sampler: randomGenotype happens to draw in serialization
// order (a convenience for auditable re-locks) and the live initializer's draw
// table (population-initializer.js) deliberately does NOT — it is its own
// versioned contract with extra interleaved draws.
//
// CLASSIFICATION (`kind`):
//   'version'    — the u16 schema version.
//   'structural' — an array LENGTH written on the wire (segment count, axle
//                  count). Not a [0,1] gene; a mutation operator changes these
//                  only through a structural operator, never by jitter.
//   'discrete'   — a gene whose DECODE crosses a threshold: enum band
//                  (family, suspType), boolean (symmetric, paired, driven), or
//                  slot count (nodeCount). Single-sourced from
//                  DISCRETE_GENE_KEYS; a PARAMETRIC operator must preserve
//                  these verbatim (see that constant's ruling).
//   'continuous' — every other gene leaf: a magnitude a parametric operator
//                  may jitter freely inside [0,1].
//
// LATENT GENES (documented in prose, deliberately NOT schema metadata). Some
// leaves do not reach the compiled phenotype for a given genotype: node slots
// beyond the active `nodeCount` prefix, `nodes[0].gap` (cumulative spacing
// starts at 0), the two inactive `fam` blocks, and the `asym` block under
// symmetry gating. Every one of them is ALWAYS serialized and repair never
// erases them, so they are ordinary continuous genes for both the codec and
// for mutation — latent drift is heritable neutral variation, and the schema
// stays a pure function of axle count. Whether a leaf is EXPRESSED is a
// compile-time question about buildIR, not a property of the byte layout; if a
// consumer ever needs it, it belongs in its own derived helper.

const GENOTYPE_BASE_BYTES = 268; // the fixed prefix: version .. axleCount
const GENOTYPE_AXLE_STRIDE = 128; // 16 f64 per axle (AXLE_GENES + ASYM_GENES)

// The WIRE domain for an axle count: the u8 the canonical stream writes.
// Deliberately narrower than validateGenotype's, which stays uncapped for
// in-memory genotypes (maxAxles is repair POLICY, not a schema bound).
function assertWireAxleCount(axleCount) {
  if (!Number.isInteger(axleCount) || axleCount < 0 || axleCount > 0xff) {
    fail('axleCount', axleCount);
  }
}

/** Exact byte length of the canonical stream for `axleCount` axles. */
export function genotypeByteLength(axleCount) {
  assertWireAxleCount(axleCount);
  return GENOTYPE_BASE_BYTES + GENOTYPE_AXLE_STRIDE * axleCount;
}

// The one walk builder. Statement-for-statement the serializer's order; the
// only data-driven loops are over the declared field lists the serializer
// itself walks (NODE_GENES / AXLE_GENES / ASYM_GENES) — never object key order.
// `g === null` yields the static layout (no `value` fields).
function genotypeEntries(g, axleCount) {
  const entries = [];
  let o = 0;
  const push = (path, key, type, kind, value) => {
    const byteLength = type === 'u16' ? 2 : (type === 'u8' ? 1 : 8);
    const entry = { path, key, type, kind, byteOffset: o, byteLength };
    if (g !== null) entry.value = value;
    entries.push(Object.freeze(entry));
    o += byteLength;
  };
  const gene = (path, key, value) => {
    push(path, key, 'f64', DISCRETE_GENE_KEYS.includes(key) ? 'discrete' : 'continuous', value);
  };
  const seg = g === null ? null : g.frame.segments[0];

  push('version', 'version', 'u16', 'version', g === null ? undefined : g.version);
  gene('hue', 'hue', g === null ? undefined : g.hue);
  gene('symmetric', 'symmetric', g === null ? undefined : g.symmetric);
  gene('power', 'power', g === null ? undefined : g.power);
  gene('frameDensity', 'frameDensity', g === null ? undefined : g.frameDensity);
  gene('frame.family', 'family', g === null ? undefined : g.frame.family);
  push('frame.segments.length', 'segmentCount', 'u8', 'structural',
    g === null ? undefined : g.frame.segments.length);
  gene('frame.segments[0].nodeCount', 'nodeCount', seg === null ? undefined : seg.nodeCount);
  for (let i = 0; i < NODE_SLOTS; i += 1) {
    const node = seg === null ? null : seg.nodes[i];
    for (const k of NODE_GENES) {
      gene(`frame.segments[0].nodes[${i}].${k}`, k, node === null ? undefined : node[k]);
    }
  }
  gene('frame.segments[0].fam.spine.beamWidthFrac', 'beamWidthFrac',
    seg === null ? undefined : seg.fam.spine.beamWidthFrac);
  gene('frame.segments[0].fam.ladder.crossFrac', 'crossFrac',
    seg === null ? undefined : seg.fam.ladder.crossFrac);
  gene('frame.segments[0].fam.hull.bulge', 'bulge',
    seg === null ? undefined : seg.fam.hull.bulge);
  push('axles.length', 'axleCount', 'u8', 'structural', g === null ? undefined : g.axles.length);
  for (let a = 0; a < axleCount; a += 1) {
    const axle = g === null ? null : g.axles[a];
    for (const k of AXLE_GENES) {
      gene(`axles[${a}].${k}`, k, axle === null ? undefined : axle[k]);
    }
    for (const k of ASYM_GENES) {
      gene(`axles[${a}].asym.${k}`, k, axle === null ? undefined : axle.asym[k]);
    }
  }
  return Object.freeze(entries);
}

/**
 * The STATIC field walk for a given axle count — ordered metadata with no
 * genotype instance (documentation, mutation-rate tables, conformance tests).
 * 36 fixed-prefix entries + 16 per axle; offsets tile [0, genotypeByteLength).
 */
export function genotypeFieldWalk(axleCount) {
  assertWireAxleCount(axleCount);
  return genotypeEntries(null, axleCount);
}

/**
 * Visit every field of `genotype` in canonical serialization order, with its
 * raw stored value. Validates first, so a visitor always sees in-domain genes.
 */
export function forEachGenotypeField(genotype, visit) {
  // Walk the CAPTURE: a visitor must see the values that were validated, and
  // the emitted byteOffsets must describe the stream those same values encode
  // to. Reading the caller again here would hand a mutation operator — the
  // intended consumer of this walk — unvalidated genes.
  const g = captureGenotype(genotype);
  // The walk describes the CANONICAL SERIALIZATION order, so its domain is the
  // wire's, not validateGenotype's. Without this, this function would happily
  // emit byteOffsets for a genotype serializeGenotype refuses — metadata
  // describing a stream that cannot exist.
  assertWireAxleCount(g.axles.length);
  if (typeof visit !== 'function') fail('visit', visit);
  for (const entry of genotypeEntries(g, g.axles.length)) visit(entry);
}

// --- Canonical flat DECODING -------------------------------------------------
//
// The exact inverse of serializeGenotype. Fail-loud, never repairing: a
// malformed stream is an error, not something to normalize into the nearest
// legal genotype (that would let a raw or corrupt draw re-enter the population
// layer wearing a canonical face). Raw [0,1] genes are returned bit-exact,
// signed zero included.
//
// Only streams at the CURRENT version decode. The serializer writes
// GENOTYPE_VERSION unconditionally, so accepting an older version would
// either misread bytes or re-encode under a different version and break the
// serialize(deserialize(bytes)) === bytes identity. Reading historical
// versions, if ever needed, is separate append-only work.
//
// WHY THIS ONE READS ITS OWN DataView while the other four decoders share
// bytes.js's createByteReader: the genotype is the only FIXED-LAYOUT format
// here, and its length identity is out of order. The axle count sits at byte
// 267, and reading it up front is what lets `byteLength === expected` reject
// truncation AND trailing bytes in a single check before a single gene is
// read. A sequential cursor would have to consume the preceding 265 bytes to
// reach it, so the same malformed stream would surface as a truncation from
// somewhere inside the node block instead. The exemption is recorded in
// bytes.js's header too, where a reader looking for the shared discipline
// will hit it first.

function decodeFail(path, value) {
  throw new Error(`assembly: invalid encoded genotype at ${path} (${String(value)})`);
}

// Intrinsic TypedArray geometry (the bytes.js idiom, duplicated locally
// because this module keeps ZERO imports by ruling): `buffer`, `byteOffset`
// and `byteLength` are inherited accessors, so an own data property on a
// genuine Uint8Array shadows them and would redirect the DataView to bytes
// outside the array's real window while every check below still passes. The
// prototype getters report the runtime's truth regardless.
const U8_PROTO = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0)));
const u8Geom = (name) => Object.getOwnPropertyDescriptor(U8_PROTO, name).get;
const U8_BUFFER = u8Geom('buffer');
const U8_BYTE_OFFSET = u8Geom('byteOffset');
const U8_BYTE_LENGTH = u8Geom('byteLength');

/** Canonical bytes -> genotype. The exact inverse of serializeGenotype. */
export function deserializeGenotype(bytes) {
  if (!(bytes instanceof Uint8Array)) decodeFail('bytes', bytes);
  const byteLength = U8_BYTE_LENGTH.call(bytes);
  if (byteLength < GENOTYPE_BASE_BYTES) decodeFail('byteLength', byteLength);
  // byteOffset folded in: a subarray of a larger buffer reads its own window.
  const view = new DataView(U8_BUFFER.call(bytes), U8_BYTE_OFFSET.call(bytes), byteLength);
  const version = view.getUint16(0, true);
  if (version !== GENOTYPE_VERSION) decodeFail('version', version);
  const segmentCount = view.getUint8(42);
  if (segmentCount !== 1) decodeFail('frame.segments.length', segmentCount);
  const axleCount = view.getUint8(267);
  // ONE exact-length identity rejects truncation AND trailing bytes: the
  // stream is exactly its content, so any other length is malformed.
  const expected = genotypeByteLength(axleCount);
  if (byteLength !== expected) {
    decodeFail('byteLength', `${byteLength} (expected ${expected} for axleCount ${axleCount})`);
  }
  let o = 2; // version consumed
  const f64 = () => { const v = view.getFloat64(o, true); o += 8; return v; };
  const hue = f64();
  const symmetric = f64();
  const power = f64();
  const frameDensity = f64();
  const family = f64();
  o += 1; // segmentCount consumed (read and checked above)
  const nodeCount = f64();
  const nodes = [];
  for (let i = 0; i < NODE_SLOTS; i += 1) {
    nodes.push({ gap: f64(), height: f64(), halfWidth: f64(), thickness: f64() });
  }
  const beamWidthFrac = f64();
  const crossFrac = f64();
  const bulge = f64();
  o += 1; // axleCount consumed (read and checked above)
  const axles = [];
  for (let a = 0; a < axleCount; a += 1) {
    const axle = {};
    for (const k of AXLE_GENES) axle[k] = f64();
    const asym = {};
    for (const k of ASYM_GENES) asym[k] = f64();
    axle.asym = asym;
    axles.push(axle);
  }
  const genotype = {
    version,
    hue,
    symmetric,
    power,
    frameDensity,
    frame: {
      family,
      segments: [{
        nodeCount,
        nodes,
        fam: { spine: { beamWidthFrac }, ladder: { crossFrac }, hull: { bulge } },
      }],
    },
    axles,
  };
  // A decoded stream must satisfy the same rules as encoder input (the
  // decodeTraceRecord precedent): this is where a NaN / out-of-[0,1] f64
  // patched into the bytes is caught. No repair — validation only.
  validateGenotype(genotype);
  return genotype;
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

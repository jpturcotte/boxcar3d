// Rapier package-pair smoke — a Node-only instrument (outside the src/sim
// ESLint ban), the FIRST command to run against any candidate Rapier package
// pair (a source-built tarball, an npm upgrade, a local patch) BEFORE any
// suite or probe touches it. It answers exactly one question per flavor:
// is the installed package loadable, initializable, and steppable at all —
// thirty seconds here beats a fifteen-minute red wall in the full suite
// when init() itself is broken.
//
// DELIBERATELY ADAPTER-FREE: this smoke imports the two packages by name and
// nothing from src/sim, so it still runs when a candidate engine breaks the
// adapter's API preflights — it tests the PACKAGE, pre-suite. It is NOT a
// determinism gate, a physics gate, or a version assertion:
//   - `version()` is PRINTED, never asserted — a source-built candidate can
//     truthfully report the stable version string (the identity trap: the
//     wasm bakes the crate's CARGO_PKG_VERSION at build time), so tarball
//     hashes + upstream commit SHA are the only reliable engine identity.
//   - the world.timestep f32 readback is PRINTED as an observation; the
//     hard dt-semantics check lives in `npm run probe:timing`.
//   - the only exit-1 conditions are consumability failures: import/init
//     rejects, world construction or stepping throws, the dropped body goes
//     non-finite or fails to fall, or the deterministic flavor's same-config
//     repeat is not bit-identical (a "deterministic" build that lost its
//     determinism feature is not consumable for this project).
//
// USAGE:  node scripts/probe-rapier-package-smoke.js   (npm run probe:package-smoke)

/* eslint no-console: 0 */

const FLAVORS = Object.freeze([
  { name: '@dimforge/rapier3d-compat', deterministic: false },
  { name: '@dimforge/rapier3d-deterministic-compat', deterministic: true },
]);

const STEPS = 10;
const failures = [];

function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

// One fresh world: a static ground slab and a dynamic ball dropped onto it.
// Returns the ball's final pose/velocity after STEPS fixed steps.
function dropRun(RAPIER) {
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  try {
    world.timestep = 1 / 60;
    world.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.5, 5));
    const ball = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 3, 0),
    );
    world.createCollider(RAPIER.ColliderDesc.ball(0.25), ball);
    for (let i = 0; i < STEPS; i += 1) world.step();
    const t = ball.translation();
    const v = ball.linvel();
    return {
      timestepReadback: world.timestep,
      translation: { x: t.x, y: t.y, z: t.z },
      linvel: { x: v.x, y: v.y, z: v.z },
    };
  } finally {
    world.free();
  }
}

const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const bits3 = (a, b) => Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z);

for (const flavor of FLAVORS) {
  console.log(`package ${flavor.name}:`);
  let RAPIER;
  try {
    RAPIER = await import(flavor.name);
    await RAPIER.init();
    check('import + init()', true);
  } catch (err) {
    check('import + init()', false, String(err));
    continue; // nothing below can run for this flavor
  }
  try {
    const version = RAPIER.version();
    // Printed, never asserted (see header) — record it in the spike log.
    console.log(`  version() = ${JSON.stringify(version)} (OBSERVATION — identity lives in tarball hashes)`);
    const run = dropRun(RAPIER);
    console.log(`  world.timestep readback = ${run.timestepReadback} `
      + `(f32(1/60) = ${Math.fround(1 / 60)}: ${run.timestepReadback === Math.fround(1 / 60) ? 'matches' : 'DIFFERS — see probe:timing'})`);
    check(`world constructed + ${STEPS} steps`, true);
    check('final state finite', finite3(run.translation) && finite3(run.linvel),
      `translation y ${run.translation.y}`);
    check('ball fell under gravity', run.translation.y < 3,
      `y ${run.translation.y} (spawned at 3)`);
    if (flavor.deterministic) {
      const repeat = dropRun(RAPIER);
      check('deterministic same-config repeat bit-identical',
        bits3(run.translation, repeat.translation) && bits3(run.linvel, repeat.linvel),
        `y ${run.translation.y} vs ${repeat.translation.y}`);
    }
  } catch (err) {
    check('world construction / stepping', false, String(err));
  }
}

if (failures.length > 0) {
  console.log(`\nSMOKE FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nSMOKE OK — both flavors loadable, steppable, finite'
  + ' (deterministic flavor repeat bit-identical)');

// Rapier engine probe: World.timing*() profiler semantics + timestep readback
// (NOT a test file; vitest collects tests/**/*.test.js only). Run with:
//
//     npm run probe:timing        (= node scripts/probe-rapier-timing.js)
//
// Purpose: the evaluation runner, the physics benchmark, and the phase0-refresh
// §2.4 documentation all lean on ENGINE timing semantics that the typings alone
// do not establish. This instrument measures them against the pinned engine
// (rapier 0.19.3, BOTH flavors) and flags DRIFT if a future Rapier upgrade
// changes any of them. Every expectation below was first measured 2026-07-11:
//
//   1. World.prototype exposes 16 timing*() INSTANCE METHODS (not properties,
//      no static World.timing*) plus a `profilerEnabled` get/set accessor
//      defaulting false.
//   2. Profiling must be enabled: with it off, timingStep()/collision/solver/
//      CCD read 0 (a few sub-timers tick anyway). An unstepped world reads 0.
//   3. Enabled values are PER-STEP MILLISECONDS (2000-step sum brackets the
//      wall clock), STABLE across repeated reads (reading does not reset).
//      The FIRST STEP IN A FRESH MODULE carries a ~1.5 ms warm-up spike — it
//      lands on whichever world steps first (profiler or not) and is NOT
//      re-triggered by disabling/re-enabling the profiler, so benchmark
//      warm-up runs absorb it once per flavor module.
//   4. Disabling FREEZES values at their last state; re-enabling resumes
//      without a new spike.
//   5. Components do NOT sum to timingStep() — it is the authoritative total.
//   6. world.timestep = 1/60 reads back Math.fround(1/60) = 0.016666667535...,
//      NOT the f64 1/60; the readback is stable and set(readback) is
//      idempotent. The runner's dt tooth asserts THIS measured contract.
//
// This probe is deliberately independent of src/sim/physics/adapter.js — it
// documents the raw engine, which the adapter seam is itself tested against.

const FIXED_DT = 1 / 60; // the adapter's declared value (src/sim/physics/adapter.js)

const FLAVORS = [
  ['default', '@dimforge/rapier3d-compat'],
  ['deterministic', '@dimforge/rapier3d-deterministic-compat'],
];

// Expected member set (measured 2026-07-11, rapier 0.19.3). A upgrade that
// adds/renames timers should show up as DRIFT here, not silently.
const EXPECTED_TIMING_METHODS = [
  'timingStep',
  'timingCollisionDetection', 'timingBroadPhase', 'timingNarrowPhase',
  'timingSolver', 'timingVelocityAssembly', 'timingVelocityResolution',
  'timingVelocityUpdate', 'timingVelocityWriteback',
  'timingCcd', 'timingCcdToiComputation', 'timingCcdBroadPhase',
  'timingCcdNarrowPhase', 'timingCcdSolver',
  'timingIslandConstruction', 'timingUserChanges',
];

const results = [];
function check(flavor, name, ok, detail) {
  results.push({ flavor, name, ok, detail });
  console.log(`  ${ok ? 'OK   ' : 'DRIFT'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function buildTinyWorld(RAPIER) {
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
  world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.1, 10), ground);
  return { world, body, ground };
}

async function probeFlavor(label, pkg) {
  console.log(`\n## ${label} flavor (${pkg})\n`);
  const RAPIER = (await import(pkg)).default;
  await RAPIER.init();

  // --- 1. member surface ----------------------------------------------------
  const proto = RAPIER.World.prototype;
  const timingMethods = Object.getOwnPropertyNames(proto)
    .filter((n) => /^timing/.test(n))
    .sort();
  check(label, 'timing member set matches 0.19.3 measurement',
    JSON.stringify(timingMethods) === JSON.stringify([...EXPECTED_TIMING_METHODS].sort()),
    `${timingMethods.length} methods`);
  check(label, 'every timing* member is an instance method',
    timingMethods.every((n) => typeof Object.getOwnPropertyDescriptor(proto, n).value === 'function'));
  const profDesc = Object.getOwnPropertyDescriptor(proto, 'profilerEnabled');
  check(label, 'profilerEnabled is a get/set accessor',
    profDesc && typeof profDesc.get === 'function' && typeof profDesc.set === 'function');

  // --- 2. profiler on, FIRST stepping in this module -------------------------
  // Runs before any other world.step() so the module warm-up spike is
  // observable: it attaches to the module's first step, not to profiler
  // enablement (re-enabling later does not re-trigger it — checked below).
  let moduleFirstStepMs;
  {
    const { world } = buildTinyWorld(RAPIER);
    check(label, 'profilerEnabled defaults to false', world.profilerEnabled === false);
    check(label, 'unstepped world: every timer reads 0',
      timingMethods.every((n) => world[n]() === 0));
    world.profilerEnabled = true;
    check(label, 'profilerEnabled sticks after set', world.profilerEnabled === true);

    const perStep = [];
    for (let i = 0; i < 5; i += 1) { world.step(); perStep.push(world.timingStep()); }
    [moduleFirstStepMs] = perStep;
    check(label, 'first step in a fresh module carries a warm-up spike',
      perStep[0] > perStep[4] * 5,
      `first ${perStep[0].toFixed(4)} ms vs fifth ${perStep[4].toFixed(4)} ms`);
    check(label, 'values are per-step (later reads do not accumulate)',
      perStep[4] < perStep[0],
      JSON.stringify(perStep.map((v) => Number(v.toFixed(4)))));
    const a = world.timingStep();
    const b = world.timingStep();
    check(label, 'repeated reads are stable (reading does not reset)', a === b);

    const componentSum = world.timingCollisionDetection() + world.timingSolver()
      + world.timingCcd() + world.timingIslandConstruction() + world.timingUserChanges();
    check(label, 'components do NOT sum to timingStep (total is authoritative)',
      world.timingStep() > componentSum,
      `step ${world.timingStep().toFixed(4)} ms vs component sum ${componentSum.toFixed(4)} ms`);

    // Units evidence: sum of per-step reads over 2000 steps brackets the wall
    // clock if and only if the unit is milliseconds.
    let sum = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i += 1) { world.step(); sum += world.timingStep(); }
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    check(label, 'units are milliseconds (2000-step sum brackets wall clock)',
      sum > wallMs * 0.2 && sum < wallMs * 1.5,
      `sum ${sum.toFixed(2)} ms vs wall ${wallMs.toFixed(2)} ms`);

    world.profilerEnabled = false;
    const frozen = world.timingStep();
    const frozenReads = [];
    for (let i = 0; i < 4; i += 1) { world.step(); frozenReads.push(world.timingStep()); }
    check(label, 'disable FREEZES values at their last state',
      frozenReads.every((v) => v === frozen));
    world.profilerEnabled = true;
    world.step();
    const resumed = world.timingStep();
    check(label, 're-enable resumes per-step updates', resumed !== frozen);
    check(label, 're-enable does NOT re-trigger the warm-up spike',
      resumed < moduleFirstStepMs / 5,
      `resumed ${resumed.toFixed(4)} ms vs module-first ${moduleFirstStepMs.toFixed(4)} ms`);
    world.free();
  }

  // --- 3. profiler off ------------------------------------------------------
  {
    const { world } = buildTinyWorld(RAPIER);
    for (let i = 0; i < 3; i += 1) world.step();
    const mainTimersOff = ['timingStep', 'timingCollisionDetection', 'timingSolver', 'timingCcd'];
    check(label, 'profiler off after stepping: main timers read 0',
      mainTimersOff.every((n) => world[n]() === 0));
    const tickingWhileOff = timingMethods.filter((n) => world[n]() !== 0);
    console.log(`         (sub-timers ticking while off: ${tickingWhileOff.join(', ') || 'none'})`);
    world.free();
  }

  // --- 6. timestep readback --------------------------------------------------
  let effectiveDt;
  {
    const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    const defaultDt = world.timestep;
    check(label, 'default timestep is already the f32-rounded 1/60',
      defaultDt === Math.fround(1 / 60), `default ${defaultDt}`);
    world.timestep = FIXED_DT;
    effectiveDt = world.timestep;
    check(label, 'set 1/60 reads back Math.fround(1/60), NOT the f64 1/60',
      effectiveDt === Math.fround(FIXED_DT) && effectiveDt !== FIXED_DT,
      `readback ${effectiveDt}`);
    check(label, 'readback is stable across reads', world.timestep === effectiveDt);
    world.timestep = effectiveDt;
    check(label, 'set(readback) is idempotent', world.timestep === effectiveDt);
    world.free();
  }

  // --- API presence the trace contract depends on -----------------------------
  {
    const { world, body, ground } = buildTinyWorld(RAPIER);
    const joint = world.createImpulseJoint(
      RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 1 }),
      ground, body, true,
    );
    check(label, 'RigidBody.isValid() present and true', body.isValid() === true);
    check(label, 'RigidBody.isSleeping() present and boolean', typeof body.isSleeping() === 'boolean');
    check(label, 'ImpulseJoint.isValid() present and true', joint.isValid() === true);
    world.free();
  }

  return { timingMethods, effectiveDt };
}

const perFlavor = [];
for (const [label, pkg] of FLAVORS) {
  perFlavor.push(await probeFlavor(label, pkg));
}

console.log('\n## Cross-flavor\n');
check('both', 'timing member sets identical across flavors',
  JSON.stringify(perFlavor[0].timingMethods) === JSON.stringify(perFlavor[1].timingMethods));
check('both', 'timestep readback identical across flavors',
  Object.is(perFlavor[0].effectiveDt, perFlavor[1].effectiveDt),
  `effectiveDt ${perFlavor[0].effectiveDt}`);

const drift = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${drift.length} DRIFT`);
if (drift.length > 0) {
  console.log('Engine semantics drifted from the 2026-07-11 measurement — re-derive');
  console.log('the affected rulings (runner dt tooth, benchmark profiler policy,');
  console.log('phase0-refresh §2.4) before trusting downstream numbers.');
  process.exit(1);
}

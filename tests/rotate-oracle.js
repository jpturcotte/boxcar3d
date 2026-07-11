// Independent quaternion-vector rotation oracle for the S0 pose/anchor tests.
//
// The adapter's private rotateByQuat (src/sim/physics/adapter.js) is the
// optimized t = 2·q×v expansion. If a test computed its EXPECTED poses with a
// byte-identical copy of that expansion, a sign or ordering slip in the
// kernel would corrupt the code AND its oracle in lockstep — the tests would
// stay green while the wheels moved to the wrong world positions. So this
// oracle uses the full quaternion SANDWICH v' = q ⊗ (0,v) ⊗ conj(q) via a
// non-normalizing Hamilton product — a structurally different computation,
// sharing no lines with the expansion under test. Single-sourced here so the
// two S0 test files don't re-copy it (and so this stays independent).
//
// Not named `*.test.js`, so Vitest does not collect it as a suite.

// Non-normalizing Hamilton product a ⊗ b (features.js's quatMultiply
// renormalizes to unit length, which would destroy a pure quaternion's vector
// magnitude — unusable for the sandwich, hence this local product).
function hamilton(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function rotateVector(q, v) {
  const p = { x: v.x, y: v.y, z: v.z, w: 0 };
  const conj = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  const r = hamilton(hamilton(q, p), conj);
  return { x: r.x, y: r.y, z: r.z };
}

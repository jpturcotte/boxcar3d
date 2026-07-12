// Phase 1 boot: the composite corridor with a live MIXED S0/S1 vehicle.
// Generates the deterministic terrain (src/sim/terrain.js), realizes floor +
// walls + seated feature colliders through the adapter seam, and drops one
// compiled vehicle at the start line — rigid S0 front axle, spring-damper S1
// rear axle (chassis → prismatic → hub → revolute → wheel), all native joint
// motors, no steering, no AI. Meshes are built from the SAME IR dims and
// realized poses the colliders use, so the visible vehicle cannot drift from
// the physics; the S1 hubs are INVISIBLE (policy bodies) but each rear
// station renders a thin strut from its chassis anchor to its hub so the
// suspension travel is visible, and the HUD prints the live rear prismatic
// coordinate (via the pure projection — the engine has no readback). Render
// code READS body poses only — it never writes physics. Seeded debris cubes
// still fall as the terrain-agreement proof. Add ?zones to tint zone cells.

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import {
  createPhysics, addCorridorWithFeatures, realizeVehicle, FIXED_DT,
  SOFT_CCD_PREDICTION, WHEEL_COLLIDER_ROTATION, SUSPENSION_AXIS,
  projectedPrismaticCoordinate, suspensionAnchorLocal, vehicleWheelTransforms,
} from './sim/physics/adapter.js';
import { MATERIALS, generateCorridorTerrain, heightAtLocal, indexToLocalXZ } from './sim/terrain.js';
import { compileAssembly } from './sim/assembly.js';
import { Rng } from './sim/prng.js';

const SEED = 20260708;
const hud = document.getElementById('hud');

// Build a Three mesh from the heightfield using the SAME col->+X / row->+Z
// mapping the collider uses (indexToLocalXZ), so the visible surface cannot
// drift from the physics surface.
function buildTerrainMesh(terrain) {
  const { rows, cols, heights, scale } = terrain;
  const positions = new Float32Array((rows + 1) * (cols + 1) * 3);
  const vid = (row, col) => row * (cols + 1) + col;
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const { x, z } = indexToLocalXZ(row, col, terrain);
      const o = vid(row, col) * 3;
      positions[o] = x;
      positions[o + 1] = heights[col * (rows + 1) + row] * scale.y;
      positions[o + 2] = z;
    }
  }
  const indices = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const a = vid(row, col);
      const b = vid(row, col + 1);
      const c = vid(row + 1, col);
      const d = vid(row + 1, col + 1);
      indices.push(a, c, b, b, c, d); // up-facing winding
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Translucent overlay quads over the non-firm zone cells (dev aid, behind the
// ?zones URL flag): one pair of triangles per cell, corners lifted 2 cm above
// the terrain surface, tinted per material.
const ZONE_TINTS = { [MATERIALS.SAND]: new THREE.Color(0xd9c66b), [MATERIALS.MUD]: new THREE.Color(0x5c4033) };

function buildZoneOverlay(terrain) {
  const { rows, heights, scale, zones } = terrain;
  const h = (row, col) => heights[col * (rows + 1) + row] * scale.y + 0.02;
  const positions = [];
  const colors = [];
  for (let col = 0; col < zones.cols; col++) {
    for (let row = 0; row < zones.rows; row++) {
      const material = zones.materials[col * zones.rows + row];
      if (material === MATERIALS.FIRM) continue;
      const tint = ZONE_TINTS[material];
      const a = { ...indexToLocalXZ(row, col, terrain), y: h(row, col) };
      const b = { ...indexToLocalXZ(row, col + 1, terrain), y: h(row, col + 1) };
      const c = { ...indexToLocalXZ(row + 1, col, terrain), y: h(row + 1, col) };
      const d = { ...indexToLocalXZ(row + 1, col + 1, terrain), y: h(row + 1, col + 1) };
      for (const v of [a, c, b, b, c, d]) {
        positions.push(v.x, v.y, v.z);
        colors.push(tint.r, tint.g, tint.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false })
  );
}

// Static feature meshes from the REALIZED records (seated pose + the exact
// hull points / half-extents the colliders use). Never rebuilt per frame.
const FEATURE_TINTS = { boulder: 0x8a8478, ramp: 0x9a7b4f, log: 0x6b4a2f };

function buildFeatureMesh(realized) {
  const { feature, position, rotation, points, shape } = realized;
  let geo;
  if (shape.kind === 'convexHull') {
    const verts = [];
    for (let i = 0; i < points.length; i += 3) verts.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
    geo = new ConvexGeometry(verts);
  } else if (shape.kind === 'cuboid') {
    geo = new THREE.BoxGeometry(shape.hx * 2, shape.hy * 2, shape.hz * 2);
  } else {
    // CapsuleGeometry's `length` is the cylindrical mid-section, matching
    // Rapier's capsule(halfHeight, radius) axis exactly (both along local Y).
    geo = new THREE.CapsuleGeometry(shape.radius, shape.halfHeight * 2, 6, 16);
  }
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: FEATURE_TINTS[feature.type] }));
  mesh.position.set(position.x, position.y, position.z);
  mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  return mesh;
}

// Chassis meshes are built from the SAME IR colliders the physics body uses
// (BoxGeometry per cuboid / ConvexGeometry from the exact fround'd hull
// points), tinted from gene[0] (hue) — the SALVAGE render-tint convention.
function buildChassisMesh(ir) {
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(ir.render.hue, 0.7, 0.55),
  });
  const group = new THREE.Group();
  for (const c of ir.chassis.colliders) {
    let mesh;
    if (c.kind === 'cuboid') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2), material);
      mesh.position.set(c.cx, c.cy, c.cz);
      mesh.quaternion.set(c.rot.x, c.rot.y, c.rot.z, c.rot.w);
    } else if (c.kind === 'convexHull') {
      const verts = [];
      for (let i = 0; i < c.points.length; i += 3) {
        verts.push(new THREE.Vector3(c.points[i], c.points[i + 1], c.points[i + 2]));
      }
      mesh = new THREE.Mesh(new ConvexGeometry(verts), material);
    } else {
      // Explicit, like realizeChassis: a future collider kind must fail loud
      // here, not silently render as a hull of undefined points.
      throw new Error(`buildChassisMesh: unknown collider kind '${c && c.kind}'`);
    }
    group.add(mesh);
  }
  return group;
}

async function boot() {
  const { RAPIER, world } = await createPhysics({ deterministic: false });
  const terrain = generateCorridorTerrain({ seed: SEED });
  const { features } = addCorridorWithFeatures(RAPIER, world, terrain);

  // --- Three scene (r185 defaults: color management on, physical lights) ---
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const bg = new THREE.Color(0x0f1116);
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 45, 150); // far corridor fades into depth

  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(-terrain.scale.x / 2 - 12, 14, 16); // behind-left of the start line
  camera.lookAt(-terrain.scale.x / 2 + 22, 0, 0); // gaze down +X, chassis spawn in frame

  scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x1c2a1e, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-20, 24, 14);
  scene.add(sun);

  // --- Corridor floor + walls ---
  const floorMesh = new THREE.Mesh(
    buildTerrainMesh(terrain),
    new THREE.MeshLambertMaterial({ color: 0x4a7c4a, side: THREE.DoubleSide })
  );
  scene.add(floorMesh);

  for (const w of terrain.walls) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(w.half.x * 2, w.half.y * 2, w.half.z * 2),
      new THREE.MeshLambertMaterial({ color: 0x565c6b })
    );
    wall.position.set(w.pos.x, w.pos.y, w.pos.z);
    scene.add(wall);
  }

  // --- Seated features (static: positioned once from the realized poses) ---
  for (const realized of features) scene.add(buildFeatureMesh(realized));

  // --- Zone debug overlay (dev flag: append ?zones to the URL) ---
  const showZones = new URLSearchParams(window.location.search).has('zones');
  if (showZones) scene.add(buildZoneOverlay(terrain));

  // --- One compiled MIXED S0/S1 vehicle driving from the start line ---
  // A DECLARED hand-built genotype (every gene explicit, repair-stable —
  // the s0/s1-kernel fixture-family proofs): a rigid S0 front axle and a
  // sprung S1 rear axle on the low spine frame the S0 dev build tuned
  // (power 1 ⇒ full 500 N·m budget, wheel r 0.4 m, ~267 kg chassis,
  // thrust/weight ~23% — under ~6% stalls on the start-blend grade, measured
  // 2026-07-10; the old shared-target mixed-radius fight is CLOSED by the
  // per-wheel surface-speed law — these r 0.4 wheels now run ω = −5/0.4 =
  // −12.5 rad/s, no-load surface speed 5 m/s, was the shared −10 rad/s).
  // Rear suspension genes: k ≈ 17.8 kN/m (gene 0.33),
  // c ≈ 500 N·s/m (0.1), travel 0.3 m (0.75), rest 0.18 m (0.29) — about
  // 0.08 m of static sag under the ~1.3 kN rear corner load, mid-travel
  // margins both ways.
  const vehicleGenotype = {
    version: 1,
    hue: 0.25,
    symmetric: 0.9, // symmetric build
    power: 1, // full global budget: 500 N·m split across 4 driven wheels
    frameDensity: 0.1, // light frame — thrust/weight is what climbs grades
    frame: {
      family: 0.1, // spine
      segments: [{
        nodeCount: 0.5, // 4 active nodes
        nodes: Array.from({ length: 6 }, () => ({ gap: 0.5, height: 0.3, halfWidth: 0.5, thickness: 0.5 })),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [
      { // front: rigid S0
        posX01: 0.2, paired: 1, trackHalf: 0.5,
        radius: 0.4, width: 0.5, density: 0.15,
        suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
        driven: 1, share: 0.5,
        asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
      },
      { // rear: S1 vertical spring-damper (chassis → prismatic → hub → revolute → wheel)
        posX01: 0.8, paired: 1, trackHalf: 0.5,
        radius: 0.4, width: 0.5, density: 0.15,
        suspType: 0.5, stiffness: 0.33, damping: 0.1, travel: 0.75, restLength: 0.29,
        driven: 1, share: 0.5,
        asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
      },
    ],
  };
  const vehicleIR = compileAssembly(vehicleGenotype);
  const spawnX = -terrain.scale.x / 2 + 8;
  // Spawn height from the PLACEMENT PLAN, not just the wheel radius: an S1
  // wheel spawns at its quiescent prismatic coordinate BELOW the chassis
  // anchor, so the lowest wheel-bottom (local.y − radius) sets the drop.
  const wheelDrop = Math.max(
    ...vehicleWheelTransforms(vehicleIR, {}).map(
      (p) => -p.local.y + vehicleIR.axles[p.axleIndex].wheels[p.wheelIndex].radius
    )
  );
  // Placed just above the local surface (a short drop), not lobbed from the
  // sky — the witness is driving, not falling.
  const vehicle = realizeVehicle(RAPIER, world, vehicleIR, {
    position: { x: spawnX, y: heightAtLocal(spawnX, 0, terrain) + wheelDrop + 0.5, z: 0 },
  });
  const chassisBody = vehicle.chassis.body;
  const chassisMesh = buildChassisMesh(vehicleIR);
  scene.add(chassisMesh);
  // Wheel meshes from the SAME IR dims the colliders use. Three cylinders and
  // Rapier cylinders share the local-Y axis, so each mesh takes its body's
  // rotation composed with the same collider-local Y→Z rotation the physics
  // applies (WHEEL_COLLIDER_ROTATION) — render and contact cannot disagree.
  // (S1 wheel bodies keep the same base-rotation contract, so nothing here
  // branches on suspension type.)
  const wheelColliderQuat = new THREE.Quaternion(
    WHEEL_COLLIDER_ROTATION.x, WHEEL_COLLIDER_ROTATION.y, WHEEL_COLLIDER_ROTATION.z, WHEEL_COLLIDER_ROTATION.w
  );
  const wheelMaterial = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(vehicleIR.render.hue, 0.55, 0.32), // darker of the body hue
  });
  const wheelMeshes = vehicle.wheels.map(({ wheel, irWheel }) => {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(irWheel.radius, irWheel.radius, irWheel.width, 24),
      wheelMaterial
    );
    scene.add(mesh);
    return { mesh, body: wheel.body };
  });
  // Suspension struts: one thin bright link per S1 station, drawn from the
  // chassis-local full-compression anchor to the (invisible) hub body — the
  // visible suspension travel. Pure readback rendering: position/orient the
  // mesh from body poses; NOTHING here writes physics.
  const strutGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1, 8);
  strutGeometry.translate(0, -0.5, 0); // origin at the top so it hangs from the anchor
  const strutMaterial = new THREE.MeshBasicMaterial({ color: 0x7dff6a });
  const DOWN = new THREE.Vector3(0, -1, 0);
  const struts = vehicle.wheels
    .filter((st) => st.suspensionType === 'S1')
    .map((st) => {
      const mesh = new THREE.Mesh(strutGeometry, strutMaterial);
      scene.add(mesh);
      return {
        mesh,
        hubBody: st.hub.body,
        anchorLocal: suspensionAnchorLocal(vehicleIR.axles[st.axleIndex], st.irWheel),
      };
    });
  const strutAnchor = new THREE.Vector3();
  const strutDir = new THREE.Vector3();
  const chassisQuat = new THREE.Quaternion();

  // --- Seeded debris: cubes dropped onto the corridor (deterministic layout) ---
  const rng = new Rng(0xb0c3d001);
  const debris = [];
  const spanX = terrain.scale.x / 2 - 20; // stay off the very ends
  for (let i = 0; i < 14; i++) {
    const s = rng.fork(i);
    const x = s.range(-spanX + 6, -spanX + 46); // scattered along the first stretch
    const z = s.range(-terrain.scale.z / 2 + 2, terrain.scale.z / 2 - 2);
    const y = s.range(7, 12);
    const size = s.range(0.3, 0.7);
    // Dual-CCD policy covers EVERY dynamic body, dev debris included: hard
    // CCD alone is inert against the heightfield (the PR #9 finding), and a
    // 12 m drop into the deepest crater reaches ~23 m/s — the tunneling
    // threshold.
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setCcdEnabled(true)
        .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(size, size, size), body);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size * 2, size * 2, size * 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.09 + i * 0.02, 0.6, 0.55) })
    );
    scene.add(mesh);
    debris.push({ body, mesh });
  }

  // --- Fixed-timestep accumulator (the pattern that ships; spec §2.3) ---
  let accumulator = 0;
  let stepCount = 0;
  let last = performance.now();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    accumulator += Math.min((now - last) / 1000, 0.25); // clamp huge tab-switch deltas
    last = now;

    while (accumulator >= FIXED_DT) {
      world.step();
      stepCount++;
      accumulator -= FIXED_DT;
    }

    for (const { body, mesh } of debris) {
      const p = body.translation();
      const q = body.rotation();
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
    const cp = chassisBody.translation();
    const cq = chassisBody.rotation();
    chassisMesh.position.set(cp.x, cp.y, cp.z);
    chassisMesh.quaternion.set(cq.x, cq.y, cq.z, cq.w);
    for (const { mesh, body } of wheelMeshes) {
      const p = body.translation();
      const q = body.rotation();
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w).multiply(wheelColliderQuat);
    }
    // Struts: anchor (chassis pose applied to the local anchor) → hub body.
    chassisQuat.set(cq.x, cq.y, cq.z, cq.w);
    for (const { mesh, hubBody, anchorLocal } of struts) {
      strutAnchor.set(anchorLocal.x, anchorLocal.y, anchorLocal.z).applyQuaternion(chassisQuat);
      strutAnchor.x += cp.x;
      strutAnchor.y += cp.y;
      strutAnchor.z += cp.z;
      const hp = hubBody.translation();
      strutDir.set(hp.x, hp.y, hp.z).sub(strutAnchor);
      const len = strutDir.length();
      mesh.position.copy(strutAnchor);
      // At full compression the hub coincides with the anchor (len → 0). Three
      // r185 is NaN-safe here (normalize() divides by `length || 1`, leaving a
      // zero vector zero, and setFromUnitVectors(DOWN, zero) → identity), but
      // orient explicitly only when there is a real direction — clearer intent
      // than relying on the fallback, and the strut just points DOWN when flat.
      if (len > 1e-6) mesh.quaternion.setFromUnitVectors(DOWN, strutDir.divideScalar(len));
      else mesh.quaternion.identity();
      mesh.scale.set(1, Math.max(len, 0.02), 1);
    }
    // Live rear prismatic coordinate through the pure projection (the engine
    // exposes no readback) — the free correctness eyeball: it sags under
    // load and breathes over bumps.
    const rear = struts[0];
    const rearQ = rear
      ? projectedPrismaticCoordinate(
          { position: cp, rotation: cq },
          { position: rear.hubBody.translation(), rotation: rear.hubBody.rotation() },
          rear.anchorLocal, { x: 0, y: 0, z: 0 }, SUSPENSION_AXIS
        )
      : 0;

    hud.textContent = `corridor · seed ${SEED} · ${features.length} features · ${vehicleIR.chassis.family} S0+S1, ${vehicle.wheels.length} wheels, x=${cp.x.toFixed(1)}, rearQ=${rearQ.toFixed(3)}${showZones ? ' · zones' : ''} · rapier 0.19.3 · three r185 · fixed steps: ${stepCount}`;
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

boot().catch((err) => {
  hud.textContent = `boot failed: ${err.message}`;
  console.error(err);
});

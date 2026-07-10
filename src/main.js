// Phase 1 boot: the composite corridor. Generates the deterministic terrain
// (src/sim/terrain.js), realizes floor + walls + seated feature colliders in
// Rapier through the adapter seam, and renders the matching meshes with Three
// r185 — feature meshes are built from the SAME realized poses and hull points
// the colliders use, so the visible rocks/ramps/logs cannot drift from the
// physics. A handful of seeded debris cubes fall onto the floor as a live
// proof that terrain and physics agree. Add ?zones to the URL to tint the
// sand/mud cells of the zone map. Render code may use the wall clock and
// Math.* freely (the determinism ban is scoped to src/sim).

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { createPhysics, addCorridorWithFeatures, realizeChassis, FIXED_DT } from './sim/physics/adapter.js';
import { MATERIALS, generateCorridorTerrain, indexToLocalXZ } from './sim/terrain.js';
import { compileAssembly, randomGenotype } from './sim/assembly.js';
import { Rng } from './sim/prng.js';

const SEED = 20260708;
const CHASSIS_SEED = 20260710; // the assembly-corpus seed family (PR #10)
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

// One compiled chassis (PR #10: assembly compiler v0 — chassis only, no
// wheels yet). Meshes are built from the SAME IR colliders the physics body
// uses (BoxGeometry per cuboid / ConvexGeometry from the exact fround'd hull
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

  // --- One compiled chassis dropped near the start line (PR #10) ---
  // fork(9) is a declared deterministic pick: a 7-collider ladder frame with
  // 4 axle modules — visually unmistakable as a compiled frame (fork 0 is a
  // single-cuboid 0-axle sled, which reads as just another feature box).
  const chassisIR = compileAssembly(randomGenotype(new Rng(CHASSIS_SEED).fork(9)));
  const { body: chassisBody } = realizeChassis(RAPIER, world, chassisIR, {
    position: { x: -terrain.scale.x / 2 + 8, y: terrain.bounds.maxY + 6, z: 0 },
  });
  const chassisMesh = buildChassisMesh(chassisIR);
  scene.add(chassisMesh);

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
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setCcdEnabled(true)
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

    hud.textContent = `corridor · seed ${SEED} · ${features.length} features · chassis: ${chassisIR.chassis.family}${showZones ? ' · zones' : ''} · rapier 0.19.3 · three r185 · fixed steps: ${stepCount}`;
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

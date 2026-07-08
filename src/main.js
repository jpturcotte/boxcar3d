// Phase 1 boot: the corridor floor. Generates the deterministic terrain
// (src/sim/terrain.js), realizes it in Rapier through the adapter seam, and
// renders the matching heightfield + walls with Three r185. A handful of seeded
// debris cubes fall onto the floor as a live proof that terrain and physics
// agree. Render code may use the wall clock and Math.* freely (the determinism
// ban is scoped to src/sim).

import * as THREE from 'three';
import { createPhysics, addCorridor, FIXED_DT } from './sim/physics/adapter.js';
import { generateCorridorTerrain, indexToLocalXZ } from './sim/terrain.js';
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

async function boot() {
  const { RAPIER, world } = await createPhysics({ deterministic: false });
  const terrain = generateCorridorTerrain({ seed: SEED });
  addCorridor(RAPIER, world, terrain);

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
  camera.position.set(-terrain.scale.x / 2 - 10, 15, 20); // behind-left of the start line
  camera.lookAt(-terrain.scale.x / 2 + 30, 0, 0); // gaze down +X, the corridor length

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

    hud.textContent = `corridor · seed ${SEED} · rapier 0.19.3 · three r185 · fixed steps: ${stepCount}`;
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

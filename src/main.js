// Toolchain smoke test — proves the whole stack in one screen:
// Vite bundling, Three r185 (ES modules, physical lighting), Rapier WASM init,
// the fixed-timestep accumulator pattern (spec §2.3), and seeded Rng placement.
// This file is replaced by the real boot in Phase 1; the patterns here are the
// ones the real code must keep.

import * as THREE from 'three';
import { createPhysics, FIXED_DT } from './sim/physics/adapter.js';
import { Rng } from './sim/prng.js';

const hud = document.getElementById('hud');

async function boot() {
  const { RAPIER, world } = await createPhysics({ deterministic: false });

  // --- Three scene (r185 defaults: color management on, physical lights) ---
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11151a);
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(-14, 9, 16);
  camera.lookAt(0, 1, 0);

  scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x1c2a1e, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(8, 14, 6);
  scene.add(sun);

  // --- Ground: one Rapier cuboid + matching mesh ---
  world.createCollider(RAPIER.ColliderDesc.cuboid(12, 0.2, 12));
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(24, 0.4, 24),
    new THREE.MeshLambertMaterial({ color: 0x3e5c43 })
  );
  scene.add(ground);

  // --- Seeded debris field: Rng-placed falling cubes (deterministic layout) ---
  const rng = new Rng(0xb0c3d001);
  const bodies = [];
  for (let i = 0; i < 10; i++) {
    const streamRng = rng.fork(i); // per-object stream, the pattern vehicles will use
    const x = streamRng.range(-6, 6);
    const z = streamRng.range(-6, 6);
    const y = streamRng.range(3, 9);
    const s = streamRng.range(0.3, 0.8);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setCcdEnabled(true)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(s, s, s), body);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(s * 2, s * 2, s * 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.09 + i * 0.02, 0.65, 0.55) })
    );
    scene.add(mesh);
    bodies.push({ body, mesh });
  }

  // --- Fixed-timestep accumulator (the pattern that ships) ---
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

    for (const { body, mesh } of bodies) {
      const p = body.translation();
      const q = body.rotation();
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }

    hud.textContent = `toolchain OK · rapier 0.19.3 · three r185 · fixed steps: ${stepCount}`;
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

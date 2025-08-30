import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsController } from './PhysicsController.js';

describe('Terrain Integrity Test', () => {
    let physicsController;
    let world;

    beforeAll(async () => {
        await RAPIER.init({});
        physicsController = new PhysicsController(RAPIER);
        physicsController.initialize(); // This creates the terrain
        world = physicsController.world;
    });

    it('should prevent spheres from falling through the terrain', () => {
        const NUM_SPHERES = 20;
        const SPHERE_RADIUS = 0.5;
        const spheres = [];

        // Create 100 spheres at various positions above the terrain
        for (let i = 0; i < NUM_SPHERES; i++) {
            const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
                Math.random() * 400 - 200, // Random x between -200 and 200
                30.0, // Start high above the terrain
                Math.random() * 400 - 200  // Random z between -200 and 200
            );
            const rigidBody = world.createRigidBody(rigidBodyDesc);
            const colliderDesc = RAPIER.ColliderDesc.ball(SPHERE_RADIUS);
            world.createCollider(colliderDesc, rigidBody);
            spheres.push(rigidBody);
        }

        // Run the simulation for a number of steps
        const SIMULATION_STEPS = 100;
        for (let i = 0; i < SIMULATION_STEPS; i++) {
            world.step();
        }

        // Check the final position of each sphere
        let failures = 0;
        for (const sphere of spheres) {
            const position = sphere.translation();
            // The lowest point of the terrain is around -7.5.
            // We give a generous buffer and fail if it's below -10.
            if (position.y < -10.0) {
                failures++;
                console.warn(`Sphere fell through at x: ${position.x}, z: ${position.z}, y: ${position.y}`);
            }
        }

        expect(failures).toBe(0, `${failures} out of ${NUM_SPHERES} spheres fell through the terrain.`);
    });
});

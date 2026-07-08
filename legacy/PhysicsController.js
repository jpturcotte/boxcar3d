import { TerrainFactory } from './TerrainFactory.js';

export class PhysicsController {
    /**
     * @param {RAPIER} RAPIER - The RAPIER module instance.
     */
    constructor(RAPIER) {
        this.RAPIER = RAPIER;
        const gravity = new RAPIER.Vector3(0.0, -9.81, 0.0);
        this.world = new RAPIER.World(gravity);
    }

    /**
     * Initializes the physics world with static objects like terrain.
     */
    initialize() {
        const terrainColliderDesc = TerrainFactory.createTerrain();
        this.world.createCollider(terrainColliderDesc);
        console.log('Physics world initialized with terrain.');
    }

    /**
     * Advances the physics simulation by one step.
     */
    step() {
        this.world.step();
    }
}

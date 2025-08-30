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
     * Creates a rigid body and its collider in the world.
     * @param {RAPIER.RigidBodyDesc} rigidBodyDesc - The description of the rigid body.
     * @param {RAPIER.ColliderDesc} colliderDesc - The description of the collider.
     * @returns {RAPIER.RigidBody} The created rigid body.
     */
    createRigidBody(rigidBodyDesc, colliderDesc) {
        const rigidBody = this.world.createRigidBody(rigidBodyDesc);
        this.world.createCollider(colliderDesc, rigidBody);
        return rigidBody;
    }

    /**
     * Advances the physics simulation by one step.
     */
    step() {
        this.world.step();
    }
}

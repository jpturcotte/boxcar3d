export class VehicleFactory {
    /**
     * Creates the physics descriptions for a vehicle chassis.
     * @param {RAPIER} RAPIER - The RAPIER module instance.
     * @returns {{rigidBodyDesc: RAPIER.RigidBodyDesc, colliderDesc: RAPIER.ColliderDesc}}
     */
    static createChassis(RAPIER) {
        // Define the 3D vertices for a simple box-like chassis.
        // Rapier's convex hull collider requires a flat Float32Array: [x1, y1, z1, x2, y2, z2, ...].
        const vertices = new Float32Array([
            // Front face
            1.0, 0.5, 0.5,
            1.0, 0.5, -0.5,
            1.0, -0.5, 0.5,
            1.0, -0.5, -0.5,
            // Back face
            -1.0, 0.5, 0.5,
            -1.0, 0.5, -0.5,
            -1.0, -0.5, 0.5,
            -1.0, -0.5, -0.5
        ]);

        // Create a dynamic rigid-body for the chassis.
        const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0.0, 5.0, 0.0) // Spawn it 5 units high
            .setLinearDamping(0.5);

        // Create a convex hull collider from the vertices.
        const colliderDesc = RAPIER.ColliderDesc.convexHull(vertices)
            .setDensity(1.0)
            .setFriction(0.8)
            .setRestitution(0.2);

        return { rigidBodyDesc, colliderDesc };
    }
}

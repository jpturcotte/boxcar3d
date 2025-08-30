// BoxCar3D: Main Application Entry Point
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsController } from './physics/PhysicsController.js';
import { VehicleFactory } from './physics/VehicleFactory.js';

const runSimulation = async () => {
    try {
        await RAPIER.init({});
        console.log('Rapier.js loaded and initialized.');

        const physicsController = new PhysicsController(RAPIER);
        physicsController.initialize();

        // --- Task 2.1 Validation: Create a single vehicle chassis ---
        console.log('Attempting to create a vehicle chassis...');
        const { rigidBodyDesc, colliderDesc } = VehicleFactory.createChassis(RAPIER);
        const chassisBody = physicsController.createRigidBody(rigidBodyDesc, colliderDesc);
        console.log('Vehicle chassis created successfully.', chassisBody);
        // --- End Validation ---

        // Game loop
        setInterval(() => {
            physicsController.step();
        }, 16); // Approximately 60 FPS

    } catch (error) {
        console.error('Failed to load Rapier.js. The simulation cannot start.', error);
    }
};

runSimulation();
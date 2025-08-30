// BoxCar3D: Main Application Entry Point
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsController } from './physics/PhysicsController.js';

const runSimulation = async () => {
    try {
        await RAPIER.init({});
        console.log('Rapier.js loaded and initialized.');

        const physicsController = new PhysicsController(RAPIER);
        physicsController.initialize();

        // Game loop
        setInterval(() => {
            physicsController.step();
        }, 16); // Approximately 60 FPS

    } catch (error) {
        console.error('Failed to load Rapier.js. The simulation cannot start.', error);
    }
};

runSimulation();
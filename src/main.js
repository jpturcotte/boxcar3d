// BoxCar3D: Main Application Entry Point
import RAPIER from '@dimforge/rapier3d-compat';
const runSimulation = async () => {
    try {
        await RAPIER.init();
        console.log('Rapier.js loaded and initialized.');
    } catch (error) {
        console.error('Failed to load Rapier.js. The simulation cannot start.', error);
    }
};

runSimulation();
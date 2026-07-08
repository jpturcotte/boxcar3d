BoxCar3D-Rapier: Next-Generation Evolution Simulator

Project Overview

Welcome, Jules!

This project is a complete overhaul of the BoxCar3D genetic algorithm simulation. The original single-file prototype (boxcar3d-improved.html), built with Three.js and Cannon.js, successfully proved the core concept but suffers from critical physics limitations that prevent further progress.

This new version will migrate the simulation to the Rapier.js physics engine, a modern, high-performance WebAssembly-based library. The goal is not just to fix the existing bugs, but to build a robust, scalable, and extensible platform for future development.

This document outlines the justification for this migration, our proposed architecture, and a phased development plan.
Project Objectives

Our primary goals for this migration are:

    Stability & Reliability: Eliminate all physics-related bugs from the original prototype. Our primary success metric is ensuring no vehicles fall through the terrain or become unstable due to engine limitations.

    Realistic Physics: Implement a proper vehicle suspension and joint system that allows for more complex, realistic, and interesting vehicle behaviors to evolve.

    Scalability & Performance: Achieve a stable 60 FPS while simulating a population of at least 50 vehicles simultaneously, a significant increase from the original's capacity.

    Modularity & Extensibility: Create a clean, well-documented codebase that is easy to understand, maintain, and extend with new features in the future.

1. The "Why": Findings from the Phase 0 Analysis

A thorough analysis of the Cannon.js prototype revealed several fundamental issues that cannot be patched and necessitate a full migration.
Key Technical Challenges

    "Tunneling" / Unreliable Terrain Collision: The current terrain is a grid of hundreds of individual boxes. Fast-moving vehicles frequently pass through the seams between these boxes, making the simulation unreliable.

    Unstable Vehicle Physics: The use of PointToPointConstraint for wheels creates an unstable "ball-and-socket" joint, not a proper axle with suspension. This leads to wobbly, unrealistic vehicle behavior and physics engine explosions.

    Severe Performance Bottlenecks: The combination of an inefficient broadphase algorithm (NaiveBroadphase) and hundreds of terrain bodies severely limits performance, making it impossible to simulate a large population of vehicles at 60 FPS.

Conclusion: The Cannon.js architecture has reached its limit. To achieve our goals of realistic physics and a larger scale simulation, we must move to a more capable engine.
2. The "How": Proposed Architecture

We will move from a single HTML file to a modern, modular JavaScript project structure. This separation of concerns is crucial for managing the complexity of the new engine and for effective collaboration.
Project Directory Structure

/boxcar3d-rapier-project/
|
|-- index.html              # Main HTML entry point
|-- package.json            # Project dependencies
|-- vite.config.js          # Local development server config
|
|-- /public/                # Static assets (e.g., Rapier .wasm files)
|
`-- /src/                   # Application source code
    |
    |-- main.js             # Core application entry point & main loop
    |
    |-- /simulation/        # Genetic algorithm, population, and DNA logic
    |   |-- GeneticAlgorithm.js
    |   |-- Population.js
    |   `-- VehicleDNA.js
    |
    |-- /physics/           # Physics Abstraction Layer (only this talks to Rapier)
    |   |-- PhysicsController.js
    |   |-- TerrainFactory.js
    |   `-- VehicleFactory.js
    |
    |-- /graphics/          # Graphics Abstraction Layer (only this talks to Three.js)
    |   |-- GraphicsController.js
    |   |-- SceneSetup.js
    |   `-- VisualSync.js
    |
    `-- /ui/                # DOM manipulation, event listeners, stats display
        `-- UIController.js

Core Principle: We will create abstraction layers for Physics and Graphics. The rest of the application will communicate through our PhysicsController and GraphicsController, not directly with the Rapier.js or Three.js libraries. This makes our code cleaner and easier to upgrade in the future.

3. The "What": Development Roadmap

We will follow the methodical plan laid out in the migration strategy.
Phase 1: Core Physics & Terrain Migration (Target: 1 Week)

Goal: Get a stable Rapier.js world running with a robust terrain system.

    [x] Task 1.1: Project Setup: Initialize a new project using Vite. Install dependencies: three, @dimforge/rapier3d-compat.

    [x] Task 1.2: Implement Architecture: Create the directory structure and placeholder files outlined above.

    [x] Task 1.3: Asynchronous Loading: Implement the async startup flow in main.js to correctly load and initialize the Rapier.js WASM module.

    [x] Task 1.4: Terrain System: In TerrainFactory.js, replace the grid-of-boxes with a single, efficient Rapier.Heightfield collider.

    [x] Task 1.5: Validation: Implement Test 1 (Terrain Integrity Test). Success is 0/100 spheres falling through the terrain.

Phase 2: Vehicle & Joint System Redesign (Target: 1 Week)

Goal: Create a physically-correct vehicle with a proper suspension and wheel system.

    [ ] Task 2.1: Vehicle Factory: In VehicleFactory.js, build a vehicle chassis as a Rapier.RigidBody.

    [ ] Task 2.2: Suspension & Wheel Joints: Implement the two-joint system for each wheel: a PrismaticJoint for vertical suspension and a RevoluteJoint for rotation.

    [ ] Task 2.3: Motor Implementation: Apply torque to the RevoluteJoint to drive the wheels.

    [ ] Task 2.4: Validation: Manually spawn a single vehicle. It should rest stably on the terrain and its suspension should visibly compress.

Phase 3: Genetic Algorithm Re-integration (Target: 1 Week)

Goal: Port the genetic algorithm logic and connect it to the new physics simulation.

    [ ] Task 3.1: Port GA Logic: Move the selection, crossover, and mutation logic into simulation/GeneticAlgorithm.js.

    [ ] Task 3.2: Update Fitness Function: The fitness score (distance traveled) must now be read from the Rapier rigid body's position.

    [ ] Task 3.3: Population Management: Implement logic in simulation/Population.js to manage the lifecycle of a generation: spawn vehicles, evaluate fitness, and trigger evolution.

Phase 4: Graphics & Visualization (Target: 1 Week)

Goal: Connect the Three.js graphics to the Rapier.js simulation and add debugging tools.

    [ ] Task 4.1: Visual Sync: In VisualSync.js, write the logic to update the Three.Mesh positions and rotations from the Rapier RigidBody data on every frame.

    [ ] Task 4.2: Procedural Meshes: Generate Three.js meshes for the vehicle parts based on the same genes used for the physics bodies.

    [ ] Task 4.3: Physics Debug Renderer: Implement a visual debugger that can draw the outlines of the Rapier colliders on top of the 3D scene. This is crucial for troubleshooting.

4. Getting Started: Local Development Setup

To get the project running on your machine:

    Clone the repository:

    git clone <repository_url>
    cd boxcar3d-rapier-project

    Install dependencies:

    npm install

    Run the development server:

    npm run dev

    Open your browser to the URL provided by Vite (usually http://localhost:5173).

Branching Strategy

main: Should always contain the latest stable, working version.

develop: The primary integration branch. All feature branches are merged here.

Feature Branches: Create a new branch for each major task (e.g., feat/phase1-terrain, feat/phase2-vehicle-joints).

Let's get started! Our first priority is Phase 1.
    Feature Branches: Create a new branch for each major task (e.g., feat/phase1-terrain, feat/phase2-vehicle-joints).

Let's get started! Our first priority is Phase 1.

import RAPIER from '@dimforge/rapier3d-compat';

export class TerrainFactory {
    /**
     * Creates a heightfield terrain for the simulation.
     * @returns {RAPIER.ColliderDesc} The collider descriptor for the terrain.
     */
    static createTerrain() {
        const nrows = 50;
        const ncols = 200;
        const heights = new Float32Array((nrows + 1) * (ncols + 1));

        // Generate a wavy terrain
        for (let i = 0; i <= nrows; i++) {
            for (let j = 0; j <= ncols; j++) {
                const x = (i / nrows) * Math.PI * 2;
                const z = (j / ncols) * Math.PI * 5;
                heights[i * (ncols + 1) + j] = Math.sin(x) * 2 + Math.cos(z) * 1.5;
            }
        }

        const scale = new RAPIER.Vector3(200.0, 5.0, 500.0);

        const colliderDesc = RAPIER.ColliderDesc.heightfield(
            nrows,
            ncols,
            heights,
            scale
        );

        return colliderDesc;
    }
}

const DEFAULT_GROUND = 3;

export interface TerrainHeightMap {
  width: number;
  depth: number;
  getHeight(x: number, z: number): number;
}

export function createTerrainHeightMap(width = 64, depth = 64, seed = 1337): TerrainHeightMap {
  const rng = mulberry32(seed);
  const heights: number[][] = new Array(width).fill(null).map(() => new Array(depth).fill(DEFAULT_GROUND));

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      heights[x][z] = sampleHeight(x, z, rng);
    }
  }

  return {
    width,
    depth,
    getHeight(x: number, z: number) {
      const xi = clamp(Math.floor(x), 0, width - 1);
      const zi = clamp(Math.floor(z), 0, depth - 1);
      return heights[xi]?.[zi] ?? DEFAULT_GROUND;
    }
  };
}

function sampleHeight(x: number, z: number, rng: () => number): number {
  const base = 3;
  const rolling = 2 * Math.sin(x * 0.15) + 2 * Math.cos(z * 0.1 + x * 0.05);
  const noise = rng() * 2 - 1;
  const cliffs = Math.sin(x * 0.08) > 0.7 ? 4 : 0;
  const value = base + Math.floor(rolling + noise + cliffs);
  return value;
}

function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export const TERRAIN_DEFAULT_GROUND = DEFAULT_GROUND;

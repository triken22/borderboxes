const WATER_LEVEL = 2;

export interface TerrainHeightMap {
  width: number;
  depth: number;
  getHeight(x: number, z: number): number;
}

type BiomeType = 'grassland' | 'rocky' | 'desert';

interface TerrainSample {
  height: number;
  biome: BiomeType;
  heat: number;
  moisture: number;
}

export function createTerrainHeightMap(width = 64, depth = 64, seed = 1337): TerrainHeightMap {
  const heights: number[][] = new Array(width)
    .fill(null)
    .map(() => new Array(depth).fill(WATER_LEVEL + 1));

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      const sample = computeTerrainSample(x, z, seed, width, depth);
      heights[x][z] = sample.height;
    }
  }

  return {
    width,
    depth,
    getHeight(x: number, z: number) {
      const xi = clamp(Math.floor(x), 0, width - 1);
      const zi = clamp(Math.floor(z), 0, depth - 1);
      return heights[xi]?.[zi] ?? WATER_LEVEL + 1;
    }
  };
}

function computeTerrainSample(
  x: number,
  z: number,
  seed: number,
  width: number,
  depth: number
): TerrainSample {
  const nx = x / width - 0.5;
  const nz = z / depth - 0.5;

  const heat = 0.5 + 0.5 * fbm(nx + seed * 0.001, nz - seed * 0.001, seed + 101, 1.5, 4, 0.5, 2.0);
  const moisture = 0.5 + 0.5 * fbm(nx - 2.3, nz + 2.1, seed + 202, 1.2, 4, 0.55, 2.1);

  let biome: BiomeType;
  if (moisture > 0.58) biome = 'grassland';
  else if (heat > 0.62) biome = 'desert';
  else biome = 'rocky';

  const ridges = fbm(nx, nz, seed + 303, 1.1, 5, 0.55, 2.2);
  const rolling = fbm(x, z, seed + 404, 0.08, 3, 0.6, 2.1);
  const plateaus = fbm(x, z, seed + 505, 0.02, 2, 0.5, 2.0);

  let height = 5 + ridges * 6.0 + rolling * 3.0 + plateaus * 2.5;

  const centerX = width / 2;
  const centerZ = depth / 2;
  const dist = Math.sqrt((x - centerX) ** 2 + (z - centerZ) ** 2);
  const plateauInfluence = clamp(1.8 - dist / (Math.min(width, depth) * 0.3), 0, 1.8);
  height += plateauInfluence;

  if (biome === 'grassland') {
    height += moisture * 0.8;
  } else if (biome === 'rocky') {
    height += Math.max(0, ridges) * 1.3;
  } else if (biome === 'desert') {
    height -= moisture * 1.2;
    height += heat * 0.6;
  }

  const wetland = Math.max(0, moisture - 0.7);
  if (wetland > 0) {
    height -= wetland * 2.2;
  }

  if (height < WATER_LEVEL) height = WATER_LEVEL;
  const quantized = Math.max(WATER_LEVEL, Math.round(height));

  return {
    height: quantized,
    biome,
    heat,
    moisture
  };
}

function fbm(
  x: number,
  z: number,
  seed: number,
  frequency: number,
  octaves: number,
  persistence = 0.5,
  lacunarity = 2
) {
  let amplitude = 1;
  let total = 0;
  let max = 0;
  let freq = frequency;

  for (let i = 0; i < octaves; i++) {
    const noise = valueNoise2D(x * freq, z * freq, seed + i * 101) * 2 - 1;
    total += noise * amplitude;
    max += amplitude;
    amplitude *= persistence;
    freq *= lacunarity;
  }

  return max === 0 ? 0 : total / max;
}

function valueNoise2D(x: number, z: number, seed: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;

  const v00 = hash2D(xi, zi, seed);
  const v10 = hash2D(xi + 1, zi, seed);
  const v01 = hash2D(xi, zi + 1, seed);
  const v11 = hash2D(xi + 1, zi + 1, seed);

  const u = smooth(xf);
  const v = smooth(zf);

  const nx0 = lerp(v00, v10, u);
  const nx1 = lerp(v01, v11, u);
  return lerp(nx0, nx1, v);
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function hash2D(x: number, z: number, seed: number) {
  let h = Math.imul(x ^ (z << 1), 0x27d4eb2d);
  h = Math.imul(h ^ (seed + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export const TERRAIN_DEFAULT_GROUND = WATER_LEVEL + 1;

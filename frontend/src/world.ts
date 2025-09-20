// client/world.ts
import * as THREE from 'three';

// Global terrain height map for collision detection
export const terrainHeightMap = new Map<string, number>();
export const obstacles = new Map<string, { type: string; bounds: THREE.Box3; health?: number }>();
export const terrainSamples = new Map<string, TerrainSample>();

export type BiomeType = 'grassland' | 'rocky' | 'desert';

export interface TerrainSample {
  height: number;
  biome: BiomeType;
  heat: number;
  moisture: number;
}

export type BlockType = 'grass' | 'dirt' | 'stone' | 'sand' | 'snow' | 'clay';

interface BlockDefinition {
  top: number;
  side: number;
  bottom: number;
}

const blockDefinitions: Record<BlockType, BlockDefinition> = {
grass: { top: 0x79c05a, side: 0x5a8e3a, bottom: 0x6b4a2a },
  dirt: { top: 0x8f6b3a, side: 0x7a552b, bottom: 0x5f3d1d },
  stone: { top: 0x8d8d8d, side: 0x767676, bottom: 0x5b5b5b },
  sand: { top: 0xf6e9a3, side: 0xe0d18a, bottom: 0xc7b26d },
  snow: { top: 0xffffff, side: 0xe8f6ff, bottom: 0xcbd8e6 },
  clay: { top: 0xa2b2c4, side: 0x8c9ca9, bottom: 0x6f7c86 }
};

const blockGeometryCache = new Map<BlockType, THREE.BufferGeometry>();
const blockMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

function getBlockGeometry(type: BlockType): THREE.BufferGeometry {
  const cached = blockGeometryCache.get(type);
  if (cached) return cached;

  const def = blockDefinitions[type];
  const geometry = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const colorArray = new Float32Array(normals.count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < normals.count; i++) {
    const nx = normals.getX(i);
    const ny = normals.getY(i);
    const nz = normals.getZ(i);
    if (ny > 0.9) {
      color.setHex(def.top);
    } else if (ny < -0.9) {
      color.setHex(def.bottom);
    } else if (nx > 0.9 || nx < -0.9 || nz > 0.9 || nz < -0.9) {
      color.setHex(def.side);
    } else {
      color.setHex(def.side);
    }
    color.toArray(colorArray, i * 3);
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
  blockGeometryCache.set(type, geometry);
  return geometry;
}

const WATER_LEVEL = 2;
let currentTerrainSeed = 1337;
let currentTerrainDimensions = { width: 64, depth: 64 };

// Get terrain height at position
export function getTerrainHeight(x: number, z: number): number {
  const key = `${Math.floor(x)},${Math.floor(z)}`;
  return terrainHeightMap.get(key) ?? WATER_LEVEL + 1;
}

// Place this helper near getTerrainHeight for discoverability.
export function getTerrainNormal(x: number, z: number): THREE.Vector3 {
  const hL = getTerrainHeight(x - 1, z);
  const hR = getTerrainHeight(x + 1, z);
  const hD = getTerrainHeight(x, z - 1);
  const hU = getTerrainHeight(x, z + 1);
  // y is scaled to bias normals upward for voxel steps
  const n = new THREE.Vector3(hL - hR, 2, hD - hU);
  if (n.lengthSq() < 1e-6) return new THREE.Vector3(0, 1, 0);
  return n.normalize();
}

export function getTerrainSampleAt(x: number, z: number): TerrainSample {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const key = `${xi},${zi}`;
  let sample = terrainSamples.get(key);
  if (!sample) {
    sample = computeTerrainSample(
      xi,
      zi,
      currentTerrainSeed,
      currentTerrainDimensions.width,
      currentTerrainDimensions.depth
    );
    terrainSamples.set(key, sample);
    terrainHeightMap.set(key, sample.height);
  }
  return sample;
}

export function makeChunk(scene: THREE.Scene, size = [64, 64, 16], seed = 1337) {
  const [W, H, D] = size;
  const rng = mulberry32(seed);

  currentTerrainSeed = seed;
  currentTerrainDimensions = { width: W, depth: H };

  terrainHeightMap.clear();
  terrainSamples.clear();
  obstacles.clear();

  const blockPlacements: Record<BlockType, number[]> = {
    grass: [],
    dirt: [],
    stone: [],
    sand: [],
    snow: [],
    clay: []
  };

  const waterTiles: Array<{ x: number; z: number; surfaceY: number; biome: BiomeType; moisture: number }> = [];

  const chooseSurfaceBlock = (sample: TerrainSample, height: number): BlockType => {
    if (height >= WATER_LEVEL + 6 && sample.heat < 0.45) return 'snow';
    if (sample.biome === 'desert') return 'sand';
    if (sample.biome === 'rocky') return 'stone';
    if (sample.moisture > 0.78 && height <= WATER_LEVEL + 1) return 'clay';
    return 'grass';
  };

  const chooseSoilBlock = (sample: TerrainSample): BlockType => {
    if (sample.biome === 'desert') return 'sand';
    if (sample.biome === 'rocky') return 'stone';
    if (sample.moisture > 0.72 && sample.height <= WATER_LEVEL + 1) return 'clay';
    return 'dirt';
  };

  const soilDepthForSample = (sample: TerrainSample) => {
    if (sample.biome === 'desert') return 4;
    if (sample.biome === 'rocky') return 2;
    return 3 + Math.min(2, Math.floor(sample.moisture * 2));
  };

  const shouldFlood = (x: number, z: number, sample: TerrainSample) => {
    if (sample.height <= WATER_LEVEL) return true;
    if (sample.biome === 'desert') return false;
    if (sample.moisture < 0.72) return false;
    if (sample.height > WATER_LEVEL + 1.2) return false;
    const noise = valueNoise2D((x + seed * 0.13) * 0.25, (z - seed * 0.17) * 0.25, seed + 909);
    return noise > 0.28;
  };

  for (let x = 0; x < W; x++) {
    for (let z = 0; z < H; z++) {
      const key = `${x},${z}`;
      const sample = getTerrainSampleAt(x, z);
      let columnHeight = Math.max(2, Math.min(D - 1, Math.round(sample.height)));
      const surfaceBlock = chooseSurfaceBlock(sample, columnHeight);
      const soilDepth = soilDepthForSample(sample);

      terrainHeightMap.set(key, columnHeight);

      if (shouldFlood(x, z, sample)) {
        const surfaceY = Math.max(columnHeight - 0.4, 0.1);
        waterTiles.push({ x, z, surfaceY, biome: sample.biome, moisture: sample.moisture });
      }

      for (let y = 0; y < columnHeight; y++) {
        const depthFromSurface = columnHeight - 1 - y;
        let block: BlockType;
        if (y === columnHeight - 1) {
          block = surfaceBlock;
        } else if (depthFromSurface < soilDepth) {
          block = chooseSoilBlock(sample);
        } else {
          block = 'stone';
        }
        blockPlacements[block].push(x, y, z);
      }
    }
  }

  const chunkGroup = new THREE.Group();
  chunkGroup.name = 'terrainChunk';

  const matrix = new THREE.Matrix4();
  (Object.keys(blockPlacements) as BlockType[]).forEach(type => {
    const positions = blockPlacements[type];
    if (positions.length === 0) return;

    const count = positions.length / 3;
    const mesh = new THREE.InstancedMesh(getBlockGeometry(type), blockMaterial, count);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      matrix.makeTranslation(px, py, pz);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    chunkGroup.add(mesh);
  });

  scene.add(chunkGroup);

  addWaterFeatures(scene, waterTiles, rng);
  addDecorations(scene, rng, W, H, getTerrainSampleAt, waterTiles);

  return chunkGroup;
}

function addWaterFeatures(
  scene: THREE.Scene,
  waterTiles: Array<{ x: number; z: number; surfaceY: number; biome: BiomeType; moisture: number }>,
  rng: () => number
) {
  if (waterTiles.length === 0) {
    return;
  }

  const waterGeometry = new THREE.BoxGeometry(1, 0.7, 1);
  const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x3daef5,
    roughness: 0.04,
    metalness: 0.15,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    transmission: 0.55,
    clearcoat: 0.3,
    clearcoatRoughness: 0.1
  });

  const instanced = new THREE.InstancedMesh(waterGeometry, waterMaterial, waterTiles.length);
  instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  instanced.frustumCulled = false;
  instanced.renderOrder = 2;
  instanced.castShadow = false;
  instanced.receiveShadow = false;

  const matrix = new THREE.Matrix4();

  waterTiles.forEach((tile, index) => {
    const centerY = tile.surfaceY - 0.35;
    matrix.makeTranslation(tile.x, centerY, tile.z);
    instanced.setMatrixAt(index, matrix);
  });

  instanced.instanceMatrix.needsUpdate = true;
  scene.add(instanced);

  if (waterTiles.length > 8) {
    const padGeometry = new THREE.BoxGeometry(0.8, 0.08, 0.8);
    const padMaterial = new THREE.MeshLambertMaterial({ color: 0x5daf4c });
    const lilyCount = Math.min(6, Math.floor(waterTiles.length * 0.05));

    for (let i = 0; i < lilyCount; i++) {
      const tile = waterTiles[Math.floor(rng() * waterTiles.length)];
      if (!tile) continue;
      const lily = new THREE.Mesh(padGeometry, padMaterial);
      lily.position.set(tile.x + (rng() - 0.5) * 0.4, tile.surfaceY + 0.02, tile.z + (rng() - 0.5) * 0.4);
      lily.castShadow = false;
      lily.receiveShadow = false;
      scene.add(lily);
    }
  }
}

function addDecorations(
  scene: THREE.Scene,
  rng: () => number,
  W: number,
  H: number,
  terrainSample: (x: number, z: number) => TerrainSample,
  waterTiles: Array<{ x: number; z: number; surfaceY: number; biome: BiomeType; moisture: number }>
) {
  const reserved: Array<{ x: number; z: number; radius: number }> = [];
  let featureId = 0;
  const waterCoordinateSet = new Set<string>(waterTiles.map(tile => `${tile.x},${tile.z}`));

  const treeTrunkMaterial = new THREE.MeshLambertMaterial({ color: 0x80502a });
  const treeCanopyMaterial = new THREE.MeshLambertMaterial({ color: 0x3fa34d });
  const rockMaterial = new THREE.MeshLambertMaterial({ color: 0x8c8c8c });
  const cactusMaterial = new THREE.MeshLambertMaterial({ color: 0x3fa061 });
  const crateMaterial = new THREE.MeshLambertMaterial({ color: 0x9c6d3a });
  const barrelMaterial = new THREE.MeshLambertMaterial({ color: 0xb74f2e });
  const coverMaterial = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
  const reedMaterial = new THREE.MeshLambertMaterial({ color: 0x56b46c });
  const reedBloomMaterial = new THREE.MeshLambertMaterial({ color: 0xe7c07c });
  const dockDeckMaterial = new THREE.MeshLambertMaterial({ color: 0x9a6d3b });
  const dockRailMaterial = new THREE.MeshLambertMaterial({ color: 0xc18a4a });

  const pathGeometry = new THREE.BoxGeometry(3.2, 0.25, 5.2);
  const platformGeometry = new THREE.BoxGeometry(8.2, 0.4, 8.2);
  const crateGeometry = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const barrelGeometry = new THREE.BoxGeometry(1.1, 1.4, 1.1);
  const reedGeometry = new THREE.BoxGeometry(0.12, 1.4, 0.12);
  const reedBloomGeometry = new THREE.BoxGeometry(0.24, 0.24, 0.24);
  const dockPlankGeometry = new THREE.BoxGeometry(1.3, 0.18, 1.5);
  const dockPostGeometry = new THREE.BoxGeometry(0.28, 0.9, 0.28);
  const dockRailBeamGeometry = new THREE.BoxGeometry(1.3, 0.18, 0.18);

  createGuidingPath();
  spawnTreeClusters();
  spawnWaterDetails();
  spawnStoneShelters();
  spawnDesertProps();
  buildSupplyCache();
  buildWatchTower();

  function reserve(x: number, z: number, radius: number): boolean {
    for (const entry of reserved) {
      const dist = Math.hypot(entry.x - x, entry.z - z);
      if (dist < entry.radius + radius) {
        return false;
      }
    }
    reserved.push({ x, z, radius });
    return true;
  }

  waterTiles.forEach(tile => reserve(tile.x, tile.z, 0.9));

  function setShadows(object: THREE.Object3D) {
    object.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }

  function registerFeature(
    type: string,
    object: THREE.Object3D,
    options: { health?: number; destructible?: boolean; explosive?: boolean; damage?: number } = {}
  ) {
    setShadows(object);

    const userData = { ...(object.userData ?? {}) };
    if (options.destructible) {
      userData.destructible = true;
      userData.health = options.health ?? userData.health ?? 50;
    }
    if (options.explosive) {
      userData.explosive = true;
      userData.damage = options.damage ?? userData.damage ?? 100;
    }
    object.userData = userData;

    scene.add(object);
    object.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(object);
    const key = `${type}_${featureId++}`;
    const entry: { type: string; bounds: THREE.Box3; health?: number } = { type, bounds };
    if (options.health !== undefined) {
      entry.health = options.health;
    }
    obstacles.set(key, entry);
  }

  function pickAnchor(targetBiome: BiomeType, radius: number, maxAttempts = 24) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const x = 2 + Math.floor(rng() * (W - 4));
      const z = 2 + Math.floor(rng() * (H - 4));
      const sample = terrainSample(x, z);
      if (sample.biome !== targetBiome) continue;
      if (sample.height <= WATER_LEVEL) continue;
      if (!reserve(x, z, radius)) continue;
      return { x, z, height: sample.height };
    }
    return undefined;
  }

  function createTree(scale: number) {
    const group = new THREE.Group();
    const trunkHeight = Math.max(3, Math.round(3 * scale));
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.7, trunkHeight, 0.7), treeTrunkMaterial);
    trunk.position.y = trunkHeight * 0.5;
    group.add(trunk);

    const canopySize = Math.max(3, Math.round(2 * scale) + 2);
    const canopyGeometry = new THREE.BoxGeometry(canopySize, canopySize, canopySize);
    const canopy = new THREE.Mesh(canopyGeometry, treeCanopyMaterial);
    canopy.position.y = trunkHeight + canopySize * 0.5 - 0.5;
    group.add(canopy);

    const crossGeometry = new THREE.BoxGeometry(canopySize + 1, canopySize - 1, 1);
    const crossA = new THREE.Mesh(crossGeometry, treeCanopyMaterial);
    crossA.position.y = canopy.position.y;
    group.add(crossA);
    const crossB = crossA.clone();
    crossB.rotation.y = Math.PI / 2;
    group.add(crossB);

    return group;
  }

  function createRock(scale: number) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.1 * scale, 0.6 * scale, 1.1 * scale), rockMaterial.clone());
    base.position.y = 0.3 * scale;
    base.rotation.y = rng() * Math.PI;
    group.add(base);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.8 * scale, 0.45 * scale, 0.8 * scale), rockMaterial.clone());
    cap.position.set((rng() - 0.5) * 0.4 * scale, 0.75 * scale, (rng() - 0.5) * 0.4 * scale);
    cap.rotation.y = rng() * Math.PI;
    group.add(cap);

    return group;
  }

  function createCactus(scale: number) {
    const group = new THREE.Group();
    const height = Math.max(3, Math.round(2.2 * scale));
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, height, 0.8), cactusMaterial);
    body.position.y = height * 0.5;
    group.add(body);

    if (scale > 0.9) {
      const armHeight = Math.max(2, Math.round(1.4 * scale));
      const armGeometry = new THREE.BoxGeometry(0.5, armHeight, 0.5);
      const leftArm = new THREE.Mesh(armGeometry, cactusMaterial);
      leftArm.position.set(0.65, height * 0.6, 0);
      group.add(leftArm);
      const rightArm = leftArm.clone();
      rightArm.position.x = -0.65;
      group.add(rightArm);
    }

    return group;
  }

  function createCrate(scale = 1) {
    const crate = new THREE.Mesh(crateGeometry, crateMaterial);
    crate.scale.setScalar(scale);
    crate.position.y = 0.7 * scale;
    return crate;
  }

  function createBarrel() {
    const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
    barrel.position.y = 0.7;
    return barrel;
  }

  function createCoverWall(width: number, height: number) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.6), coverMaterial);
    wall.position.y = height * 0.5;
    return wall;
  }

  function createReeds(scale: number) {
    const group = new THREE.Group();
    const stalks = 3 + Math.floor(rng() * 3);

    for (let s = 0; s < stalks; s++) {
      const stalk = new THREE.Mesh(reedGeometry, reedMaterial);
      const lengthScale = 0.8 + rng() * 0.6;
      const offsetX = (rng() - 0.5) * 0.4;
      const offsetZ = (rng() - 0.5) * 0.4;
      stalk.scale.set(1, lengthScale * scale, 1);
      const totalHeight = 1.4 * lengthScale * scale;
      stalk.position.set(offsetX, totalHeight * 0.5, offsetZ);
      stalk.castShadow = false;
      stalk.receiveShadow = false;
      group.add(stalk);

      if (rng() > 0.4) {
        const bloom = new THREE.Mesh(reedBloomGeometry, reedBloomMaterial);
        bloom.position.set(
          offsetX + (rng() - 0.5) * 0.1,
          totalHeight * 0.75,
          offsetZ + (rng() - 0.5) * 0.1
        );
        bloom.scale.setScalar(0.7 + rng() * 0.4);
        bloom.castShadow = false;
        bloom.receiveShadow = false;
        group.add(bloom);
      }
    }

    return group;
  }

  function createDock(segments: number) {
    const group = new THREE.Group();
    const spacing = 1.45;

    for (let i = 0; i < segments; i++) {
      const plank = new THREE.Mesh(dockPlankGeometry, dockDeckMaterial);
      plank.position.set(0, 0.12, i * spacing);
      group.add(plank);

      const postOffsets: Array<[number, number]> = [
        [-0.55, -0.6],
        [0.55, -0.6],
        [-0.55, 0.6],
        [0.55, 0.6]
      ];

      postOffsets.forEach(offset => {
        const post = new THREE.Mesh(dockPostGeometry, dockDeckMaterial);
        post.position.set(offset[0], -0.25, i * spacing + offset[1]);
        group.add(post);
      });
    }

    if (segments > 1) {
      for (let i = 0; i < segments; i += Math.max(1, segments - 2)) {
        const railLeft = new THREE.Mesh(dockRailBeamGeometry, dockRailMaterial);
        railLeft.position.set(-0.6, 0.58, i * spacing - 0.1);
        group.add(railLeft);
        const railRight = railLeft.clone();
        railRight.position.x = 0.6;
        group.add(railRight);
      }
    }

    const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffd88a }));
    const lanternOffset = (segments - 1) * spacing;
    lantern.position.set(0, 0.75, lanternOffset + 0.8);
    group.add(lantern);

    const light = new THREE.PointLight(0xffe7b0, 0.6, 10);
    light.position.copy(lantern.position);
    light.castShadow = false;
    group.add(light);

    return group;
  }

  function createGuidingPath() {
    const pathMaterial = coverMaterial.clone() as THREE.MeshLambertMaterial;
    pathMaterial.color = pathMaterial.color.clone();
    pathMaterial.color.offsetHSL(-0.05, -0.1, -0.08);

    const segments = 7;
    for (let index = 0; index < segments; index++) {
      const t = segments <= 1 ? 0 : index / (segments - 1);
      const x = Math.round(THREE.MathUtils.lerp(4, W - 4, t));
      const zOffset = Math.sin(t * Math.PI) * (H * 0.18);
      const z = Math.round(H / 2 + zOffset);
      const sample = terrainSample(x, z);

      const tile = new THREE.Mesh(pathGeometry, pathMaterial);
      tile.position.set(x, sample.height + 0.12, z);
      tile.receiveShadow = true;
      tile.castShadow = false;
      scene.add(tile);
      reserve(x, z, 2.5);
    }
  }

  function spawnTreeClusters() {
    const clusterCount = 6;
    for (let c = 0; c < clusterCount; c++) {
      const anchor = pickAnchor('grassland', 3.6);
      if (!anchor) continue;

      const trees = 3 + Math.floor(rng() * 4);
      for (let t = 0; t < trees; t++) {
        const angle = rng() * Math.PI * 2;
        const distance = 0.8 + rng() * 2.4;
        const px = Math.round(anchor.x + Math.cos(angle) * distance);
        const pz = Math.round(anchor.z + Math.sin(angle) * distance);
        if (px <= 1 || px >= W - 1 || pz <= 1 || pz >= H - 1) continue;
        const spot = terrainSample(px, pz);
        if (spot.biome !== 'grassland') continue;
        if (!reserve(px, pz, 1.5)) continue;

        const tree = createTree(0.9 + rng() * 0.4);
        tree.position.set(px, spot.height, pz);
        registerFeature('tree', tree, { health: 80 });
      }
    }
  }

  function spawnWaterDetails() {
    if (waterTiles.length === 0) return;

    const directions: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    const shorelinePlacements = Math.min(8, Math.floor(waterTiles.length * 0.25));
    for (let i = 0; i < shorelinePlacements; i++) {
      const tile = waterTiles[Math.floor(rng() * waterTiles.length)];
      if (!tile) continue;

      const shuffled = directions.slice();
      for (let j = shuffled.length - 1; j > 0; j--) {
        const swap = Math.floor(rng() * (j + 1));
        [shuffled[j], shuffled[swap]] = [shuffled[swap], shuffled[j]];
      }

      for (const [ox, oz] of shuffled) {
        const px = tile.x + ox;
        const pz = tile.z + oz;
        if (px <= 1 || px >= W - 1 || pz <= 1 || pz >= H - 1) continue;
        if (waterCoordinateSet.has(`${px},${pz}`)) continue;
        const sample = terrainSample(px, pz);
        if (sample.height <= WATER_LEVEL) continue;
        if (!reserve(px, pz, 1.1)) continue;

        const reeds = createReeds(0.9 + rng() * 0.5);
        reeds.position.set(px, sample.height - 0.5, pz);
        setShadows(reeds);
        scene.add(reeds);
        break;
      }
    }

    buildFishingDock();
  }

  function buildFishingDock() {
    if (waterTiles.length < 10) return;

    const anchor = waterTiles.reduce((best, tile) => (tile.moisture > best.moisture ? tile : best), waterTiles[0]);
    if (!anchor) return;

    const directions: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    for (let j = directions.length - 1; j > 0; j--) {
      const swap = Math.floor(rng() * (j + 1));
      [directions[j], directions[swap]] = [directions[swap], directions[j]];
    }

    let chosenDir: [number, number] | null = null;
    let shoreSample: TerrainSample | null = null;
    let shoreX = 0;
    let shoreZ = 0;

    for (const [ox, oz] of directions) {
      const px = anchor.x + ox;
      const pz = anchor.z + oz;
      if (px <= 2 || px >= W - 2 || pz <= 2 || pz >= H - 2) continue;
      if (waterCoordinateSet.has(`${px},${pz}`)) continue;
      const sample = terrainSample(px, pz);
      if (sample.height <= WATER_LEVEL) continue;
      if (!reserve(px, pz, 2.2)) continue;
      chosenDir = [ox, oz];
      shoreSample = sample;
      shoreX = px;
      shoreZ = pz;
      break;
    }

    if (!chosenDir || !shoreSample) return;

    const segments = 3 + Math.floor(rng() * 2);
    for (let step = 1; step <= segments; step++) {
      const rx = shoreX + chosenDir[0] * step;
      const rz = shoreZ + chosenDir[1] * step;
      if (rx <= 1 || rx >= W - 1 || rz <= 1 || rz >= H - 1) break;
      reserve(rx, rz, 1.2);
    }

    const dock = createDock(segments);
    const angle = Math.atan2(chosenDir[0], chosenDir[1]);
    dock.rotation.y = angle;
    dock.position.set(shoreX, shoreSample.height - 0.45, shoreZ);
    registerFeature('dock', dock, { health: 160, destructible: true });
  }

  function spawnStoneShelters() {
    const anchorCount = 4;
    for (let i = 0; i < anchorCount; i++) {
      const anchor = pickAnchor('rocky', 4.2, 28);
      if (!anchor) continue;

      const rocks = 2 + Math.floor(rng() * 3);
      for (let r = 0; r < rocks; r++) {
        const angle = rng() * Math.PI * 2;
        const distance = 1 + rng() * 2;
        const px = Math.round(anchor.x + Math.cos(angle) * distance);
        const pz = Math.round(anchor.z + Math.sin(angle) * distance);
        if (px < 1 || px >= W - 1 || pz < 1 || pz >= H - 1) continue;
        const spot = terrainSample(px, pz);
        if (spot.biome !== 'rocky') continue;
        if (!reserve(px, pz, 1.6)) continue;

        const rock = createRock(0.8 + rng() * 1.2);
        rock.position.set(px, spot.height, pz);
        registerFeature('rock', rock);
      }

      // Add a low barricade for mid-cover in rocky zones
      const cover = createCoverWall(3 + rng() * 2, 1.2 + rng() * 0.4);
      cover.rotation.y = rng() * Math.PI;
      cover.position.set(anchor.x, anchor.height, anchor.z);
      registerFeature('cover', cover, { health: 120, destructible: true });
    }
  }

  function spawnDesertProps() {
    const cactusCount = 6;
    for (let i = 0; i < cactusCount; i++) {
      const anchor = pickAnchor('desert', 2.2, 30);
      if (!anchor) continue;

      const cactus = createCactus(0.9 + rng() * 0.5);
      cactus.position.set(anchor.x, anchor.height, anchor.z);
      registerFeature('cactus', cactus, { health: 70 });
    }
  }

  function buildSupplyCache() {
    const anchorX = Math.floor(W / 2);
    const anchorZ = Math.floor(H / 2) - 5;
    const anchorSample = terrainSample(anchorX, anchorZ);
    if (anchorSample.height <= WATER_LEVEL + 1) return;
    if (!reserve(anchorX, anchorZ, 5)) return;

    const platformMaterial = new THREE.MeshLambertMaterial({ color: 0x8f6a3c });

    const platform = new THREE.Mesh(platformGeometry, platformMaterial);
    platform.position.set(anchorX, anchorSample.height + 0.2, anchorZ);
    platform.receiveShadow = true;
    scene.add(platform);

    // Perimeter rails for readability
    const railLong = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.35, 0.35), platformMaterial);
    railLong.position.set(anchorX, anchorSample.height + 1.2, anchorZ + 4.1);
    scene.add(railLong);
    const railLongBack = railLong.clone();
    railLongBack.position.z = anchorZ - 4.1;
    scene.add(railLongBack);
    const railShort = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 8.6), platformMaterial);
    railShort.position.set(anchorX + 4.1, anchorSample.height + 1.2, anchorZ);
    scene.add(railShort);
    const railShortBack = railShort.clone();
    railShortBack.position.x = anchorX - 4.1;
    scene.add(railShortBack);

    const crateOffsets = [
      { x: -1.8, z: -1.2, rot: Math.PI * 0.1 },
      { x: 0.4, z: 0.3, rot: Math.PI * 0.35 },
      { x: 2.1, z: 1.4, rot: -Math.PI * 0.25 }
    ];

    crateOffsets.forEach((offset, idx) => {
      const crate = createCrate(1 + (idx % 2) * 0.1);
      crate.position.set(anchorX + offset.x, anchorSample.height + 0.75, anchorZ + offset.z);
      crate.rotation.y = offset.rot;
      registerFeature('crate', crate, { health: 70, destructible: true });
    });

    const barrelOffsets = [
      { x: -2.6, z: 1.6, rot: 0, explosive: false },
      { x: 2.6, z: -1.8, rot: Math.PI / 6, explosive: true }
    ];

    barrelOffsets.forEach(offset => {
      const barrel = createBarrel();
      barrel.position.set(anchorX + offset.x, anchorSample.height + 0.75, anchorZ + offset.z);
      barrel.rotation.y = offset.rot;
      registerFeature(offset.explosive ? 'explosive' : 'barrel', barrel, {
        health: offset.explosive ? 1 : 40,
        destructible: true,
        explosive: offset.explosive,
        damage: offset.explosive ? 120 : undefined
      });
    });

    // Create additional waist-high covers around the cache for combat interest
    const coverSegments = [
      { x: anchorX - 3.5, z: anchorZ - 2.8, width: 2.6, rot: Math.PI * 0.1 },
      { x: anchorX + 3.4, z: anchorZ + 2.9, width: 2.2, rot: -Math.PI * 0.2 }
    ];

    coverSegments.forEach(segment => {
      const cover = createCoverWall(segment.width, 1.1 + rng() * 0.3);
      cover.position.set(segment.x, anchorSample.height, segment.z);
      cover.rotation.y = segment.rot;
      registerFeature('cover', cover, { health: 110, destructible: true });
    });
  }

  function buildWatchTower() {
    const anchor = pickAnchor('rocky', 6, 40) ?? pickAnchor('grassland', 6, 40);
    if (!anchor) return;

    const tower = new THREE.Group();
    const legGeometry = new THREE.CylinderGeometry(0.25, 0.32, 6.6, 8);
    const legMaterial = new THREE.MeshLambertMaterial({ color: 0x7c5c34 });
    const deckMaterial = new THREE.MeshLambertMaterial({ color: 0xb08b57 });

    const legOffsets: Array<[number, number]> = [
      [-1.5, -1.5],
      [1.5, -1.5],
      [-1.5, 1.5],
      [1.5, 1.5]
    ];

    legOffsets.forEach(offset => {
      const leg = new THREE.Mesh(legGeometry, legMaterial);
      leg.position.set(offset[0], 3.3, offset[1]);
      tower.add(leg);
    });

    const deck = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.4, 4.4), deckMaterial);
    deck.position.y = 6.7;
    tower.add(deck);

    const railX = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.3, 0.3), deckMaterial);
    railX.position.set(0, 7.2, 2.2);
    tower.add(railX);
    const railXBack = railX.clone();
    railXBack.position.z = -2.2;
    tower.add(railXBack);
    const railZ = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 4.8), deckMaterial);
    railZ.position.set(2.2, 7.2, 0);
    tower.add(railZ);
    const railZBack = railZ.clone();
    railZBack.position.x = -2.2;
    tower.add(railZBack);

    const canopyMaterial = deckMaterial.clone() as THREE.MeshLambertMaterial;
    canopyMaterial.color = canopyMaterial.color.clone();
    canopyMaterial.color.offsetHSL(-0.04, 0.05, -0.08);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.4, 1.2, 8), canopyMaterial);
    canopy.position.y = 7.6;
    tower.add(canopy);

    const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffd966 }));
    lantern.position.y = 7.7;
    tower.add(lantern);

    const pointLight = new THREE.PointLight(0xffe6a3, 0.8, 18);
    pointLight.castShadow = true;
    pointLight.position.y = 7.7;
    tower.add(pointLight);

    tower.position.set(anchor.x, anchor.height, anchor.z);
    registerFeature('structure', tower, { health: 220 });
  }
}

// Create skybox with gradient
export interface SkyboxHandle {
  mesh: THREE.Mesh;
  uniforms: {
    topColor: { value: THREE.Color };
    bottomColor: { value: THREE.Color };
    offset: { value: number };
    exponent: { value: number };
  };
}

export function makeSkybox(scene: THREE.Scene): SkyboxHandle {
  const vertexShader = `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float offset;
    uniform float exponent;
    varying vec3 vWorldPosition;

    void main() {
      float h = normalize(vWorldPosition + offset).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
    }
  `;

  const uniforms = {
    topColor: { value: new THREE.Color(0x87cfff) },
    bottomColor: { value: new THREE.Color(0xf6d7a7) },
    offset: { value: 33 },
    exponent: { value: 0.6 }
  };

  const skyGeo = new THREE.SphereGeometry(400, 32, 15);
  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide
  });

  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  return { mesh: sky, uniforms };
}

// Seeded random number generator
function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
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
  const plateauInfluence = THREE.MathUtils.clamp(1.8 - dist / (Math.min(width, depth) * 0.3), 0, 1.8);
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

  if (height < 2) height = 2;
  const quantized = Math.max(2, Math.round(height));

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

  const nx0 = THREE.MathUtils.lerp(v00, v10, u);
  const nx1 = THREE.MathUtils.lerp(v01, v11, u);
  return THREE.MathUtils.lerp(nx0, nx1, v);
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
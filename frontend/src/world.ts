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

const WATER_LEVEL = 2;
let currentTerrainSeed = 1337;
let currentTerrainDimensions = { width: 64, depth: 64 };

// Get terrain height at position
export function getTerrainHeight(x: number, z: number): number {
  const key = `${Math.floor(x)},${Math.floor(z)}`;
  return terrainHeightMap.get(key) ?? WATER_LEVEL + 1;
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

  // Create instanced mesh for voxels
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshToonMaterial({
    color: 0x88cc44,
    emissive: 0x223311,
    emissiveIntensity: 0.1,
    vertexColors: true
  });

  const maxBlocks = W * H * D; // upper bound for allocation
  const inst = new THREE.InstancedMesh(geometry, material, maxBlocks);
  inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  // Disable frustum culling to prevent terrain disappearing
  inst.frustumCulled = false;
  inst.receiveShadow = true;

  let i = 0;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  const paletteMap: Record<BiomeType, { low: THREE.Color; high: THREE.Color }> = {
    grassland: {
      low: new THREE.Color(0x36692f),
      high: new THREE.Color(0x7bd26a)
    },
    rocky: {
      low: new THREE.Color(0x4a4a53),
      high: new THREE.Color(0x9c9ca8)
    },
    desert: {
      low: new THREE.Color(0xb6924c),
      high: new THREE.Color(0xf1deb0)
    }
  };

  const waterTiles: Array<{ x: number; z: number; surfaceY: number; biome: BiomeType; moisture: number }> = [];

  const shouldFlood = (x: number, z: number, sample: TerrainSample) => {
    if (sample.biome === 'desert') return false;
    if (sample.moisture < 0.72) return false;
    if (sample.height > WATER_LEVEL + 1) return false;
    const noise = valueNoise2D((x + seed * 0.13) * 0.25, (z - seed * 0.17) * 0.25, seed + 909);
    return noise > 0.35;
  };

  for (let x = 0; x < W; x++) {
    for (let z = 0; z < H; z++) {
      const key = `${x},${z}`;
      const sample = getTerrainSampleAt(x, z);
      const { height: yTop, biome, moisture } = sample;
      terrainHeightMap.set(key, yTop);
      const palette = paletteMap[biome];

      if (shouldFlood(x, z, sample)) {
        const surfaceY = Math.max(sample.height - 0.4, 0.1);
        waterTiles.push({ x, z, surfaceY, biome, moisture });
      }

      for (let y = 0; y < yTop; y++) {
        matrix.makeTranslation(x, y, z);
        inst.setMatrixAt(i, matrix);

        const layerFactor = yTop <= 1 ? 0 : y / Math.max(1, yTop - 1);
        const jitter = valueNoise2D((x + z * 0.37) * 0.3, (z - x * 0.41) * 0.3, seed + 555);
        const variance = valueNoise2D((x + y * 0.23) * 0.5, (z - y * 0.19) * 0.5, seed + 777);
        color.copy(palette.low).lerp(palette.high, layerFactor);
        color.offsetHSL((variance - 0.5) * 0.05, (variance - 0.5) * 0.08, (jitter - 0.5) * 0.06);
        inst.setColorAt(i, color);

        i++;
      }
    }
  }

  inst.count = i;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

  scene.add(inst);

  // Layer water and surface set dressing before other props
  addWaterFeatures(scene, waterTiles, rng);

  // Add purposeful landmarks and cover around the map
  addDecorations(scene, rng, W, H, getTerrainSampleAt, waterTiles);

  return inst;
}

function addWaterFeatures(
  scene: THREE.Scene,
  waterTiles: Array<{ x: number; z: number; surfaceY: number; biome: BiomeType; moisture: number }>,
  rng: () => number
) {
  if (waterTiles.length === 0) {
    return;
  }

  const waterGeometry = new THREE.PlaneGeometry(1.05, 1.05);
  const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x2f6cb3,
    roughness: 0.08,
    metalness: 0.2,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const instanced = new THREE.InstancedMesh(waterGeometry, waterMaterial, waterTiles.length);
  instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  instanced.frustumCulled = false;
  instanced.renderOrder = 2;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const scale = new THREE.Vector3(1.05, 1, 1.05);
  const position = new THREE.Vector3();

  waterTiles.forEach((tile, index) => {
    position.set(tile.x, tile.surfaceY, tile.z);
    matrix.compose(position, quaternion, scale);
    instanced.setMatrixAt(index, matrix);
  });

  instanced.instanceMatrix.needsUpdate = true;
  scene.add(instanced);

  // Sprinkle a few bright lily pads for readability in larger pools
  if (waterTiles.length > 8) {
    const padGeometry = new THREE.CircleGeometry(0.32, 16);
    const padMaterial = new THREE.MeshToonMaterial({
      color: 0x6dd39b,
      emissive: 0x245e3f,
      emissiveIntensity: 0.25,
      side: THREE.DoubleSide
    });

    const padQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const lilyCount = Math.min(6, Math.floor(waterTiles.length * 0.05));

    for (let i = 0; i < lilyCount; i++) {
      const tile = waterTiles[Math.floor(rng() * waterTiles.length)];
      if (!tile) continue;
      const lily = new THREE.Mesh(padGeometry, padMaterial);
      lily.position.set(tile.x + (rng() - 0.5) * 0.6, tile.surfaceY + 0.01, tile.z + (rng() - 0.5) * 0.6);
      lily.quaternion.copy(padQuaternion);
      const scale = 0.8 + rng() * 0.4;
      lily.scale.setScalar(scale);
      lily.receiveShadow = false;
      lily.castShadow = false;
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

  const treeTrunkMaterial = new THREE.MeshToonMaterial({
    color: 0x5b3a1f,
    emissive: 0x1d1208,
    emissiveIntensity: 0.08
  });
  const treeCanopyMaterial = new THREE.MeshToonMaterial({
    color: 0x3c7a32,
    emissive: 0x1a3d17,
    emissiveIntensity: 0.12
  });
  const rockMaterial = new THREE.MeshToonMaterial({
    color: 0x5f5f69,
    emissive: 0x1c1c21,
    emissiveIntensity: 0.1
  });
  const cactusMaterial = new THREE.MeshToonMaterial({
    color: 0x2c8f4a,
    emissive: 0x0f3b1a,
    emissiveIntensity: 0.12
  });
  const crateMaterial = new THREE.MeshToonMaterial({
    color: 0x8b5a2b,
    emissive: 0x352112,
    emissiveIntensity: 0.12
  });
  const barrelMaterial = new THREE.MeshToonMaterial({
    color: 0xad1a1a,
    emissive: 0x400808,
    emissiveIntensity: 0.2
  });
  const coverMaterial = new THREE.MeshToonMaterial({
    color: 0x5b4633,
    emissive: 0x1f140c,
    emissiveIntensity: 0.08
  });
  const reedMaterial = new THREE.MeshToonMaterial({
    color: 0x3c9150,
    emissive: 0x12321a,
    emissiveIntensity: 0.12
  });
  const reedBloomMaterial = new THREE.MeshToonMaterial({
    color: 0xd3a15e,
    emissive: 0x4d2b0d,
    emissiveIntensity: 0.16
  });
  const dockDeckMaterial = new THREE.MeshToonMaterial({
    color: 0x6f4f32,
    emissive: 0x23160a,
    emissiveIntensity: 0.08
  });
  const dockRailMaterial = new THREE.MeshToonMaterial({
    color: 0x9d6f3a,
    emissive: 0x3a2813,
    emissiveIntensity: 0.12
  });

  const pathGeometry = new THREE.BoxGeometry(3.2, 0.25, 5.2);
  const platformGeometry = new THREE.BoxGeometry(8.2, 0.4, 8.2);
  const crateGeometry = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const barrelGeometry = new THREE.CylinderGeometry(0.8, 0.9, 1.6, 10);
  const reedGeometry = new THREE.CylinderGeometry(0.05, 0.08, 1.4, 6);
  const reedBloomGeometry = new THREE.SphereGeometry(0.08, 6, 6);
  const dockPlankGeometry = new THREE.BoxGeometry(1.3, 0.18, 1.5);
  const dockPostGeometry = new THREE.CylinderGeometry(0.12, 0.14, 0.9, 6);
  const dockRailBeamGeometry = new THREE.BoxGeometry(1.3, 0.12, 0.08);

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
    const trunkHeight = 1.6 * scale + 0.8;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * scale, 0.26 * scale, trunkHeight, 6), treeTrunkMaterial);
    trunk.position.y = trunkHeight * 0.5;
    group.add(trunk);

    const canopyMain = new THREE.Mesh(new THREE.SphereGeometry(0.9 * scale + 0.2, 10, 10), treeCanopyMaterial);
    canopyMain.position.y = trunkHeight;
    group.add(canopyMain);

    const canopyAccent = new THREE.Mesh(new THREE.DodecahedronGeometry(0.65 * scale, 0), treeCanopyMaterial);
    canopyAccent.position.set(0.3 * scale, trunkHeight + 0.5 * scale, 0.25 * scale);
    group.add(canopyAccent);

    return group;
  }

  function createRock(scale: number) {
    const group = new THREE.Group();
    const geom = new THREE.DodecahedronGeometry(0.9 * scale, 0);
    const mat = rockMaterial.clone() as THREE.MeshToonMaterial;
    mat.color = mat.color.clone();
    mat.color.offsetHSL((rng() - 0.5) * 0.04, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.1);
    const rockMesh = new THREE.Mesh(geom, mat);
    rockMesh.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    rockMesh.position.y = 0.6 * scale;
    group.add(rockMesh);
    return group;
  }

  function createCactus(scale: number) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * scale, 0.3 * scale, 1.9 * scale, 8), cactusMaterial);
    body.position.y = 0.95 * scale;
    group.add(body);

    const armGeometry = new THREE.CylinderGeometry(0.12 * scale, 0.12 * scale, 0.8 * scale, 8);
    const leftArm = new THREE.Mesh(armGeometry, cactusMaterial);
    leftArm.rotation.z = Math.PI / 2;
    leftArm.position.set(0.35 * scale, 1.1 * scale, 0);
    group.add(leftArm);
    const rightArm = leftArm.clone();
    rightArm.position.x = -0.35 * scale;
    group.add(rightArm);

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
    barrel.position.y = 0.75;
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
    const pathMaterial = coverMaterial.clone() as THREE.MeshToonMaterial;
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

    const platformMaterial = new THREE.MeshToonMaterial({
      color: 0x705434,
      emissive: 0x261a0c,
      emissiveIntensity: 0.1
    });

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
    const legMaterial = new THREE.MeshToonMaterial({
      color: 0x5d4732,
      emissive: 0x22170d,
      emissiveIntensity: 0.1
    });
    const deckMaterial = new THREE.MeshToonMaterial({
      color: 0x907a5c,
      emissive: 0x362918,
      emissiveIntensity: 0.1
    });

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

    const canopyMaterial = deckMaterial.clone() as THREE.MeshToonMaterial;
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
export function makeSkybox(scene: THREE.Scene) {
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
    topColor: { value: new THREE.Color(0x88ccff) },
    bottomColor: { value: new THREE.Color(0xffaa66) },
    offset: { value: 33 },
    exponent: { value: 0.6 }
  };

  const skyGeo = new THREE.SphereGeometry(400, 32, 15);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    side: THREE.BackSide
  });

  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);
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

  let height = 3 + ridges * 2.2 + rolling * 1.4 + plateaus * 1.2;

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

  if (height < 1.2) height = 1.2;
  const quantized = Math.max(1, Math.round(height));

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
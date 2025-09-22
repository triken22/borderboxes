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
  return terrainManager.sampleHeightSmooth(x, z);
}

// Place this helper near getTerrainHeight for discoverability.
export function getTerrainNormal(x: number, z: number): THREE.Vector3 {
  const sample = 0.5;
  const hL = terrainManager.sampleHeightSmooth(x - sample, z);
  const hR = terrainManager.sampleHeightSmooth(x + sample, z);
  const hD = terrainManager.sampleHeightSmooth(x, z - sample);
  const hU = terrainManager.sampleHeightSmooth(x, z + sample);
  const n = new THREE.Vector3(hL - hR, 2 * sample, hD - hU);
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

const CHUNK_SIZE = 16;
const RENDER_DISTANCE = 3;
const UNLOAD_DISTANCE = 5;

interface TerrainChunkRecord {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group;
  obstacleKeys: string[];
}

class TerrainManager {
  private scene: THREE.Scene | null = null;
  private seed = 1337;
  private chunks = new Map<string, TerrainChunkRecord>();

  initialize(scene: THREE.Scene, seed: number, extent: { width: number; depth: number }) {
    this.scene = scene;
    this.seed = seed;
    this.dispose(scene);
    currentTerrainSeed = seed;
    currentTerrainDimensions = extent;
    terrainHeightMap.clear();
    terrainSamples.clear();
    obstacles.clear();
  }

  dispose(scene?: THREE.Scene) {
    const targetScene = scene ?? this.scene;
    if (targetScene) {
      for (const chunk of this.chunks.values()) {
        targetScene.remove(chunk.group);
      }
    }
    this.chunks.clear();
  }

  update(position: THREE.Vector3) {
    if (!this.scene) return;
    const cx = Math.floor(position.x / CHUNK_SIZE);
    const cz = Math.floor(position.z / CHUNK_SIZE);

    for (let x = cx - RENDER_DISTANCE; x <= cx + RENDER_DISTANCE; x++) {
      for (let z = cz - RENDER_DISTANCE; z <= cz + RENDER_DISTANCE; z++) {
        this.ensureChunk(x, z);
      }
    }

    for (const [key, chunk] of this.chunks) {
      const dist = Math.max(Math.abs(chunk.cx - cx), Math.abs(chunk.cz - cz));
      if (dist > UNLOAD_DISTANCE && this.scene) {
        this.scene.remove(chunk.group);
        for (const obstacleKey of chunk.obstacleKeys) {
          obstacles.delete(obstacleKey);
        }
        this.chunks.delete(key);
      }
    }
  }

  sampleHeight(x: number, z: number): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const key = `${xi},${zi}`;
    const cached = terrainHeightMap.get(key);
    if (cached !== undefined) return cached;

    const sample = computeTerrainSample(xi, zi, this.seed, currentTerrainDimensions.width, currentTerrainDimensions.depth);
    terrainSamples.set(key, sample);
    terrainHeightMap.set(key, sample.height);
    return sample.height;
  }

  sampleHeightSmooth(x: number, z: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const fx = x - x0;
    const fz = z - z0;

    const h00 = this.sampleHeight(x0, z0);
    const h10 = this.sampleHeight(x1, z0);
    const h01 = this.sampleHeight(x0, z1);
    const h11 = this.sampleHeight(x1, z1);

    return bilinear(h00, h10, h01, h11, fx, fz);
  }

  private ensureChunk(cx: number, cz: number) {
    if (!this.scene) return;
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;
    const record = this.buildChunk(cx, cz);
    this.scene.add(record.group);
    this.chunks.set(key, record);
  }

  private buildChunk(cx: number, cz: number): TerrainChunkRecord {
    const chunkGroup = new THREE.Group();
    chunkGroup.name = `terrain_chunk_${cx}_${cz}`;

    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;

    const plane = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
    const positions = plane.attributes.position as THREE.BufferAttribute;

    for (let i = 0; i < positions.count; i++) {
      const vx = positions.getX(i) + CHUNK_SIZE / 2;
      const vz = positions.getY(i) + CHUNK_SIZE / 2;
      const worldX = originX + vx;
      const worldZ = originZ + vz;
      const height = this.sampleHeightSmooth(worldX, worldZ);
      positions.setZ(i, height);
    }

    plane.computeVertexNormals();

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f2f35,
      roughness: 0.92,
      metalness: 0.08
    });

    const groundMesh = new THREE.Mesh(plane, groundMaterial);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    groundMesh.position.set(originX + CHUNK_SIZE / 2, 0, originZ + CHUNK_SIZE / 2);
    chunkGroup.add(groundMesh);

    const rng = mulberry32(hashChunk(cx, cz, this.seed));
    const obstacleKeys: string[] = [];

    const structureCount = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < structureCount; i++) {
      const width = 1.5 + rng() * 3;
      const depth = 1.5 + rng() * 3;
      const height = 4 + rng() * 6;
      const worldX = originX + rng() * CHUNK_SIZE;
      const worldZ = originZ + rng() * CHUNK_SIZE;
      const baseHeight = this.sampleHeightSmooth(worldX, worldZ);

      const structure = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        new THREE.MeshStandardMaterial({
          color: 0x3a3f4b,
          roughness: 0.6,
          metalness: 0.25
        })
      );
      structure.position.set(worldX, baseHeight + height / 2, worldZ);
      structure.castShadow = true;
      structure.receiveShadow = true;
      chunkGroup.add(structure);

      structure.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(structure);
      const obstacleKey = `structure_${cx}_${cz}_${i}`;
      obstacles.set(obstacleKey, { type: 'structure', bounds });
      obstacleKeys.push(obstacleKey);
    }

    const decoCount = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < decoCount; i++) {
      const worldX = originX + rng() * CHUNK_SIZE;
      const worldZ = originZ + rng() * CHUNK_SIZE;
      const baseHeight = this.sampleHeightSmooth(worldX, worldZ);

      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 0.3, 16),
        new THREE.MeshStandardMaterial({
          color: 0x343b64,
          emissive: 0x2f4adb,
          emissiveIntensity: 0.5,
          roughness: 0.4,
          metalness: 0.2
        })
      );
      pad.position.set(worldX, baseHeight + 0.15, worldZ);
      pad.castShadow = false;
      pad.receiveShadow = true;
      chunkGroup.add(pad);
    }

    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      group: chunkGroup,
      obstacleKeys
    };
  }
}

const terrainManager = new TerrainManager();

export function makeChunk(scene: THREE.Scene, size = [64, 64, 16], seed = 1337) {
  const [width, depth] = size;
  terrainManager.initialize(scene, seed, { width, depth });
  terrainManager.update(new THREE.Vector3(width / 2, 0, depth / 2));
}

export function updateTerrainAround(position: THREE.Vector3) {
  terrainManager.update(position);
}

export function disposeTerrain(scene: THREE.Scene) {
  terrainManager.dispose(scene);
}

function hashChunk(cx: number, cz: number, seed: number) {
  return Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ seed;
}

function bilinear(h00: number, h10: number, h01: number, h11: number, fx: number, fz: number) {
  const lx = THREE.MathUtils.lerp(h00, h10, fx);
  const hx = THREE.MathUtils.lerp(h01, h11, fx);
  return THREE.MathUtils.lerp(lx, hx, fz);
}

export interface SkyboxHandle {
  mesh: THREE.Mesh;
  uniforms: {
    topColor: { value: THREE.Color };
    middleColor: { value: THREE.Color };
    bottomColor: { value: THREE.Color };
    gradientPower: { value: number };
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
    varying vec3 vWorldPosition;
    uniform vec3 topColor;
    uniform vec3 middleColor;
    uniform vec3 bottomColor;
    uniform float gradientPower;
    void main() {
      vec3 dir = normalize(vWorldPosition);
      float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 midMix = mix(bottomColor, middleColor, smoothstep(0.2, 0.55, pow(h, gradientPower)));
      vec3 finalColor = mix(midMix, topColor, smoothstep(0.55, 1.0, pow(h, gradientPower)));
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  const uniforms = {
    topColor: { value: new THREE.Color(0x13203a) },
    middleColor: { value: new THREE.Color(0x1e3a6d) },
    bottomColor: { value: new THREE.Color(0x0b0e18) },
    gradientPower: { value: 0.8 }
  };

  const geometry = new THREE.SphereGeometry(480, 40, 20);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide
  });

  const sky = new THREE.Mesh(geometry, material);
  scene.add(sky);
  return {
    mesh: sky,
    uniforms
  };
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
  _seed: number,
  _width: number,
  _depth: number
): TerrainSample {
  return {
    height: terrainHeightMap.get(`${x},${z}`) ?? 4,
    biome: 'rocky',
    heat: 0.45,
    moisture: 0.2
  };
}
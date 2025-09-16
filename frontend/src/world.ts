// client/world.ts
import * as THREE from 'three';

// Global terrain height map for collision detection
export const terrainHeightMap = new Map<string, number>();
export const obstacles = new Map<string, { type: string; bounds: THREE.Box3; health?: number }>();

// Get terrain height at position
export function getTerrainHeight(x: number, z: number): number {
  const key = `${Math.floor(x)},${Math.floor(z)}`;
  return terrainHeightMap.get(key) ?? 3;
}

export function makeChunk(scene: THREE.Scene, size = [64, 64, 16], seed = 1337) {
  const [W, H, D] = size;
  const rng = mulberry32(seed);

  // Create instanced mesh for voxels
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshToonMaterial({
    color: 0x88cc44,
    emissive: 0x223311,
    emissiveIntensity: 0.1
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

  // Height function for terrain generation with more variation
  const height = (x: number, z: number) => {
    const base = 3;
    const rolling = 2 * Math.sin(x * 0.15) + 2 * Math.cos(z * 0.1 + x * 0.05);
    const noise = rng() * 2 - 1;
    const cliffs = Math.sin(x * 0.08) > 0.7 ? 4 : 0;
    return base + Math.floor(rolling + noise + cliffs);
  };

  for (let x = 0; x < W; x++) {
    for (let z = 0; z < H; z++) {
      const yTop = height(x, z);
      // Store height in map for collision detection
      terrainHeightMap.set(`${x},${z}`, yTop);
      
      for (let y = 0; y < yTop; y++) {
        matrix.makeTranslation(x, y, z);
        inst.setMatrixAt(i, matrix);

        // Vary color slightly based on height and position
        const hue = 0.25 + (y / yTop) * 0.05 + rng() * 0.02;
        const saturation = 0.6 + rng() * 0.2;
        const lightness = 0.3 + (y / yTop) * 0.2 + rng() * 0.1;
        color.setHSL(hue, saturation, lightness);
        inst.setColorAt(i, color);

        i++;
      }
    }
  }

  inst.count = i;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

  scene.add(inst);

  // Add some decorative elements (rocks, structures)
  addDecorations(scene, rng, W, H, height);

  return inst;
}

function addDecorations(
  scene: THREE.Scene,
  rng: () => number,
  W: number,
  H: number,
  heightFn: (x: number, z: number) => number
) {
  // Add some larger rock formations
  const rockGeometry = new THREE.DodecahedronGeometry(2);
  const rockMaterial = new THREE.MeshToonMaterial({
    color: 0x666655,
    emissive: 0x111111,
    emissiveIntensity: 0.1
  });

  for (let i = 0; i < 10; i++) {
    const x = Math.floor(rng() * W);
    const z = Math.floor(rng() * H);
    const y = heightFn(x, z);
    
    // Add rock obstacle to collision map
    const rockMesh = new THREE.Mesh(rockGeometry, rockMaterial);
    rockMesh.position.set(x, y + 1, z);
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    scene.add(rockMesh);
    
    const bounds = new THREE.Box3().setFromObject(rockMesh);
    obstacles.set(`rock_${i}`, { type: 'rock', bounds });
  }
  
  // Add destructible crates
  const crateGeometry = new THREE.BoxGeometry(2, 2, 2);
  const crateMaterial = new THREE.MeshToonMaterial({
    color: 0x8B4513,
    emissive: 0x2F1F0F,
    emissiveIntensity: 0.1
  });
  
  for (let i = 0; i < 15; i++) {
    const x = Math.floor(rng() * W);
    const z = Math.floor(rng() * H);
    const y = heightFn(x, z);

    const crate = new THREE.Mesh(crateGeometry, crateMaterial);
    crate.position.set(x, y + 1, z);
    crate.castShadow = true;
    crate.receiveShadow = true;
    crate.userData = { destructible: true, health: 50 };
    scene.add(crate);
    
    const crateBounds = new THREE.Box3().setFromObject(crate);
    obstacles.set(`crate_${i}`, { type: 'crate', bounds: crateBounds, health: 50 });
  }
  
  // Add explosive barrels
  const barrelGeometry = new THREE.CylinderGeometry(0.8, 0.8, 1.5, 8);
  const barrelMaterial = new THREE.MeshToonMaterial({
    color: 0xFF0000,
    emissive: 0x440000,
    emissiveIntensity: 0.2
  });
  
  for (let i = 0; i < 8; i++) {
    const x = Math.floor(rng() * W);
    const z = Math.floor(rng() * H);
    const y = heightFn(x, z);
    
    const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
    barrel.position.set(x, y + 0.75, z);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    barrel.userData = { explosive: true, damage: 100 };
    scene.add(barrel);
    
    const barrelBounds = new THREE.Box3().setFromObject(barrel);
    obstacles.set(`barrel_${i}`, { type: 'explosive', bounds: barrelBounds, health: 1 });
  }

  // Add some tower/pillar structures
  const pillarGeometry = new THREE.CylinderGeometry(1.5, 2, 8, 6);
  const pillarMaterial = new THREE.MeshToonMaterial({
    color: 0x885533,
    emissive: 0x221111,
    emissiveIntensity: 0.1
  });

  for (let i = 0; i < 3; i++) {
    const x = 16 + Math.floor(rng() * (W - 32));
    const z = 16 + Math.floor(rng() * (H - 32));
    const y = heightFn(x, z);

    const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
    pillar.position.set(x, y + 4, z);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    scene.add(pillar);
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
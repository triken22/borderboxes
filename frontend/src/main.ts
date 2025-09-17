// ... existing imports ...
import * as THREE from 'three';
import { makeChunk, makeSkybox, getTerrainHeight, obstacles } from './world';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader';
import { audioManager } from './audio';
import { VoxelModelLoader } from './voxelLoader';

let ws: WebSocket;
let isSpectator = false;
let spectatorUntil = 0;

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:8787' : 'https://borderboxes-api.highfive.workers.dev');

const analyticsEndpoint = `${API_BASE}/telemetry`;

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getPlayerPalette(id: string) {
  const palettes = [
    { base: 0xf97316, accent: 0xfff3c4, glow: 0xffb347 },
    { base: 0x2563eb, accent: 0xbfdbfe, glow: 0x60a5fa },
    { base: 0x16a34a, accent: 0xd1fae5, glow: 0x34d399 },
    { base: 0xdb2777, accent: 0xfbcfe8, glow: 0xf472b6 },
    { base: 0x9333ea, accent: 0xe9d5ff, glow: 0xc084fc }
  ];
  const index = hashString(id) % palettes.length;
  return palettes[index];
}

function createNamePlate(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 32px "Press Start 2P", monospace';
  ctx.fillStyle = '#000000aa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.5, 0.4, 1);
  sprite.position.y = 1.8;
  return sprite;
}

function createOtherPlayerModel(id: string, name: string): THREE.Object3D {
  const palette = getPlayerPalette(id);
  const group = new THREE.Group();

  const toonMat = new THREE.MeshToonMaterial({
    color: palette.base,
    emissive: palette.glow,
    emissiveIntensity: 0.15
  });
  const accentMat = new THREE.MeshToonMaterial({
    color: palette.accent,
    emissive: palette.glow,
    emissiveIntensity: 0.35
  });
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.4), toonMat);
  torso.position.y = 0.9;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), accentMat);
  head.position.y = 1.5;
  group.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.52), new THREE.MeshToonMaterial({
    color: 0x0f172a,
    emissive: palette.glow,
    emissiveIntensity: 0.6
  }));
  visor.position.set(0.15, 1.5, 0);
  group.add(visor);

  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.2), accentMat);
  leftArm.position.set(-0.46, 0.9, 0);
  group.add(leftArm);
  const rightArm = leftArm.clone();
  rightArm.position.x = 0.46;
  group.add(rightArm);

  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), toonMat);
  leftLeg.position.set(-0.18, 0.4, 0);
  group.add(leftLeg);
  const rightLeg = leftLeg.clone();
  rightLeg.position.x = 0.18;
  group.add(rightLeg);

  const outlines = [torso, head, leftArm, rightArm, leftLeg, rightLeg].map(mesh => {
    const edges = new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry);
    const lines = new THREE.LineSegments(edges, outlineMat);
    lines.position.copy(mesh.position);
    return lines;
  });
  outlines.forEach(line => group.add(line));

  const namePlate = createNamePlate(name || 'Player', palette.accent);
  group.add(namePlate);
  group.userData.nameLabel = namePlate;
  group.userData.baseScale = 1;

  group.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  return group;
}

function trackEvent(event: string, payload: Record<string, unknown> = {}) {
  const data = {
    event,
    playerId: typeof pid === 'string' ? pid : undefined,
    timestamp: Date.now(),
    ...payload
  };

  // Try WebSocket first if connected
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'analytics',
      data
    }));
    return;
  }

  // Fallback to HTTP if WebSocket not available
  const body = JSON.stringify(data);

  if (navigator.sendBeacon) {
    // Create a Blob with proper Content-Type for sendBeacon
    const blob = new Blob([body], { type: 'application/json' });
    const success = navigator.sendBeacon(analyticsEndpoint, blob);
    if (success) return;
  }

  // Fallback to fetch
  fetch(analyticsEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'omit'  // Don't send cookies to avoid CORS issues
  }).catch(() => {
    // Swallow analytics errors; gameplay must continue
  });
}

// Difficulty selection
type Difficulty = 'easy' | 'normal' | 'hard';
let currentDifficulty: Difficulty = 'normal';
const difficultyPanel = document.getElementById('difficulty-panel');
const difficultyButtons: HTMLButtonElement[] = difficultyPanel
  ? Array.from(difficultyPanel.querySelectorAll<HTMLButtonElement>('button[data-difficulty]'))
  : [];

function updateDifficultyUI(level: Difficulty) {
  currentDifficulty = level;
  difficultyButtons.forEach(btn => {
    const btnLevel = btn.dataset.difficulty as Difficulty | undefined;
    btn.classList.toggle('active', btnLevel === level);
  });
}

function sendDifficulty(level: Difficulty) {
  if (level === currentDifficulty) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'setDifficulty', level }));
  }
  updateDifficultyUI(level);
  audioManager.play('menu_click');
}

difficultyButtons.forEach(btn => {
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const level = btn.dataset.difficulty as Difficulty | undefined;
    if (level) {
      trackEvent('difficulty_selected', { level });
      sendDifficulty(level);
    }
  });
});

updateDifficultyUI(currentDifficulty);

// --- New: simple first-person gun anchor + muzzle ---
let gunGroup: THREE.Group | null = null;
let gunMuzzle: THREE.Object3D | null = null;

function ensureGunModel() {
  if (gunGroup) return;
  gunGroup = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d1f27,
    metalness: 0.5,
    roughness: 0.35
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0x5ac8fa,
    emissive: new THREE.Color(0x3fa9f5),
    emissiveIntensity: 0.7,
    metalness: 0.2,
    roughness: 0.2
  });
  const gripMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f2f38,
    metalness: 0.1,
    roughness: 0.6
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 1.1), bodyMaterial);
  body.position.set(0.35, -0.25, -0.9);
  gunGroup.add(body);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.25), gripMaterial);
  grip.position.set(0.5, -0.5, -0.6);
  grip.rotation.z = -0.2;
  gunGroup.add(grip);

  const accent = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.9, 16), accentMaterial);
  accent.position.set(0.32, -0.17, -1.4);
  accent.rotation.z = Math.PI / 2;
  gunGroup.add(accent);

  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.25), accentMaterial);
  sight.position.set(0.3, -0.02, -0.7);
  gunGroup.add(sight);

  gunMuzzle = new THREE.Object3D();
  gunMuzzle.position.set(0.12, -0.2, -1.8);
  gunGroup.add(gunMuzzle);
  camera.add(gunGroup);
}

// Basis & muzzle world position (fallback if muzzle not created)
function getMuzzleWorldPosition(): THREE.Vector3 {
  if (gunMuzzle) {
    const out = new THREE.Vector3();
    gunMuzzle.getWorldPosition(out);
    return out;
  }
  // Fallback: offset from camera using basis vectors
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
  const right = new THREE.Vector3(1, 0, 0).applyEuler(camera.rotation);
  const up = new THREE.Vector3(0, 1, 0).applyEuler(camera.rotation);
  return new THREE.Vector3()
    .copy(camera.position)
    .addScaledVector(forward, 0.6)
    .addScaledVector(right, 0.25)
    .addScaledVector(up, -0.1);
}

// Time helper for consistent animation timing
const nowMs = () => performance.now();

// Movement and reconciliation constants
const MOVE = {
  maxSpeed: 6.0,
  sprintMultiplier: 1.5,
  crouchMultiplier: 0.5,
  accel: 28.0,    // units/s^2
  friction: 10.0,  // 1/s
  airControl: 0.3, // reduced control in air
  slideBoost: 2.0
};

const PHYSICS = {
  gravity: 25.0,      // units/s^2
  jumpPower: 10.0,    // initial jump velocity
  terminalVelocity: 50.0,
  airResistance: 0.02,
  slopeSlideAngle: 45 // degrees
};

const RECONCILE = {
  posGain: 10.0,   // proportional gain (1/s)
  velGain: 2.5     // optional velocity damping toward server
};

const INTERP_MS = 100; // smoother entity interpolation

// Player state
let stamina = 100;
let isCrouching = false;
let isSprinting = false;
let isSliding = false;
let coyoteTime = 0;
let jumpBufferTime = 0;
const COYOTE_TIME_MAX = 0.15; // seconds
const JUMP_BUFFER_MAX = 0.1; // seconds

// Reconciliation error vector
const reconcileError = new THREE.Vector3(0, 0, 0);

// Import world helpers

// --- New: tracer pool (thin cylinders with additive blend) ---
const tracerPool: THREE.Mesh[] = [];
const activeTracers: Array<{ mesh: THREE.Mesh; start: number; lifetime: number }> = [];

function allocTracer(): THREE.Mesh {
  const m = tracerPool.pop();
  if (m) { m.visible = true; return m; }
  const geom = new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, false); // Solid cylinder, wider
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  return mesh;
}

function freeTracer(mesh: THREE.Mesh) {
  mesh.visible = false;
  tracerPool.push(mesh);
}

// --- New: adaptive performance controls (pixel ratio + postFX) ---
let composer: EffectComposer | null = null;
let outlinePass: OutlinePass | null = null;
let fxaaPass: ShaderPass | null = null;
let postFxEnabled = true;           // start on; we can turn off if fps dips
let resolutionScale = 1;            // dynamic [0.75 .. 1.25]
const minScale = 0.75;
let perfFrameCount = 0;
let perfAccumMS = 0;
let outlineThrottle = 0;
let lastDamageTime = 0;

function buildComposer() {
  composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  outlinePass = new OutlinePass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    scene,
    camera
  );
  outlinePass.edgeStrength = 2;
  outlinePass.edgeGlow = 0;
  outlinePass.edgeThickness = 1;
  outlinePass.pulsePeriod = 0;
  composer.addPass(outlinePass);

  fxaaPass = new ShaderPass(FXAAShader);
  composer.addPass(fxaaPass);
}

function disposeComposer() {
  if (!composer) return;
  // EffectComposer disposes its targets automatically on GC; we just drop refs.
  composer = null;
  outlinePass = null;
  fxaaPass = null;
}

function togglePostFX(on: boolean) {
  if (on && !composer) buildComposer();
  if (!on && composer) disposeComposer();
  postFxEnabled = on;
}

// Track last applied pixel ratio to avoid redundant updates
let lastAppliedPR = 0;

function syncPostFxSizes() {
  if (!composer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  composer.setSize(w, h);
  outlinePass?.setSize(w, h);
  if (fxaaPass) {
    fxaaPass.material.uniforms['resolution'].value.x = 1 / w;
    fxaaPass.material.uniforms['resolution'].value.y = 1 / h;
  }
}

function applyPixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  const pr = Math.min(dpr * resolutionScale, 1.5);
  if (pr !== lastAppliedPR) {
    renderer.setPixelRatio(pr);
    lastAppliedPR = pr;
    // Re-sync postFX targets to the new DPR
    syncPostFxSizes();
  }
}

// Game state
interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  equipped: any;
  lives?: number;
  isSpectator?: boolean;
  spectatorUntil?: number;
}

interface Mob {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
}

interface LootDrop {
  id: string;
  x: number;
  y: number;
  z: number;
  item: any;
}

// Setup renderer
const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
applyPixelRatio();

// Setup scene
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x88aacc, 50, 300);

// Setup camera
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
camera.position.set(32, 20, 48);

// Lighting
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(30, 50, 20);
dirLight.castShadow = true;
dirLight.shadow.camera.left = -30;
dirLight.shadow.camera.right = 30;
dirLight.shadow.camera.top = 30;
dirLight.shadow.camera.bottom = -30;
dirLight.shadow.camera.near = 0.1;
dirLight.shadow.camera.far = 100;
dirLight.shadow.mapSize.width = 1024; // Reduced for performance
dirLight.shadow.mapSize.height = 1024;
dirLight.shadow.bias = -0.001;
scene.add(dirLight);

const ambLight = new THREE.AmbientLight(0x4466aa, 0.4);
scene.add(ambLight);

// Create world
makeSkybox(scene);
makeChunk(scene, [64, 64, 16], 1337);

// Post-processing for cel-shading effect (optional for performance)
const enablePostProcessing = true; // existing config hook
if (enablePostProcessing) {
  buildComposer();
}

// Shared geometries (create once, reuse many times)
const geometries = {
  player: new THREE.BoxGeometry(0.8, 1.8, 0.8),
  charger: new THREE.BoxGeometry(1.2, 1.2, 1.2),
  shooter: new THREE.SphereGeometry(0.6, 8, 6),
  jumper: new THREE.ConeGeometry(0.7, 1.5, 6),
  sniper: new THREE.CylinderGeometry(0.3, 0.5, 2, 6),
  tank: new THREE.BoxGeometry(2, 2, 2),
  swarm: new THREE.TetrahedronGeometry(0.5, 0),
  loot: new THREE.OctahedronGeometry(0.4)
};

// Shared materials
const materials = {
  player: new THREE.MeshToonMaterial({
    color: 0x4488ff,
    emissive: 0x112244,
    emissiveIntensity: 0.1
  }),
  otherPlayer: new THREE.MeshToonMaterial({
    color: 0x4488ff,
    emissive: 0x112244,
    emissiveIntensity: 0.1
  }),
  loot: {
    common: new THREE.MeshToonMaterial({
      color: 0x888888,
      emissive: 0x222222,
      emissiveIntensity: 0.3
    }),
    rare: new THREE.MeshToonMaterial({
      color: 0x4169e1,
      emissive: 0x112244,
      emissiveIntensity: 0.4
    }),
    epic: new THREE.MeshToonMaterial({
      color: 0x9932cc,
      emissive: 0x441144,
      emissiveIntensity: 0.5
    }),
    legendary: new THREE.MeshToonMaterial({
      color: 0xff8c00,
      emissive: 0x442211,
      emissiveIntensity: 0.6
    })
  }
};

const mobPalettes: Record<string, { base: number; accent: number; glow: number }> = {
  charger: { base: 0x913232, accent: 0xffc857, glow: 0xff6644 },
  shooter: { base: 0x2c3e50, accent: 0x4ca1ff, glow: 0x9bdcff },
  jumper: { base: 0x1f6f50, accent: 0x3ddc97, glow: 0xb9ffcd },
  sniper: { base: 0x332e5c, accent: 0xb796ff, glow: 0xded0ff },
  tank:   { base: 0x4f4f4f, accent: 0xd9d9d9, glow: 0xffd166 },
  swarm:  { base: 0x7b2cbf, accent: 0xff70a6, glow: 0xffd6ff },
  default: { base: 0x3a3a3a, accent: 0xaaaaaa, glow: 0xffffff }
};

const mobPrototypes = new Map<string, THREE.Group>();
const voxelLoader = VoxelModelLoader.getInstance();

// Preload voxel models for enemies
async function preloadEnemyModels() {
  const modelPaths = [
    { type: 'sniper', path: '/models/enemies/sniper/mechSniper.obj', format: 'obj', scale: 0.3 },
    { type: 'tank', path: '/models/enemies/tank/ShockTrooper.obj', format: 'obj', scale: 0.4 },
    { type: 'shooter', path: '/models/enemies/skeletons/shooter.vox', format: 'vox', scale: 0.5 },
    { type: 'swarm', path: '/models/enemies/skeletons/swarm.vox', format: 'vox', scale: 0.3 },
    { type: 'charger', path: '/models/enemies/chicken/ayam.dae', format: 'dae', scale: 0.35 },
    { type: 'jumper', path: '/models/enemies/skeletons/charger.vox', format: 'vox', scale: 0.4 }
  ];

  for (const model of modelPaths) {
    try {
      const voxelModel = await voxelLoader.loadModel(model.path, model.format as 'obj' | 'dae' | 'vox', model.scale);
      const group = new THREE.Group();
      group.add(voxelModel);

      // Set base scale based on enemy type
      switch(model.type) {
        case 'sniper': group.userData.baseScale = 1.3; break;
        case 'tank': group.userData.baseScale = 1.5; break;
        case 'shooter': group.userData.baseScale = 1.0; break;
        case 'swarm': group.userData.baseScale = 0.8; break;
        case 'charger': group.userData.baseScale = 1.1; break;
        case 'jumper': group.userData.baseScale = 1.0; break;
      }

      mobPrototypes.set(model.type, group);
      console.log(`Loaded voxel model for ${model.type}`);
    } catch (error) {
      console.warn(`Failed to load voxel model for ${model.type}, using procedural geometry`);
    }
  }
}

function clonePrototype(group: THREE.Group): THREE.Object3D {
  const clone = group.clone(true);
  clone.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;

      // Validate geometry before using it
      if (mesh.geometry) {
        const positionAttribute = mesh.geometry.attributes.position;
        if (positionAttribute) {
          // Check for NaN values in position data
          const positions = positionAttribute.array;
          let hasNaN = false;
          for (let i = 0; i < positions.length; i++) {
            if (isNaN(positions[i])) {
              hasNaN = true;
              console.warn('Found NaN in geometry position data, skipping mesh');
              break;
            }
          }

          if (!hasNaN) {
            mesh.material = (mesh.material as THREE.Material).clone();
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          } else {
            // Remove mesh with invalid geometry
            if (mesh.parent) {
              mesh.parent.remove(mesh);
            }
          }
        }
      }
    }
  });
  clone.userData.baseScale = group.userData.baseScale ?? 1;
  return clone;
}

function buildChargerPrototype(): THREE.Group {
  const palette = mobPalettes.charger;
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.2,
    roughness: 0.5
  });
  const armorMat = new THREE.MeshStandardMaterial({
    color: palette.accent,
    metalness: 0.6,
    roughness: 0.3,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.2
  });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 0.9, 6, 12), bodyMat);
  body.rotation.z = Math.PI / 2;
  group.add(body);

  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.3, 12), armorMat);
  plate.position.set(0.4, 0, 0);
  plate.rotation.z = Math.PI / 2;
  group.add(plate);

  const hornMat = new THREE.MeshStandardMaterial({
    color: palette.glow,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.6
  });
  const leftHorn = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 12), hornMat);
  leftHorn.position.set(0.45, 0.25, 0.25);
  leftHorn.rotation.z = Math.PI / 2;
  group.add(leftHorn);
  const rightHorn = leftHorn.clone();
  rightHorn.position.set(0.45, 0.25, -0.25);
  group.add(rightHorn);

  group.userData.baseScale = 1;
  return group;
}

function buildShooterPrototype(): THREE.Group {
  const palette = mobPalettes.shooter;
  const group = new THREE.Group();
  const coreMat = new THREE.MeshStandardMaterial({
    color: palette.glow,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.8,
    metalness: 0.1,
    roughness: 0.2
  });
  const shellMat = new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.6,
    roughness: 0.35
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.35, 20, 18), coreMat);
  group.add(core);
  const shell = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.12, 16, 32), shellMat);
  shell.rotation.x = Math.PI / 2;
  group.add(shell);
  const finsMat = new THREE.MeshStandardMaterial({
    color: palette.accent,
    metalness: 0.3,
    roughness: 0.4
  });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.25), finsMat);
    fin.position.set(0, 0, 0);
    fin.rotation.y = (i * Math.PI * 2) / 3;
    fin.position.x = Math.cos(fin.rotation.y) * 0.55;
    fin.position.z = Math.sin(fin.rotation.y) * 0.55;
    group.add(fin);
  }
  group.userData.baseScale = 1;
  return group;
}

function buildJumperPrototype(): THREE.Group {
  const palette = mobPalettes.jumper;
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.25,
    roughness: 0.45
  });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 16, 4), bodyMat);
  body.position.y = 0.6;
  group.add(body);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 12), new THREE.MeshStandardMaterial({
    color: palette.accent,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.6,
    metalness: 0.15,
    roughness: 0.2
  }));
  visor.position.set(0.15, 0.8, 0.35);
  group.add(visor);
  const legMat = new THREE.MeshStandardMaterial({ color: palette.accent, metalness: 0.5, roughness: 0.4 });
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.4, 4, 8), legMat);
    leg.position.set(Math.cos((i * Math.PI * 2) / 3) * 0.35, 0.1, Math.sin((i * Math.PI * 2) / 3) * 0.35);
    leg.rotation.z = Math.PI / 2;
    group.add(leg);
  }
  group.userData.baseScale = 1;
  return group;
}

function buildSniperPrototype(): THREE.Group {
  const palette = mobPalettes.sniper;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.4, 16), new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.55,
    roughness: 0.35
  }));
  body.position.y = 0.7;
  group.add(body);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 16), new THREE.MeshStandardMaterial({
    color: palette.accent,
    metalness: 0.35,
    roughness: 0.25,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.35
  }));
  scope.position.set(0.3, 1.0, 0);
  scope.rotation.z = Math.PI / 2;
  group.add(scope);
  const base = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.35, 12), new THREE.MeshStandardMaterial({
    color: 0x171321,
    metalness: 0.4,
    roughness: 0.6
  }));
  base.position.y = 0.15;
  group.add(base);
  group.userData.baseScale = 1.1;
  return group;
}

function buildTankPrototype(): THREE.Group {
  const palette = mobPalettes.tank;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.2), new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.4,
    roughness: 0.5
  }));
  body.position.y = 0.4;
  group.add(body);
  const armor = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 1.4), new THREE.MeshStandardMaterial({
    color: palette.accent,
    metalness: 0.65,
    roughness: 0.3
  }));
  armor.position.y = 0.85;
  group.add(armor);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), new THREE.MeshStandardMaterial({
    color: palette.glow,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.5,
    metalness: 0.1,
    roughness: 0.2
  }));
  glow.position.y = 0.75;
  group.add(glow);
  group.userData.baseScale = 1.2;
  return group;
}

function buildSwarmPrototype(): THREE.Group {
  const palette = mobPalettes.swarm;
  const group = new THREE.Group();
  const shardMat = new THREE.MeshStandardMaterial({
    color: palette.base,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.4,
    metalness: 0.2,
    roughness: 0.3
  });
  for (let i = 0; i < 4; i++) {
    const shard = new THREE.Mesh(new THREE.TetrahedronGeometry(0.35, 0), shardMat);
    shard.position.set((Math.random() - 0.5) * 0.6, (Math.random() - 0.2) * 0.6, (Math.random() - 0.5) * 0.6);
    shard.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    group.add(shard);
  }
  group.userData.baseScale = 0.8;
  return group;
}

function buildDefaultPrototype(): THREE.Group {
  const palette = mobPalettes.default;
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6, 0), new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.3,
    roughness: 0.5
  }));
  group.add(mesh);
  group.userData.baseScale = 1;
  return group;
}

const mobPrototypeFactories: Record<string, () => THREE.Group> = {
  charger: buildChargerPrototype,
  shooter: buildShooterPrototype,
  jumper: buildJumperPrototype,
  sniper: buildSniperPrototype,
  tank: buildTankPrototype,
  swarm: buildSwarmPrototype,
  default: buildDefaultPrototype
};

function disposeObject(obj: THREE.Object3D) {
  obj.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(mat => mat.dispose());
      } else {
        (mesh.material as THREE.Material)?.dispose();
      }
    }
    if ((child as THREE.Sprite).isSprite) {
      const sprite = child as THREE.Sprite;
      if (sprite.material.map) sprite.material.map.dispose();
      sprite.material.dispose();
    }
  });
}

function createMobModel(type: string): THREE.Object3D {
  const key = mobPrototypeFactories[type] ? type : 'default';
  let prototype = mobPrototypes.get(key);
  if (!prototype) {
    prototype = mobPrototypeFactories[key]();
    mobPrototypes.set(key, prototype);
  }
  return clonePrototype(prototype);
}

function applyWeaponCosmetics(weapon: { rarity?: string; archetype?: string }) {
  if (!gunGroup) return;
  const rarity = weapon?.rarity ?? 'common';
  const archetype = weapon?.archetype ?? 'Standard';
  const colorsByRarity: Record<string, number> = {
    common: 0x5ac8fa,
    rare: 0x4cd964,
    epic: 0xff9ff3,
    legendary: 0xffd166
  };
  const accentColor = colorsByRarity[rarity] ?? 0xffffff;
  gunGroup.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mesh.geometry instanceof THREE.CylinderGeometry || mesh.name === 'accent') {
        mat.color = new THREE.Color(accentColor);
        mat.emissive = new THREE.Color(accentColor);
        mat.emissiveIntensity = 0.8;
      }
    }
  });

  if (gunGroup.children.length > 0) {
    const label = gunGroup.children.find(child => child.name === 'weaponLabel') as THREE.Mesh | undefined;
    if (label) gunGroup.remove(label);
    const textCanvas = document.createElement('canvas');
    textCanvas.width = 256;
    textCanvas.height = 64;
    const ctx = textCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, textCanvas.width, textCanvas.height);
      ctx.font = 'bold 42px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 4;
      ctx.strokeText(archetype.toUpperCase(), 128, 45);
      ctx.fillText(archetype.toUpperCase(), 128, 45);
    }
    const labelMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(textCanvas), transparent: true });
    const labelSprite = new THREE.Sprite(labelMat);
    labelSprite.scale.set(0.6, 0.15, 1);
    labelSprite.position.set(0.2, -0.05, -0.9);
    labelSprite.name = 'weaponLabel';
    gunGroup.add(labelSprite);
  }
}

function createLootModel(item: { rarity: string; archetype?: string }): THREE.Object3D {
  const group = new THREE.Group();
  const rarity = item.rarity ?? 'common';
  const colorMap: Record<string, number> = {
    common: 0x9aa0a6,
    rare: 0x4fa3ff,
    epic: 0xbe4bdb,
    legendary: 0xffb347
  };
  const glowMap: Record<string, number> = {
    common: 0xdfe3eb,
    rare: 0x7cc4ff,
    epic: 0xfb8cff,
    legendary: 0xfff2a6
  };
  const accentColor = colorMap[rarity] ?? 0xffffff;
  const glowColor = glowMap[rarity] ?? 0xffffff;

  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 1), new THREE.MeshStandardMaterial({
    color: accentColor,
    emissive: new THREE.Color(glowColor),
    emissiveIntensity: 0.6,
    metalness: 0.3,
    roughness: 0.25
  }));
  crystal.rotation.z = Math.PI / 4;
  group.add(crystal);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.1, 16), new THREE.MeshStandardMaterial({
    color: 0x1a1c20,
    metalness: 0.6,
    roughness: 0.4
  }));
  base.position.y = -0.35;
  group.add(base);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.08, 16, 48), new THREE.MeshStandardMaterial({
    color: accentColor,
    emissive: new THREE.Color(glowColor),
    emissiveIntensity: 0.4,
    metalness: 0.2,
    roughness: 0.3
  }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.1;
  group.add(ring);

  const beacon = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 12), new THREE.MeshStandardMaterial({
    color: glowColor,
    emissive: new THREE.Color(glowColor),
    emissiveIntensity: 0.7,
    metalness: 0.1,
    roughness: 0.2
  }));
  beacon.position.y = 0.5;
  group.add(beacon);

  group.userData.baseY = 0;
  return group;
}

// Player mesh (invisible in first-person, but casts shadows)
const me = new THREE.Mesh(geometries.player, materials.player);
me.castShadow = true;
me.receiveShadow = false;
me.visible = false; // Hide in first-person view
scene.add(me);

// Other players and entities
const players = new Map<string, THREE.Object3D>();
const mobs = new Map<string, THREE.Object3D>();
const lootDrops = new Map<string, THREE.Object3D>();

// Audio system is now handled by AudioManager with Howler.js

// Bullet trails and effects
interface Bullet {
  projectile: THREE.Mesh;
  trail: THREE.Line[];
  startTime: number;
  duration: number;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  lastTrailTime: number;
}

const activeBullets: Bullet[] = [];
const hitMarkers: Array<{mesh: THREE.Sprite, startTime: number}> = [];
const muzzleFlashes: Array<{mesh: THREE.Sprite, startTime: number}> = [];
const impactParticles: Array<{system: THREE.Points, startTime: number, velocities: Float32Array}> = [];

// Create muzzle flash effect
function createMuzzleFlash(origin: number[]) {
  // Create multiple flash sprites for layered effect
  const flashCount = 3;
  
  for (let i = 0; i < flashCount; i++) {
    const texture = new THREE.CanvasTexture(createFlashTexture());
    
    const colors = [0xffffff, 0xffaa00, 0xff6600];
    const scales = [1.2, 0.8, 0.5];
    const opacities = [0.9, 0.7, 1.0];
    
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: colors[i],
      transparent: true,
      opacity: opacities[i],
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.set(
      origin[0] + (Math.random() - 0.5) * 0.1,
      origin[1] + (Math.random() - 0.5) * 0.1,
      origin[2] + (Math.random() - 0.5) * 0.1
    );
    sprite.scale.set(scales[i], scales[i], 1);
    sprite.rotation.z = Math.random() * Math.PI;
    scene.add(sprite);

    muzzleFlashes.push({
      mesh: sprite,
      startTime: nowMs()
    });
  }
  
  // Add point light for flash illumination
  const flashLight = new THREE.PointLight(0xffaa00, 2, 5);
  flashLight.position.set(origin[0], origin[1], origin[2]);
  scene.add(flashLight);
  
  // Fade out the light
  setTimeout(() => {
    scene.remove(flashLight);
    flashLight.dispose();
  }, 50);
}

// Helper to create muzzle flash texture
function createFlashTexture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  // Create star-burst pattern
  const rays = 8;
  const centerX = 64;
  const centerY = 64;
  
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const innerRadius = 10;
    const outerRadius = 60;
    
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(angle);
    
    // Create gradient for each ray
    const gradient = ctx.createLinearGradient(0, -innerRadius, 0, -outerRadius);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.3, 'rgba(255, 220, 100, 0.8)');
    gradient.addColorStop(0.7, 'rgba(255, 150, 0, 0.3)');
    gradient.addColorStop(1, 'rgba(255, 100, 0, 0)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-innerRadius * 0.3, -innerRadius);
    ctx.lineTo(innerRadius * 0.3, -innerRadius);
    ctx.lineTo(outerRadius * 0.1, -outerRadius);
    ctx.lineTo(-outerRadius * 0.1, -outerRadius);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  
  // Add central glow
  const centralGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 30);
  centralGradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  centralGradient.addColorStop(0.5, 'rgba(255, 200, 100, 0.5)');
  centralGradient.addColorStop(1, 'rgba(255, 150, 0, 0)');
  
  ctx.fillStyle = centralGradient;
  ctx.fillRect(0, 0, 128, 128);

  return canvas;
}

// Create hit marker
function createHitMarker(x: number, y: number, z: number, damage: number, crit: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  // Add glow effect for critical hits
  if (crit) {
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // Gradient text for better visibility
  const gradient = ctx.createLinearGradient(0, 0, 0, 128);
  if (crit) {
    gradient.addColorStop(0, '#ff0000');
    gradient.addColorStop(0.5, '#ff6600');
    gradient.addColorStop(1, '#ffaa00');
  } else {
    gradient.addColorStop(0, '#ffff00');
    gradient.addColorStop(0.5, '#ffaa00');
    gradient.addColorStop(1, '#ff6600');
  }
  
  ctx.fillStyle = gradient;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3;
  ctx.font = crit ? 'bold 64px Arial' : '48px Arial';
  ctx.textAlign = 'center';
  ctx.strokeText(damage.toString(), 128, 96);
  ctx.fillText(damage.toString(), 128, 96);
  
  // Add "CRIT!" text for critical hits
  if (crit) {
    ctx.font = 'bold 24px Arial';
    ctx.fillStyle = '#ff0000';
    ctx.strokeText('CRIT!', 128, 30);
    ctx.fillText('CRIT!', 128, 30);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 1
  });

  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.position.set(x, y + 2, z);
  sprite.scale.set(crit ? 4 : 3, crit ? 2 : 1.5, 1);
  scene.add(sprite);

  hitMarkers.push({
    mesh: sprite,
    startTime: Date.now()
  });

  // Clean up old markers
  if (hitMarkers.length > 10) {
    const old = hitMarkers.shift();
    if (old) {
      scene.remove(old.mesh);
      (old.mesh.material as THREE.SpriteMaterial).map?.dispose();
      (old.mesh.material as THREE.Material).dispose();
    }
  }
}

// Create impact particle effects
function createImpactParticles(x: number, y: number, z: number) {
  const particleCount = 25;
  const geometry = new THREE.BufferGeometry();

  // Create particle positions
  const positions = new Float32Array(particleCount * 3);
  const velocities = new Float32Array(particleCount * 3);
  const colors = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    // Start at impact position
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // Random velocities in a cone shape with more spread
    const speed = 0.2 + Math.random() * 0.5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.7; // Wider spread

    velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
    velocities[i * 3 + 1] = Math.cos(phi) * speed * 0.5 + 0.2; // More upward bias
    velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;

    // Mix of red/orange/yellow for blood/spark effect
    const colorType = Math.random();
    if (colorType < 0.3) {
      // Blood red
      colors[i * 3] = 0.8 + Math.random() * 0.2;
      colors[i * 3 + 1] = Math.random() * 0.2;
      colors[i * 3 + 2] = 0;
    } else {
      // Spark orange/yellow
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 0.5 + Math.random() * 0.5;
      colors[i * 3 + 2] = Math.random() * 0.3;
    }

    // Varied sizes
    sizes[i] = 0.15 + Math.random() * 0.35;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  // Particle material with additive blending
  const material = new THREE.PointsMaterial({
    size: 0.3,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true
  });

  const particleSystem = new THREE.Points(geometry, material);
  scene.add(particleSystem);

  impactParticles.push({
    system: particleSystem,
    startTime: Date.now(),
    velocities: velocities
  });

  // Create blood splatter on ground
  const splatterGeometry = new THREE.CircleGeometry(0.3 + Math.random() * 0.3, 8);
  const splatterMaterial = new THREE.MeshBasicMaterial({
    color: 0x660000,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide
  });
  const splatter = new THREE.Mesh(splatterGeometry, splatterMaterial);
  splatter.position.set(x, 0.01, z); // Just above ground
  splatter.rotation.x = -Math.PI / 2; // Flat on ground
  scene.add(splatter);
  
  // Fade out splatter over time
  setTimeout(() => {
    const fadeInterval = setInterval(() => {
      splatterMaterial.opacity -= 0.02;
      if (splatterMaterial.opacity <= 0) {
        clearInterval(fadeInterval);
        scene.remove(splatter);
        splatterGeometry.dispose();
        splatterMaterial.dispose();
      }
    }, 100);
  }, 3000);
  
  // Clean up old particles
  while (impactParticles.length > 8) {
    const old = impactParticles.shift();
    if (old) {
      scene.remove(old.system);
      old.system.geometry.dispose();
      (old.system.material as THREE.Material).dispose();
    }
  }
}

// WebSocket connection
let pid = crypto.randomUUID();
let myPlayer: Player | null = null;
let inventory: any[] = [];
let kills = 0;
let lives = 3;

// Client-side prediction
let localPosition = { x: 32, y: 10, z: 32 };
let serverPosition = { x: 32, y: 10, z: 32 };
let velocity = { x: 0, y: 0, z: 0 };

// Interpolation for other entities
const entityStates = new Map<string, {
  current: { x: number, y: number, z: number },
  target: { x: number, y: number, z: number },
  lastUpdate: number
}>();

function connect() {
  // For local development, connect to localhost:8787
  // For production, use the actual worker URL
  const wsBase = API_BASE.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/rooms/lobby/ws?pid=${pid}`;

  ws = new WebSocket(wsUrl);

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'hello') {
      trackEvent('session_start', { difficulty: msg.difficulty ?? currentDifficulty });
      pid = msg.id;
      myPlayer = msg.player;

      // Update inventory if player has items
      if (msg.player && msg.player.inventory) {
        inventory = msg.player.inventory;
        console.log('Inventory updated:', inventory);
        updateInventoryUI();
      }

      if (typeof msg.difficulty === 'string') {
        updateDifficultyUI(msg.difficulty as Difficulty);
      }

      document.getElementById('room')!.textContent = 'lobby';
    }

    if (msg.type === 'snapshot') {
      if (typeof msg.difficulty === 'string') {
        updateDifficultyUI(msg.difficulty as Difficulty);
      }
      // Update players
      const snapshotPlayers = (msg.players ?? []) as Player[];
      document.getElementById('players-online')!.textContent = snapshotPlayers.length.toString();
      const seenPlayers = new Set<string>();
      for (const p of snapshotPlayers) {
        if (p.id === pid) {
          lives = p.lives ?? lives;
          isSpectator = !!p.isSpectator;
          spectatorUntil = p.spectatorUntil ?? spectatorUntil;
          updateSpectatorUI();
        }
        seenPlayers.add(p.id);

        if (p.id === pid) {
          // Store server position
          serverPosition = { x: p.x, y: p.y, z: p.z };
          myPlayer = p;

          // Server reconciliation
          const errX = serverPosition.x - localPosition.x;
          const errY = serverPosition.y - localPosition.y;
          const errZ = serverPosition.z - localPosition.z;
          const errLen = Math.sqrt(errX * errX + errY * errY + errZ * errZ);
          
          if (errLen > 5) {
            // Hard reset only when way off
            localPosition = { ...serverPosition };
            me.position.set(localPosition.x, localPosition.y, localPosition.z);
            reconcileError.set(0, 0, 0);
          } else {
            // Let physics loop resolve gradually
            reconcileError.set(errX, errY, errZ);
          }

      // Update health bar
      const healthPercent = (p.hp / p.maxHp) * 100;
      document.getElementById('health-fill')!.style.width = `${healthPercent}%`;
        } else {
          // Update other players with interpolation
          if (!players.has(p.id)) {
            const avatar = createOtherPlayerModel(p.id, p.name);
            scene.add(avatar);
            players.set(p.id, avatar);
          }

          // Store target position for interpolation
          if (!entityStates.has(p.id)) {
            entityStates.set(p.id, {
              current: { x: p.x, y: p.y, z: p.z },
              target: { x: p.x, y: p.y, z: p.z },
              lastUpdate: nowMs()
            });
          } else {
            const state = entityStates.get(p.id)!;
            state.current = { ...state.target };
            state.target = { x: p.x, y: p.y, z: p.z };
             state.lastUpdate = nowMs();
          }
        }
      }

      // Remove disconnected players
      for (const [id, mesh] of players.entries()) {
        if (!seenPlayers.has(id)) {
          disposeObject(mesh);
          scene.remove(mesh);
          players.delete(id);
          entityStates.delete(id);
        }
      }

      // Update mobs
      const snapshotMobs = (msg.mobs ?? []) as Mob[];
      const seenMobs = new Set<string>();
      for (const m of snapshotMobs) {
        seenMobs.add(m.id);

        if (!mobs.has(m.id)) {
          const mobModel = createMobModel(m.type);
          scene.add(mobModel);
          mobs.set(m.id, mobModel);
        }

        // Store target position for interpolation
        if (!entityStates.has(m.id)) {
          entityStates.set(m.id, {
            current: { x: m.x, y: m.y, z: m.z },
            target: { x: m.x, y: m.y, z: m.z },
            lastUpdate: nowMs()
          });
        } else {
          const state = entityStates.get(m.id)!;
          state.current = { ...state.target };
          state.target = { x: m.x, y: m.y, z: m.z };
           state.lastUpdate = nowMs();
        }

        // Scale based on health
        const mobMesh = mobs.get(m.id);
        if (mobMesh) {
          const baseScale = (mobMesh.userData.baseScale as number) ?? 1;
          const healthScale = baseScale * (0.85 + (m.hp / m.maxHp) * 0.3);
          mobMesh.scale.setScalar(healthScale);
        }
      }

      // Remove dead mobs
      for (const [id, mesh] of mobs.entries()) {
        if (!seenMobs.has(id)) {
          disposeObject(mesh);
          scene.remove(mesh);
          mobs.delete(id);
          entityStates.delete(id);
        }
      }

      // Update loot
      const snapshotLoot = (msg.loot ?? []) as LootDrop[];
      const seenLoot = new Set<string>();
      for (const l of snapshotLoot) {
        seenLoot.add(l.id);

        if (!lootDrops.has(l.id)) {
          const lootModel = createLootModel(l.item);
          scene.add(lootModel);
          lootDrops.set(l.id, lootModel);
        }
        const mesh = lootDrops.get(l.id)!;
         mesh.userData.baseY = l.y;
         mesh.position.set(l.x, l.y, l.z);
         mesh.rotation.y = 0;
      }

      // Remove picked up loot
      for (const [id, mesh] of lootDrops.entries()) {
        if (!seenLoot.has(id)) {
          disposeObject(mesh);
          scene.remove(mesh);
          lootDrops.delete(id);
        }
      }
    }

    if (msg.type === 'event') {
      if (msg.event === 'difficulty' && typeof msg.difficulty === 'string') {
        updateDifficultyUI(msg.difficulty as Difficulty);
        trackEvent('difficulty_updated', { level: msg.difficulty });
      }

      if (msg.event === 'kill') {
        trackEvent('kill', { playerId: msg.playerId, mobId: msg.mobId, isLocal: msg.playerId === pid });
        if (msg.playerId === pid) {
          kills++;
          document.getElementById('kills')!.textContent = kills.toString();
          audioManager.play('enemy_death');
        }
      }

      if (msg.event === 'pickup') {
        trackEvent('loot_pickup', { playerId: msg.playerId, rarity: msg.item?.rarity });
        if (msg.playerId === pid) {
          inventory.push(msg.item);
          updateInventoryUI();
          audioManager.play('pickup');
          if (myPlayer?.equipped && myPlayer.equipped.seed === msg.item.seed) {
            applyWeaponCosmetics(myPlayer.equipped);
          }
        }
      }

      // REPOMARK:SCOPE: 5.1 - Use muzzle-based origin for local player shots; otherwise use server origin.
      if (msg.event === 'shot') {
        const startVec =
          msg.playerId === pid
            ? getMuzzleWorldPosition()
            : new THREE.Vector3(msg.origin[0], msg.origin[1], msg.origin[2]);
        const dirVec = new THREE.Vector3(msg.direction[0], msg.direction[1], msg.direction[2]).normalize();

        createBulletVisual(startVec, dirVec, !!msg.hit); // NEW visual with tracer + projectile

        // Play weapon sound based on the shooting player's equipped weapon
        if (msg.playerId === pid) {
          // Local player shooting
          const weaponType = myPlayer?.equipped?.archetype || 'pistol';
          const soundName = weaponType === 'smg' ? 'smg_fire' :
                           weaponType === 'rifle' ? 'rifle_fire' :
                           weaponType === 'shotgun' ? 'shotgun_fire' : 'pistol_fire';
          audioManager.play(soundName);
        } else {
          // Other player shooting - use 3D positional audio
          const weaponType = (players.get(msg.playerId) as any)?.equipped?.archetype || 'pistol';
          const soundName = weaponType === 'smg' ? 'smg_fire' :
                           weaponType === 'rifle' ? 'rifle_fire' :
                           weaponType === 'shotgun' ? 'shotgun_fire' : 'pistol_fire';
          audioManager.play3D(soundName, startVec, { maxDistance: 50 });
        }
      }

      if (msg.event === 'hit') {
        createHitMarker(msg.x, msg.y, msg.z, msg.damage, msg.crit);
        createImpactParticles(msg.x, msg.y, msg.z);
        // Hit sound is now handled by audioManager

        // Play appropriate hit sound
        if (msg.crit) {
          audioManager.play3D('critical_hit', new THREE.Vector3(msg.x, msg.y, msg.z));
        } else {
          audioManager.play3D('hit_marker', new THREE.Vector3(msg.x, msg.y, msg.z));
        }
      }

      if (msg.event === 'damage' && msg.targetId === pid) {
        trackEvent('damage_taken', { amount: msg.damage, sourceId: msg.sourceId });
        // Play pain sound based on damage amount
        audioManager.playPainSound(msg.damage);
        lastDamageTime = performance.now();
        // Screen shake effect when player takes damage
        const shakeIntensity = Math.min(msg.damage * 0.002, 0.1);
        const shakeDuration = 200;
        const shakeStart = performance.now();
        
        const originalCameraPos = camera.position.clone();
        
        const shakeCamera = () => {
          const elapsed = performance.now() - shakeStart;
          if (elapsed < shakeDuration) {
            const progress = elapsed / shakeDuration;
            const currentIntensity = shakeIntensity * (1 - progress);
            
            camera.position.x = originalCameraPos.x + (Math.random() - 0.5) * currentIntensity;
            camera.position.z = originalCameraPos.z + (Math.random() - 0.5) * currentIntensity;
            
            requestAnimationFrame(shakeCamera);
          } else {
            camera.position.copy(originalCameraPos);
          }
        };
        shakeCamera();
        
        // Red damage flash overlay
        const damageOverlay = document.createElement('div');
        damageOverlay.style.position = 'fixed';
        damageOverlay.style.top = '0';
        damageOverlay.style.left = '0';
        damageOverlay.style.width = '100%';
        damageOverlay.style.height = '100%';
        damageOverlay.style.backgroundColor = 'red';
        damageOverlay.style.opacity = '0.3';
        damageOverlay.style.pointerEvents = 'none';
        damageOverlay.style.zIndex = '999';
        document.body.appendChild(damageOverlay);
        
        // Fade out the damage overlay
        setTimeout(() => {
          damageOverlay.style.transition = 'opacity 0.3s';
          damageOverlay.style.opacity = '0';
          setTimeout(() => {
            document.body.removeChild(damageOverlay);
          }, 300);
        }, 100);
      }

      if (msg.event === 'lootDrop') {
        // handled by snapshot/loot map in next tick; keep as-is
      }

      if (msg.event === 'playerDeath' && msg.playerId === pid) {
        lives = msg.lives ?? Math.max(0, lives - 1);
        updateSpectatorUI();
        // Play death sound
        audioManager.playDeathSound();
        // Show death screen
        const deathScreen = document.getElementById('death-screen');
        const respawnTimer = document.getElementById('respawn-timer');
        if (deathScreen && respawnTimer) {
          deathScreen.style.display = 'flex';
          
          // Start countdown
          let countdown = 5;
          respawnTimer.textContent = countdown.toString();
          
          const countdownInterval = setInterval(() => {
            countdown--;
            if (countdown > 0) {
              respawnTimer.textContent = countdown.toString();
            } else {
              clearInterval(countdownInterval);
              respawnTimer.textContent = 'Respawning...';
            }
          }, 1000);
        }
      }

      if (msg.event === 'equip' && msg.item) {
        trackEvent('weapon_equip', { playerId: msg.playerId, rarity: msg.item.rarity, archetype: msg.item.archetype });
        trackEvent('weapon_equip', { playerId: msg.playerId, rarity: msg.item.rarity, archetype: msg.item.archetype });
        if (msg.playerId === pid) {
          myPlayer = myPlayer ? { ...myPlayer, equipped: msg.item } : myPlayer;
          console.log('Player equipped weapon:', msg.item);
          applyWeaponCosmetics(msg.item);

          // Play equip sound
          audioManager.play('menu_click');
        } else {
          // Update other player's equipped weapon
          const otherPlayer = players.get(msg.playerId);
          if (otherPlayer) {
            (otherPlayer as any).equipped = msg.item;
          }
        }
      }

      if (msg.event === 'spectator' && msg.playerId === pid) {
        isSpectator = true;
        spectatorUntil = msg.until ?? (Date.now() + 45000);
        firing = false;
        updateSpectatorUI();
      }

      if (msg.event === 'playerRespawn' && msg.playerId === pid) {
        lives = msg.lives ?? lives;
        isSpectator = false;
        spectatorUntil = 0;
        updateSpectatorUI();
        // Hide death screen
        audioManager.play('respawn');
        // Hide death screen
        const deathScreen = document.getElementById('death-screen');
        if (deathScreen) {
          deathScreen.style.display = 'none';
        }
        
        // Reset position
        localPosition = { x: msg.x, y: msg.y, z: msg.z };
        serverPosition = { ...localPosition };
        me.position.set(localPosition.x, localPosition.y, localPosition.z);
        reconcileError.set(0, 0, 0);
        
        // Visual feedback for invulnerability
        if (msg.invulnerable) {
          // Make player semi-transparent during invulnerability
          const originalOpacity = materials.player.opacity;
          materials.player.transparent = true;
          materials.player.opacity = 0.5;
          
          // Flash effect
          let flashCount = 0;
          const flashInterval = setInterval(() => {
            flashCount++;
            materials.player.opacity = flashCount % 2 === 0 ? 0.5 : 0.8;
            if (flashCount >= 6) { // 3 seconds of flashing
              clearInterval(flashInterval);
              materials.player.opacity = originalOpacity;
              materials.player.transparent = false;
            }
          }, 500);
        }
      }
    }
  };

  ws.onclose = () => {
    setTimeout(connect, 1000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

// Input handling
const keys = new Set<string>();
let mouseX = 0, mouseY = 0;
let yaw = 0, pitch = 0;
let firing = false;
let isPointerLocked = false;

// Pointer lock for FPS controls
canvas.addEventListener('click', (e) => {
  e.preventDefault();
  if (!isPointerLocked) {
    // Audio is now initialized automatically by AudioManager
    ensureGunModel(); // NEW: create/attach simple gun + muzzle anchor
    canvas.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  isPointerLocked = document.pointerLockElement === canvas;
  
  const instructions = document.getElementById('instructions');
  if (instructions) {
    instructions.style.display = isPointerLocked ? 'none' : 'block';
  }
  
  firing = false;
});

// Mouse movement with pointer lock
document.addEventListener('mousemove', (e) => {
  if (isPointerLocked) {
    // FPS-style mouse look
    const sensitivity = 0.002;
    yaw -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, pitch));
  } else {
    // Fallback for non-pointer-lock (for debugging)
    mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
  }
});

// Mouse buttons - use document level to work with pointer lock
document.addEventListener('mousedown', (e) => {
  if (isPointerLocked && e.button === 0) { // Left click only when locked
    e.preventDefault();
    firing = true;
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    e.preventDefault();
    firing = false;
  }
});

// Prevent context menu
document.addEventListener('contextmenu', (e) => {
  if (isPointerLocked) {
    e.preventDefault();
  }
});

// Keyboard input
document.addEventListener('keydown', (e) => {
  // Escape to unlock pointer
  if (e.code === 'Escape' && isPointerLocked) {
    document.exitPointerLock();
    return;
  }

  keys.add(e.code);
  
  // Sprint
  if (e.code === 'ShiftLeft') {
    isSprinting = true;
  }
  
  // Crouch
  if (e.code === 'ControlLeft') {
    isCrouching = true;
    if (isSprinting) {
      isSliding = true;
    }
  }

  // Mute/unmute
  if (e.code === 'KeyM') {
    audioManager.toggle();
  }

  // Pickup nearby loot
  if (e.code === 'KeyE' && myPlayer) {
    for (const [id, mesh] of lootDrops.entries()) {
      const dist = mesh.position.distanceTo(me.position);
      if (dist < 3) {
        trackEvent('loot_pickup_attempt', { lootId: id });
        ws?.send(JSON.stringify({ type: 'pickup', lootId: id }));
        break;
      }
    }
  }

  // Equip items
  if (e.code >= 'Digit1' && e.code <= 'Digit5') {
    const index = parseInt(e.code.substring(5)) - 1;
    console.log(`Equip key pressed: ${e.code}, index: ${index}, inventory:`, inventory);
    if (inventory[index]) {
      console.log(`Equipping item:`, inventory[index]);
      ws?.send(JSON.stringify({ type: 'equip', itemId: inventory[index].seed }));
    } else {
      console.log(`No item in slot ${index + 1}`);
    }
  }
});

document.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  
  if (e.code === 'ShiftLeft') {
    isSprinting = false;
    isSliding = false;
  }
  
  if (e.code === 'ControlLeft') {
    isCrouching = false;
    isSliding = false;
  }
});

// Check collision with obstacles
// Improved collision with sliding response
function resolveCollision(currentPos: THREE.Vector3, desiredPos: THREE.Vector3, radius = 0.5): THREE.Vector3 {
  const result = desiredPos.clone();
  
  // Check collision for each axis separately to allow sliding
  for (const obstacle of obstacles.values()) {
    // Expand bounds by player radius
    const expandedMin = obstacle.bounds.min.clone().subScalar(radius);
    const expandedMax = obstacle.bounds.max.clone().addScalar(radius);
    
    // Check if desired position intersects
    if (desiredPos.x >= expandedMin.x && desiredPos.x <= expandedMax.x &&
        desiredPos.y >= expandedMin.y && desiredPos.y <= expandedMax.y &&
        desiredPos.z >= expandedMin.z && desiredPos.z <= expandedMax.z) {
      
      // Find the axis with smallest penetration depth
      const penetrations = [
        { axis: 'x', depth: Math.min(desiredPos.x - expandedMin.x, expandedMax.x - desiredPos.x) },
        { axis: 'y', depth: Math.min(desiredPos.y - expandedMin.y, expandedMax.y - desiredPos.y) },
        { axis: 'z', depth: Math.min(desiredPos.z - expandedMin.z, expandedMax.z - desiredPos.z) }
      ];
      
      penetrations.sort((a, b) => a.depth - b.depth);
      const smallest = penetrations[0];
      
      // Push out along the axis with smallest penetration (sliding)
      if (smallest.axis === 'x') {
        if (currentPos.x < obstacle.bounds.min.x) {
          result.x = expandedMin.x - 0.001;
        } else {
          result.x = expandedMax.x + 0.001;
        }
      } else if (smallest.axis === 'y') {
        if (currentPos.y < obstacle.bounds.min.y) {
          result.y = expandedMin.y - 0.001;
        } else {
          result.y = expandedMax.y + 0.001;
        }
      } else {
        if (currentPos.z < obstacle.bounds.min.z) {
          result.z = expandedMin.z - 0.001;
        } else {
          result.z = expandedMax.z + 0.001;
        }
      }
    }
  }
  
  return result;
}

// Local physics update
function updateLocalPhysics() {
  const dt = 1/60; // Fixed timestep for consistent physics

  // Calculate movement direction based on camera yaw
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) {
    forward.set(0, 0, -1);
  } else {
    forward.normalize();
  }

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  right.y = 0;
  if (right.lengthSq() < 1e-6) {
    right.set(1, 0, 0);
  } else {
    right.normalize();
  }

  // Get terrain height at current position
  const terrainHeight = getTerrainHeight(localPosition.x, localPosition.z);
  const onGround = localPosition.y <= terrainHeight + 0.1;
  
  // Update stamina
  if (isSpectator) {
    return;
  }

  if (isSprinting && (keys.has('KeyW') || keys.has('KeyS') || keys.has('KeyA') || keys.has('KeyD'))) {
    stamina = Math.max(0, stamina - dt * 20);
    if (stamina <= 0) {
      isSprinting = false;
      isSliding = false;
    }
  } else {
    stamina = Math.min(100, stamina + dt * 10);
  }
  
  // Compute desired horizontal target velocity from input
  let inputForward = 0;
  let inputRight = 0;
  
  if (keys.has('KeyW')) inputForward += 1;
  if (keys.has('KeyS')) inputForward -= 1;
  if (keys.has('KeyD')) inputRight += 1;
  if (keys.has('KeyA')) inputRight -= 1;
  
  // Normalize diagonal movement
  const inputLen = Math.sqrt(inputForward * inputForward + inputRight * inputRight);
  if (inputLen > 1) {
    inputForward /= inputLen;
    inputRight /= inputLen;
  }
  
  // Apply movement modifiers
  let speedMultiplier = 1.0;
  if (isSliding) {
    speedMultiplier = MOVE.slideBoost;
  } else if (isSprinting && stamina > 0) {
    speedMultiplier = MOVE.sprintMultiplier;
  } else if (isCrouching) {
    speedMultiplier = MOVE.crouchMultiplier;
  }
  
  const targetVX = (inputRight * right.x + inputForward * forward.x) * MOVE.maxSpeed * speedMultiplier;
  const targetVZ = (inputRight * right.z + inputForward * forward.z) * MOVE.maxSpeed * speedMultiplier;
  
  // Accelerate toward target with smooth acceleration (reduced in air)
  const controlFactor = onGround ? 1.0 : MOVE.airControl;
  const ax = (targetVX - velocity.x) * MOVE.accel * controlFactor;
  const az = (targetVZ - velocity.z) * MOVE.accel * controlFactor;
  velocity.x += ax * dt;
  velocity.z += az * dt;
  
  // Apply ground friction when no input (only on ground)
  if (onGround && inputRight === 0 && inputForward === 0 && !isSliding) {
    velocity.x *= 1 / (1 + MOVE.friction * dt);
    velocity.z *= 1 / (1 + MOVE.friction * dt);
  }
  
  // Slide friction (reduced)
  if (isSliding) {
    velocity.x *= 1 / (1 + MOVE.friction * 0.2 * dt);
    velocity.z *= 1 / (1 + MOVE.friction * 0.2 * dt);
  }
  
  // Apply server reconciliation smoothly
  localPosition.x += reconcileError.x * RECONCILE.posGain * dt;
  localPosition.y += reconcileError.y * RECONCILE.posGain * dt;
  localPosition.z += reconcileError.z * RECONCILE.posGain * dt;
  const decay = Math.max(0, 1 - RECONCILE.posGain * dt);
  reconcileError.x *= decay;
  reconcileError.y *= decay;
  reconcileError.z *= decay;
  
  // Clamp final speed to avoid spikes from reconciliation
  const vLen = Math.hypot(velocity.x, velocity.z);
  if (vLen > MOVE.maxSpeed * 1.5) {
    const scale = (MOVE.maxSpeed * 1.5) / vLen;
    velocity.x *= scale;
    velocity.z *= scale;
  }
  
  // Update coyote time
  if (onGround) {
    coyoteTime = COYOTE_TIME_MAX;
  } else {
    coyoteTime = Math.max(0, coyoteTime - dt);
  }
  
  // Update jump buffer
  if (keys.has('Space')) {
    jumpBufferTime = JUMP_BUFFER_MAX;
  } else {
    jumpBufferTime = Math.max(0, jumpBufferTime - dt);
  }
  
  // Jumping with coyote time and jump buffer
  if (jumpBufferTime > 0 && (onGround || coyoteTime > 0)) {
    velocity.y = PHYSICS.jumpPower;
    if (isSliding) {
      // Boost horizontal velocity when jump-sliding
      velocity.x *= 1.3;
      velocity.z *= 1.3;
    }
    coyoteTime = 0;
    jumpBufferTime = 0;
  }
  
  // Apply gravity with terminal velocity
  if (!onGround) {
    velocity.y -= PHYSICS.gravity * dt;
    velocity.y = Math.max(-PHYSICS.terminalVelocity, velocity.y);
    
    // Air resistance
    velocity.x *= 1 - PHYSICS.airResistance * dt;
    velocity.z *= 1 - PHYSICS.airResistance * dt;
  }
  
  // Apply movement with improved collision
  const currentPos = new THREE.Vector3(localPosition.x, localPosition.y, localPosition.z);
  const desiredPos = new THREE.Vector3(
    localPosition.x + velocity.x * dt,
    localPosition.y + velocity.y * dt,
    localPosition.z + velocity.z * dt
  );
  
  // Resolve collision with sliding
  const resolvedPos = resolveCollision(currentPos, desiredPos);
  
  // Apply resolved position
  localPosition.x = resolvedPos.x;
  localPosition.y = resolvedPos.y;
  localPosition.z = resolvedPos.z;
  
  // Reduce velocity if we hit something
  if (Math.abs(resolvedPos.x - desiredPos.x) > 0.01) velocity.x *= 0.5;
  if (Math.abs(resolvedPos.y - desiredPos.y) > 0.01) velocity.y = 0;
  if (Math.abs(resolvedPos.z - desiredPos.z) > 0.01) velocity.z *= 0.5;
  
  // Terrain collision
  const newTerrainHeight = getTerrainHeight(localPosition.x, localPosition.z);
  if (localPosition.y <= newTerrainHeight) {
    localPosition.y = newTerrainHeight;
    if (velocity.y < 0) {
      velocity.y = 0;
      
      // Check for slope sliding
      const slope = Math.abs(newTerrainHeight - terrainHeight) / dt;
      if (slope > Math.tan(PHYSICS.slopeSlideAngle * Math.PI / 180)) {
        // Slide down steep slopes
        const slideDir = new THREE.Vector3(
          newTerrainHeight > terrainHeight ? -velocity.x : velocity.x,
          0,
          newTerrainHeight > terrainHeight ? -velocity.z : velocity.z
        ).normalize();
        velocity.x += slideDir.x * 2;
        velocity.z += slideDir.z * 2;
      }
    }
  }

  // World bounds
  localPosition.x = Math.max(0, Math.min(64, localPosition.x));
  localPosition.z = Math.max(0, Math.min(64, localPosition.z));

  // Update player mesh position
  me.position.set(localPosition.x, localPosition.y, localPosition.z);
}

// Send input to server
function sendInput() {
  if (!ws || ws.readyState !== 1) return;

  const moveRight = isSpectator ? 0 : (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const moveJump = isSpectator ? 0 : (keys.has('Space') ? 1 : 0);
  const moveForward = isSpectator ? 0 : (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);

  const move = [moveRight, moveJump, moveForward];

  // Calculate aim direction from camera orientation
  let aimDir;
  if (isPointerLocked) {
    // Use yaw and pitch for aim direction
    aimDir = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    );
  } else {
    // Fallback to raycaster
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);
    aimDir = raycaster.ray.direction;
  }

  const inputData = {
    type: 'input',
     t: nowMs(),
    move,
    aim: [aimDir.x, aimDir.y, aimDir.z],
    firing
  };

  // Debug when firing
  if (firing) {
  }

  ws.send(JSON.stringify(inputData));
}

setInterval(sendInput, 50);

// Update inventory UI
function updateInventoryUI() {
  const container = document.getElementById('inventory')!;
  container.innerHTML = '';

  for (let i = 0; i < 5; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot';

    if (inventory[i]) {
      const item = inventory[i];
      slot.classList.add(item.rarity);
      if (myPlayer?.equipped && myPlayer.equipped.seed === item.seed) {
        slot.classList.add('equipped');
      }
      slot.innerHTML = `
        <div>${item.archetype.substring(0, 3).toUpperCase()}</div>
        <div style="font-size: 10px">${item.dps}</div>
      `;
    }

    container.appendChild(slot);
  }
}

// Camera follow (FPS style)
function updateCamera() {
  // Position camera at player's eye level
  camera.position.set(
    localPosition.x,
    localPosition.y + 1.5, // Eye height
    localPosition.z
  );

  // Apply rotation from mouse look
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
}

function updateSpectatorUI() {
  const overlay = document.getElementById('spectator-overlay');
  const countdownLabel = document.getElementById('spectator-countdown');
  if (!overlay || !countdownLabel) return;

  if (isSpectator) {
    overlay.style.display = 'flex';
    const remaining = Math.max(0, spectatorUntil - Date.now());
    countdownLabel.textContent = Math.ceil(remaining / 1000).toString();
  } else {
    overlay.style.display = 'none';
  }
}

function updateUI() {
  // Update stamina bar
  const staminaBar = document.getElementById('stamina-fill');
  if (staminaBar) {
    staminaBar.style.width = `${stamina}%`;
  }
  
  // Update movement state indicator
  const livesLabel = document.getElementById('lives');
  if (livesLabel) {
    livesLabel.textContent = lives.toString();
  }

  const movementState = document.getElementById('movement-state');
  if (movementState) {
    let state = '';
    if (isSliding) {
      state = '🏂 SLIDING';
    } else if (isSprinting) {
      state = '🏃 SPRINTING';
    } else if (isCrouching) {
      state = '🦆 CROUCHING';
    }
    movementState.textContent = state;
  }
}

// Window resize
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  applyPixelRatio(); // NEW: respect dynamic resolution
  renderer.setSize(w, h, false);

  if (composer) {
    composer.setSize(w, h);
  }

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  if (fxaaPass) {
    fxaaPass.material.uniforms['resolution'].value.x = 1 / w;
    fxaaPass.material.uniforms['resolution'].value.y = 1 / h;
  }
}
addEventListener('resize', resize);
resize();

// Animation loop with fixed timestep
let lastFrameTime = performance.now();
let accumulator = 0;
const FIXED_TIMESTEP = 1000 / 60; // 60 FPS physics
function animate() {
  const now = performance.now();
  const frameTime = Math.min(now - lastFrameTime, 100);
  lastFrameTime = now;

  // Adaptive perf sampling
  perfFrameCount++;
  perfAccumMS += frameTime;
  if (perfFrameCount >= 60) {
    const avgMs = perfAccumMS / perfFrameCount; // ~1s window
    const fps = 1000 / avgMs;

    // If FPS low, first drop postFX, then reduce resolution; if high, bring back
    if (fps < 50) {
      if (postFxEnabled) {
        togglePostFX(false);
      } else if (resolutionScale > minScale) {
        resolutionScale = Math.max(minScale, resolutionScale * 0.92);
        applyPixelRatio();
      }
    } else if (fps > 58) {
      if (!postFxEnabled && enablePostProcessing) {
        togglePostFX(true);
      } else if (resolutionScale < 1.0) {
        resolutionScale = Math.min(1.0, resolutionScale * 1.05);
        applyPixelRatio();
      }
    }

    perfFrameCount = 0;
    perfAccumMS = 0;
  }

  // Fixed timestep physics for local player
  accumulator += frameTime;
  while (accumulator >= FIXED_TIMESTEP) {
    updateLocalPhysics();
    accumulator -= FIXED_TIMESTEP;
  }

  // Interpolate other entities smoothly with proper timing
  for (const [id, state] of entityStates.entries()) {
    const timeSinceUpdate = now - state.lastUpdate;
    const t = Math.max(0, Math.min(timeSinceUpdate / INTERP_MS, 1));
    const easedT = t * t * (3 - 2 * t);
    const x = state.current.x + (state.target.x - state.current.x) * easedT;
    const y = state.current.y + (state.target.y - state.current.y) * easedT;
    const z = state.current.z + (state.target.z - state.current.z) * easedT;

    const playerMesh = players.get(id);
    if (playerMesh) {
      playerMesh.position.set(x, y, z);
      const nameLabel = playerMesh.userData.nameLabel as THREE.Object3D | undefined;
      if (nameLabel) {
        nameLabel.lookAt(camera.position);
      }
    }
    const mobMesh = mobs.get(id);
    if (mobMesh) mobMesh.position.set(x, y, z);
  }

  updateCamera();
  updateUI();
  updateSpectatorUI();

  // Animate loot drops with smooth bobbing
  for (const mesh of lootDrops.values()) {
    const baseY = mesh.userData.baseY ?? mesh.position.y;
    mesh.position.y = baseY + Math.sin(now * 0.003) * 0.2;
    mesh.rotation.y += 0.02;
  }

  // Update bullets & trails (existing)
  for (let i = activeBullets.length - 1; i >= 0; i--) {
    const bullet = activeBullets[i];
    const age = now - bullet.startTime;

    if (age > bullet.duration) {
      scene.remove(bullet.projectile);
      bullet.projectile.geometry.dispose();
      (bullet.projectile.material as THREE.Material).dispose();

      bullet.trail.forEach(segment => {
        scene.remove(segment);
        segment.geometry.dispose();
        (segment.material as THREE.Material).dispose();
      });

      activeBullets.splice(i, 1);
    } else {
      const progress = age / bullet.duration;
      const position = new THREE.Vector3().lerpVectors(bullet.startPos, bullet.endPos, progress);
      bullet.projectile.position.copy(position);

      if (now - bullet.lastTrailTime > 10 && bullet.trail.length < 10) {
        const prev = bullet.trail.length > 0
          ? (bullet.trail[bullet.trail.length - 1].geometry as THREE.BufferGeometry).attributes.position.array.slice(3, 6)
          : [bullet.startPos.x, bullet.startPos.y, bullet.startPos.z];

        const trailGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(prev[0], prev[1], prev[2]),
          position.clone()
        ]);
        const trailMaterial = new THREE.LineBasicMaterial({
          color: 0xffaa00,
          transparent: true,
          opacity: 0.6,
          linewidth: 2
        });
        const trailSegment = new THREE.Line(trailGeometry, trailMaterial);
        scene.add(trailSegment);
        bullet.trail.push(trailSegment);
        bullet.lastTrailTime = now;
      }

      bullet.trail.forEach((segment, idx) => {
        const opacity = Math.max(0, 0.6 - (bullet.trail.length - idx) * 0.1);
        (segment.material as THREE.LineBasicMaterial).opacity = opacity;
      });

      (bullet.projectile.material as THREE.MeshBasicMaterial).opacity = 1 - progress * 0.5;
    }
  }

  // NEW: update tracer streak fading & recycle
  for (let i = activeTracers.length - 1; i >= 0; i--) {
    const t = activeTracers[i];
    const life = now - t.start;
    const pct = life / t.lifetime;
    if (pct >= 1) {
      scene.remove(t.mesh);
      freeTracer(t.mesh);
      activeTracers.splice(i, 1);
    } else {
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - pct);
    }
  }

  // Fade out muzzle flashes quickly
  for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
    const entry = muzzleFlashes[i];
    const elapsed = now - entry.startTime;
    const life = 120; // ms
    const sprite = entry.mesh;
    const material = sprite.material as THREE.SpriteMaterial;
    if (elapsed >= life) {
      scene.remove(sprite);
      if (material.map) material.map.dispose();
      material.dispose();
      muzzleFlashes.splice(i, 1);
    } else {
      const alpha = 1 - elapsed / life;
      material.opacity = alpha;
      const scale = sprite.scale.x;
      sprite.scale.set(scale * (0.98), scale * (0.98), 1);
    }
  }

  // Throttled enemy outline targeting
  if (outlinePass) {
    outlineThrottle = (outlineThrottle + 1) % 3; // every 3rd frame
    if (outlineThrottle === 0) {
      const raycaster = new THREE.Raycaster();
      if (isPointerLocked) {
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      } else {
        raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);
      }
      const intersects = raycaster.intersectObjects(Array.from(mobs.values()));
      outlinePass.selectedObjects = intersects.length > 0 ? [intersects[0].object] : [];
    }
  }

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }

  // Update audio listener position with camera
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  audioManager.updateListener(camera.position, forward);

  // Update combat intensity for dynamic music
  if (me && myPlayer) {
    let enemiesNearby = 0;
    const playerPos = me.position;

    // Count nearby enemy players (other players within 30 units)
    players.forEach((playerObj, playerId) => {
      if (playerId !== pid) {
        const distance = playerObj.position.distanceTo(playerPos);
        if (distance < 30) {
          enemiesNearby++;
        }
      }
    });

    // Count nearby mobs (AI enemies within 30 units)
    mobs.forEach((mobObj) => {
      const distance = mobObj.position.distanceTo(playerPos);
      if (distance < 30) {
        enemiesNearby++;
      }
    });

    // Check if taking damage (recent damage indicator)
    const takingDamage = lastDamageTime > 0 && (performance.now() - lastDamageTime < 3000);

    // Update combat intensity for dynamic music
    audioManager.updateCombatIntensity(enemiesNearby, takingDamage);
  }

  requestAnimationFrame(animate);
}

// New bullet visual that guarantees visible tracer + keeps your projectile sprite + muzzle flash
function createBulletVisual(start: THREE.Vector3, direction: THREE.Vector3, hit: boolean) {
  const distance = hit ? 25 : 35;
  const end = new THREE.Vector3().copy(start).addScaledVector(direction, distance);

  // Projectile (small glowing sphere) — keep from previous approach
  const projectileGeometry = new THREE.SphereGeometry(0.12, 8, 6);
  const projectileMaterial = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 1
  });
  const projectile = new THREE.Mesh(projectileGeometry, projectileMaterial);
  projectile.position.copy(start);
  scene.add(projectile);

  // Tracer streak (cylinder stretched between start/end)
  const tracer = allocTracer();
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = Math.max(0.001, dir.length());

  tracer.position.copy(mid);
  tracer.scale.set(1, len, 1);
  tracer.lookAt(end); // Simpler rotation method
  tracer.rotateX(Math.PI / 2); // Adjust for cylinder's default orientation

  scene.add(tracer);
  activeTracers.push({ mesh: tracer, start: performance.now(), lifetime: 400 });
  
  // Add a glowing line for better visibility
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xffff00,
    linewidth: 3,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending
  });
  const line = new THREE.Line(lineGeometry, lineMaterial);
  scene.add(line);
  
  // Clean up line after a short time
  setTimeout(() => {
    scene.remove(line);
    lineGeometry.dispose();
    lineMaterial.dispose();
  }, 250);

  // Muzzle flash at muzzle
  createMuzzleFlash([start.x, start.y, start.z]);

  // Animate projectile & cleanup (reuse existing bullet arrays)
  const projectileEntry = {
    projectile,
    trail: [] as THREE.Line[],
    startTime: Date.now(),
    duration: 120,
    startPos: start.clone(),
    endPos: end.clone(),
    lastTrailTime: Date.now()
  };
  activeBullets.push(projectileEntry);

  // Bound projectile pool
  while (activeBullets.length > 20) {
    const old = activeBullets.shift();
    if (!old) break;
    scene.remove(old.projectile);
    old.projectile.geometry.dispose();
    (old.projectile.material as THREE.Material).dispose();
    old.trail.forEach(seg => {
      scene.remove(seg);
      seg.geometry.dispose();
      (seg.material as THREE.Material).dispose();
    });
  }

  // Bound tracer pool
  while (activeTracers.length > 30) {
    const t = activeTracers.shift();
    if (!t) break;
    scene.remove(t.mesh);
    freeTracer(t.mesh);
  }
}

// Set up volume controls
const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
const volumeValue = document.getElementById('volume-value');

if (volumeSlider && volumeValue) {
  volumeSlider.addEventListener('input', (e) => {
    const volume = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    audioManager.setMasterVolume(volume);
    volumeValue.textContent = `${(e.target as HTMLInputElement).value}%`;
  });

  // Set initial volume
  audioManager.setMasterVolume(0.7);
}

// Start background music after first user interaction
let musicStarted = false;
const startBackgroundMusic = () => {
  if (!musicStarted) {
    audioManager.startAmbientMusic();
    musicStarted = true;
  }
};

document.addEventListener('click', startBackgroundMusic, { once: true });
document.addEventListener('keydown', startBackgroundMusic, { once: true });

// Preload voxel models for enemies before starting game
preloadEnemyModels().then(() => {
  console.log('Voxel enemy models preloaded');

  // Start game after models are loaded
  connect();
  animate();
}).catch((error) => {
  console.warn('Failed to preload some enemy models:', error);

  // Start game anyway with procedural geometry
  connect();
  animate();
});

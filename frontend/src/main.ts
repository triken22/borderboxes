// ... existing imports ...
import * as THREE from 'three';
import { makeChunk, makeSkybox, getTerrainHeight, getTerrainNormal, obstacles, updateTerrainAround } from './world';
import { resourceManager } from './resourceManager';
import { ObjectPool } from '../../shared/pooling';
import { GameLoop } from '../../shared/GameLoop';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader';
import { audioManager } from './audio';
import { ENEMY_TYPES, EnemyTypeId, WORLD_SCALE, VISUAL_STYLE, PHYSICS_TUNING } from '../../shared/gameConfig';


let ws: WebSocket | null = null;
let isSpectator = false;
let spectatorUntil = 0;

let isADS = false;
const BASE_FOV = 60;
const ADS_FOV = 42;
let targetFov = BASE_FOV;
let recoilKick = 0; // transient pitch kick after shots
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
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.warn('Unable to obtain 2D context for nameplate rendering; using fallback sprite material');
    return new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true }));
  }
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

  const bounding = new THREE.Box3().setFromObject(group);
  const playerHeight = Math.max(0.001, bounding.max.y - bounding.min.y);
  const normalization = WORLD_SCALE.PLAYER_HEIGHT / playerHeight;
  group.scale.setScalar(normalization);

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

const rootElement = document.documentElement;
rootElement.style.setProperty('--hud-primary', VISUAL_STYLE.COLORS.PRIMARY);
rootElement.style.setProperty('--hud-accent', VISUAL_STYLE.COLORS.ACCENT);
rootElement.style.setProperty('--hud-destructive', VISUAL_STYLE.COLORS.DESTRUCTIVE);

const roomLabel = document.getElementById('room');
const playersOnlineLabel = document.getElementById('players-online');
const healthFillBar = document.getElementById('health-fill');
const killsLabel = document.getElementById('kills');
const inventoryPanelRoot = document.getElementById('inventory');

function updateDifficultyUI(level: Difficulty) {
  currentDifficulty = level;
  difficultyButtons.forEach(btn => {
    const btnLevel = btn.dataset.difficulty as Difficulty | undefined;
    btn.classList.toggle('active', btnLevel === level);
  });
}

function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

function isGun(value: unknown): value is Gun {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Gun>;
  const validArchetype = candidate.archetype === 'pistol' || candidate.archetype === 'smg' || candidate.archetype === 'rifle' || candidate.archetype === 'shotgun';
  const validRarity = candidate.rarity === 'common' || candidate.rarity === 'rare' || candidate.rarity === 'epic' || candidate.rarity === 'legendary';
  return (
    validArchetype &&
    validRarity &&
    typeof candidate.dps === 'number' &&
    typeof candidate.mag === 'number' &&
    typeof candidate.reloadMs === 'number' &&
    typeof candidate.fireRate === 'number' &&
    typeof candidate.accuracy === 'number' &&
    typeof candidate.range === 'number' &&
    typeof candidate.seed === 'string'
  );
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
  maxSpeed: PHYSICS_TUNING.PLAYER_MAX_SPEED,
  sprintMultiplier: 1.5,
  crouchMultiplier: 0.55,
  accel: PHYSICS_TUNING.PLAYER_ACCELERATION,
  decel: PHYSICS_TUNING.PLAYER_DECELERATION,
  airControl: 0.35,
  slideBoost: 2.2
};

const PHYSICS = {
  gravity: Math.abs(PHYSICS_TUNING.GRAVITY),
  jumpPower: PHYSICS_TUNING.PLAYER_JUMP_FORCE,
  terminalVelocity: 55.0,
  airResistance: 0.018,
  slopeSlideAngle: 42
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

const outlineScratch = {
  forward: new THREE.Vector3(),
  toMob: new THREE.Vector3()
};

function buildComposer() {
  composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  outlinePass = new OutlinePass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    scene,
    camera
  );
  outlinePass.edgeStrength = 3.8;
  outlinePass.edgeGlow = 0.55;
  outlinePass.edgeThickness = 2.2;
  outlinePass.pulsePeriod = 0;
  (outlinePass as any).visibleEdgeColor?.set?.(0xffffff);
  (outlinePass as any).hiddenEdgeColor?.set?.(0x101820);
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
interface Gun {
  archetype: 'pistol' | 'smg' | 'rifle' | 'shotgun';
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  dps: number;
  mag: number;
  reloadMs: number;
  fireRate: number;
  accuracy: number;
  range: number;
  seed: string;
}

interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  equipped: Gun | null;
  inventory?: Gun[];
  lives?: number;
  isSpectator?: boolean;
  spectatorUntil?: number;
}

interface Mob {
  id: string;
  type: EnemyTypeId;
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
  item: Gun;
}

interface HelloMessage {
  type: 'hello';
  id: string;
  now?: number;
  player: Player;
  difficulty?: Difficulty;
}

interface SnapshotMessage {
  type: 'snapshot';
  difficulty?: Difficulty;
  players?: Player[];
  mobs?: Mob[];
  loot?: LootDrop[];
}

interface EventMessage {
  type: 'event';
  event: string;
  [key: string]: unknown;
}

type ServerMessage = HelloMessage | SnapshotMessage | EventMessage;

// Setup renderer
const canvas = document.querySelector<HTMLCanvasElement>('#c');
if (!canvas) {
  throw new Error('Unable to locate game canvas element (#c) in the DOM');
}
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMappingExposure = 4.2;
applyPixelRatio();

// Setup scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1625);
scene.fog = new THREE.Fog(0x162031, 140, 560);

// Setup camera
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
camera.position.set(32, 20, 48);

const damageIndicatorScratch = {
  toTarget: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  right: new THREE.Vector3(),
  source: new THREE.Vector3()
};

const terrainProbe = new THREE.Vector3();

let damageIndicatorElement: HTMLDivElement | null = null;
let damageIndicatorFadeTimeout: number | null = null;
let damageIndicatorHideTimeout: number | null = null;

function ensureDamageIndicatorElements() {
  if (damageIndicatorElement) return;

  const indicator = document.createElement('div');
  indicator.style.position = 'fixed';
  indicator.style.top = '50%';
  indicator.style.left = '50%';
  indicator.style.width = '84px';
  indicator.style.height = '84px';
  indicator.style.pointerEvents = 'none';
  indicator.style.opacity = '0';
  indicator.style.zIndex = '1000';
  indicator.style.display = 'none';
  indicator.style.transform = 'translate(-50%, -50%)';
  indicator.style.transition = 'opacity 0.12s ease-out';

  const ring = document.createElement('div');
  ring.style.position = 'absolute';
  ring.style.top = '0';
  ring.style.left = '0';
  ring.style.width = '100%';
  ring.style.height = '100%';
  ring.style.border = '4px solid rgba(255, 120, 120, 0.85)';
  ring.style.borderRadius = '50%';
  ring.style.boxShadow = '0 0 16px rgba(255, 90, 90, 0.65)';
  indicator.appendChild(ring);

  const arrow = document.createElement('div');
  arrow.style.position = 'absolute';
  arrow.style.top = '-18px';
  arrow.style.left = '50%';
  arrow.style.transform = 'translateX(-50%)';
  arrow.style.width = '0';
  arrow.style.height = '0';
  arrow.style.borderLeft = '12px solid transparent';
  arrow.style.borderRight = '12px solid transparent';
  arrow.style.borderBottom = '20px solid rgba(255, 120, 120, 0.95)';
  indicator.appendChild(arrow);

  (document.body ?? document.documentElement).appendChild(indicator);
  damageIndicatorElement = indicator;
}

function showDamageIndicator(sourcePosition: THREE.Vector3) {
  ensureDamageIndicatorElements();
  if (!damageIndicatorElement) return;

  const { toTarget, forward, right } = damageIndicatorScratch;
  toTarget.copy(sourcePosition).sub(camera.position);
  toTarget.y = 0;
  if (toTarget.lengthSq() < 0.0001) return;

  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 0.0001) return;
  forward.normalize();

  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  right.y = 0;
  if (right.lengthSq() < 0.0001) return;
  right.normalize();

  const forwardProj = toTarget.dot(forward);
  const rightProj = toTarget.dot(right);
  if (forwardProj === 0 && rightProj === 0) return;

  const angle = Math.atan2(rightProj, forwardProj);

  damageIndicatorElement.style.display = 'block';
  damageIndicatorElement.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
  damageIndicatorElement.style.opacity = '0.85';

  if (damageIndicatorFadeTimeout !== null) {
    window.clearTimeout(damageIndicatorFadeTimeout);
    damageIndicatorFadeTimeout = null;
  }
  if (damageIndicatorHideTimeout !== null) {
    window.clearTimeout(damageIndicatorHideTimeout);
    damageIndicatorHideTimeout = null;
  }

  damageIndicatorFadeTimeout = window.setTimeout(() => {
    if (!damageIndicatorElement) return;
    damageIndicatorElement.style.opacity = '0';
    damageIndicatorHideTimeout = window.setTimeout(() => {
      if (damageIndicatorElement) {
        damageIndicatorElement.style.display = 'none';
      }
      damageIndicatorHideTimeout = null;
    }, 220);
    damageIndicatorFadeTimeout = null;
  }, 520);
}

// Lighting
const dirLight = new THREE.DirectionalLight(0xff9455, 5.2);
dirLight.position.set(42, 80, 28);
dirLight.castShadow = true;
dirLight.shadow.camera.left = -40;
dirLight.shadow.camera.right = 40;
dirLight.shadow.camera.top = 40;
dirLight.shadow.camera.bottom = -40;
dirLight.shadow.camera.near = 0.1;
dirLight.shadow.camera.far = 160;
dirLight.shadow.mapSize.width = 1536;
dirLight.shadow.mapSize.height = 1536;
dirLight.shadow.bias = -0.0008;
scene.add(dirLight);
dirLight.target.position.set(32, 0, 32);
scene.add(dirLight.target);

const ambLight = new THREE.AmbientLight(0x1c2a3f, 1.6);
scene.add(ambLight);

const hemiLight = new THREE.HemisphereLight(0x56bfff, 0x2b1a18, 1.9);
scene.add(hemiLight);

const fillLight = new THREE.DirectionalLight(0x67afff, 2.8);
fillLight.position.set(-54, 52, -26);
fillLight.castShadow = false;
scene.add(fillLight);

const rimLight = new THREE.PointLight(0xff2d55, 3.2, 120);
rimLight.position.set(32, 18, 32);
rimLight.castShadow = false;
scene.add(rimLight);

// Create world
const skybox = makeSkybox(scene);
makeChunk(scene, [64, 64, 16], 1337);

const DAY_LENGTH_MS = 600000; // 10 minutes instead of 3
let timeOfDayMs = DAY_LENGTH_MS * 0.25;
const sunOrbitRadius = 140;
const mapCenter = new THREE.Vector3(32, 0, 32);

// Clamp lighting parameters so the scene never drops below high-visibility targets.
const VISIBILITY_DAYLIGHT_FLOOR = 0.65;
const VISIBILITY_AMBIENT_FLOOR = 2.0;
const VISIBILITY_HEMI_FLOOR = 1.9;
const VISIBILITY_DIRLIGHT_BASE = 4.7;
const VISIBILITY_DIRLIGHT_PEAK = 6.3;
const VISIBILITY_EXPOSURE_FLOOR = 4.1;

const daySkyTop = new THREE.Color(0x9bd6ff);
const daySkyBottom = new THREE.Color(0xf7e5b5);
const nightSkyTop = new THREE.Color(0x1a314f);
const nightSkyBottom = new THREE.Color(0x263a55);
const dawnSkyTop = new THREE.Color(0x5362a8);
const dawnSkyBottom = new THREE.Color(0xffa974);

const sunDayColor = new THREE.Color(0xfff4cf);
const sunNightColor = new THREE.Color(0xc9d9ff);
const sunDawnColor = new THREE.Color(0xffc487);

const ambientDayColor = new THREE.Color(0xe0edff);
const ambientNightColor = new THREE.Color(0x354766);
const ambientDawnColor = new THREE.Color(0xffd6a9);

const hemiSkyDay = new THREE.Color(0xd6ecff);
const hemiSkyNight = new THREE.Color(0x3b5682);
const hemiSkyDawn = new THREE.Color(0x7a8bff);
const hemiGroundDay = new THREE.Color(0x695536);
const hemiGroundNight = new THREE.Color(0x2a1b12);
const hemiGroundDawn = new THREE.Color(0x4b3723);

const scratchColorA = new THREE.Color();
const scratchColorB = new THREE.Color();
const scratchColorC = new THREE.Color();
const scratchColorD = new THREE.Color();
const scratchColorE = new THREE.Color();
const scratchColorF = new THREE.Color();

const fillSkyColor = new THREE.Color(0xdde9ff);
const fillWarmColor = new THREE.Color(0xfff2cc);

function updateDayNight(deltaMs: number) {
  timeOfDayMs = (timeOfDayMs + deltaMs) % DAY_LENGTH_MS;
  const phase = timeOfDayMs / DAY_LENGTH_MS;
  const sunAngle = phase * Math.PI * 2 - Math.PI / 2;
  const sunHeight = Math.sin(sunAngle);
  const daylight = THREE.MathUtils.clamp((sunHeight + 0.35) / 1.35, 0.1, 1);
  const effectiveDaylight = Math.max(daylight, VISIBILITY_DAYLIGHT_FLOOR);
  const twilight = 1 - THREE.MathUtils.clamp(Math.abs(sunHeight) / 0.4, 0, 1);
  const duskGlow = Math.pow(twilight, 1.2);

  const sunX = mapCenter.x + Math.cos(sunAngle) * sunOrbitRadius;
  const sunY = THREE.MathUtils.lerp(28, 110, THREE.MathUtils.clamp((sunHeight + 1) / 2, 0, 1));
  const sunZ = mapCenter.z + Math.sin(sunAngle) * sunOrbitRadius * 0.6;
  dirLight.position.set(sunX, sunY, sunZ);
  dirLight.target.position.copy(mapCenter);
  dirLight.target.updateMatrixWorld();

  const sunColor = scratchColorA.copy(sunNightColor)
    .lerp(sunDayColor, Math.pow(daylight, 0.7))
    .lerp(sunDawnColor, Math.min(1, duskGlow));
  dirLight.color.copy(sunColor);
  const baseDayStrength = THREE.MathUtils.lerp(
    VISIBILITY_DIRLIGHT_BASE,
    VISIBILITY_DIRLIGHT_PEAK,
    Math.pow(effectiveDaylight, 0.7)
  );
  const twilightFill = Math.min(1.4, duskGlow * 1.05);
  dirLight.intensity = Math.max(VISIBILITY_DIRLIGHT_BASE, baseDayStrength + twilightFill);
  const targetYOffset = THREE.MathUtils.lerp(-18, -6, effectiveDaylight);
  dirLight.target.position.set(mapCenter.x, targetYOffset, mapCenter.z);
  dirLight.target.updateMatrixWorld();
  dirLight.shadow.bias = -0.00085;

  const fillRatio = Math.min(1, effectiveDaylight * 0.6 + duskGlow * 0.4);
  const fillColor = scratchColorE.copy(fillSkyColor).lerp(fillWarmColor, fillRatio);
  fillLight.color.copy(fillColor);
  fillLight.intensity = THREE.MathUtils.lerp(0.85, 1.45, effectiveDaylight);

  const ambientColor = scratchColorB.copy(ambientNightColor)
    .lerp(ambientDayColor, daylight)
    .lerp(ambientDawnColor, Math.min(1, duskGlow));
  ambLight.color.copy(ambientColor);
  ambLight.intensity = Math.max(
    VISIBILITY_AMBIENT_FLOOR,
    THREE.MathUtils.lerp(1.9, 2.4, effectiveDaylight) + duskGlow * 0.5
  );

  const hemiSky = scratchColorC.copy(hemiSkyNight)
    .lerp(hemiSkyDay, daylight)
    .lerp(hemiSkyDawn, Math.min(1, duskGlow));
  hemiLight.color.copy(hemiSky);
  const hemiGround = scratchColorD.copy(hemiGroundNight)
    .lerp(hemiGroundDay, daylight)
    .lerp(hemiGroundDawn, Math.min(1, duskGlow));
  hemiLight.groundColor.copy(hemiGround);
  hemiLight.intensity = Math.max(
    VISIBILITY_HEMI_FLOOR,
    THREE.MathUtils.lerp(1.8, 2.4, effectiveDaylight) + duskGlow * 0.4
  );

  const skyTop = scratchColorA.copy(nightSkyTop)
    .lerp(daySkyTop, daylight)
    .lerp(dawnSkyTop, Math.min(1, duskGlow));
  const skyBottom = scratchColorB.copy(nightSkyBottom)
    .lerp(daySkyBottom, daylight)
    .lerp(dawnSkyBottom, Math.min(1, duskGlow));
  const skyMid = scratchColorF.copy(nightSkyBottom)
    .lerp(daySkyTop, daylight * 0.5)
    .lerp(dawnSkyTop, Math.min(1, duskGlow));
  skybox.uniforms.topColor.value.copy(skyTop);
  skybox.uniforms.middleColor.value.copy(skyMid);
  skybox.uniforms.bottomColor.value.copy(skyBottom);
  skybox.uniforms.gradientPower.value = THREE.MathUtils.lerp(0.65, 1.15, effectiveDaylight);

  if (scene.fog) {
    scene.fog.color.copy(skyBottom);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = THREE.MathUtils.lerp(240, 360, effectiveDaylight) + duskGlow * 60;
      scene.fog.far = THREE.MathUtils.lerp(820, 980, effectiveDaylight) + duskGlow * 90;
    } else if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.density = THREE.MathUtils.lerp(0.003, 0.0018, effectiveDaylight);
    }
  }

  renderer.toneMappingExposure = Math.max(
    VISIBILITY_EXPOSURE_FLOOR,
    THREE.MathUtils.lerp(4.1, 4.7, effectiveDaylight) + Math.min(0.35, duskGlow * 0.2)
  );
}

updateDayNight(0);

// Post-processing for cel-shading effect (optional for performance)
const enablePostProcessing = true; // existing config hook
if (enablePostProcessing) {
  buildComposer();
}

// Shared geometries (create once, reuse many times)
const geometries = {
  player: new THREE.BoxGeometry(0.8, 1.8, 0.8)
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

const mobPalettes: Record<EnemyTypeId | 'default', { base: number; accent: number; glow: number }> = {
  grunt: { base: 0x2c303d, accent: 0xff5a31, glow: 0xff2d55 },
  sniper: { base: 0x2f3145, accent: 0xd6a2ff, glow: 0xf0c3ff },
  heavy: { base: 0x2a292d, accent: 0xff933b, glow: 0xffce4a },
  default: { base: 0x30343c, accent: 0x5fa0ff, glow: 0x9bd2ff }
};

// Thick outline via inverted hull on BackSide
function addInvertedOutline(mesh: THREE.Mesh, scaleFactor = 1.08) {
  const geom = (mesh.geometry as THREE.BufferGeometry).clone();
  const outlineMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide,
    depthWrite: false
  });
  const outline = new THREE.Mesh(geom, outlineMat);
  outline.name = 'outlineHull';
  outline.scale.set(scaleFactor, scaleFactor, scaleFactor);
  // Place outline as child so it follows transforms
  mesh.add(outline);
}

// MOB_TARGET_VISUAL_HEIGHT removed - no longer needed after fixing height normalization

const mobPrototypes = new Map<EnemyTypeId, THREE.Group>();

// Procedurally build all enemy archetypes up front (no external voxel assets)
async function preloadEnemyModels() {
  const builders: Record<EnemyTypeId, () => THREE.Group> = {
    grunt: buildGruntPrototype,
    sniper: buildSniperPrototype,
    heavy: buildHeavyPrototype
  };

  for (const [type, build] of Object.entries(builders) as Array<[EnemyTypeId, () => THREE.Group]>) {
    const group = build();
    mobPrototypes.set(type, group);
  }
}

// Apply shared styling cues (glow hull + telegraph) so every enemy feels cohesive.
function applyMobPostProcess(group: THREE.Group, type: EnemyTypeId | 'default') {
  const tempVec = new THREE.Vector3();
  const glowColors: Record<EnemyTypeId | 'default', number> = {
    grunt: 0xf26d4c,
    sniper: 0xe2a9ff,
    heavy: 0xffd166,
    default: 0xffffff
  };

  let primaryMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> | null = null;
  let largestExtent = 0;

  group.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry) return;

      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(mat => mat.clone());
      } else if (mesh.material) {
        mesh.material = (mesh.material as THREE.Material).clone();
      }

      mesh.castShadow = true;
      mesh.receiveShadow = true;

      geometry.computeBoundingBox();
      const bbox = geometry.boundingBox;
      if (bbox) {
        const extent = bbox.getSize(tempVec).length();
        if (extent > largestExtent) {
          largestExtent = extent;
          primaryMesh = mesh;
        }
      }

      if (mesh.material instanceof THREE.MeshStandardMaterial) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat.emissive.r === 0 && mat.emissive.g === 0 && mat.emissive.b === 0) {
          mat.emissive.copy(mat.color).multiplyScalar(0.35);
        }
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.75);
      } else if (mesh.material instanceof THREE.MeshToonMaterial) {
        const mat = mesh.material as THREE.MeshToonMaterial;
        if (mat.emissive.equals(new THREE.Color(0, 0, 0))) {
          mat.emissive.copy(mat.color).multiplyScalar(0.35);
        }
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.6);
      }
    }
  });

  const baseScaleSource = type === 'default' ? ENEMY_TYPES.grunt : ENEMY_TYPES[type as EnemyTypeId] ?? ENEMY_TYPES.grunt;
  const targetBaseScale = baseScaleSource.scale;

  if (!primaryMesh) {
    group.userData.baseScale = targetBaseScale;
    group.userData.isMobRoot = true;
    return;
  }

  const targetMesh = primaryMesh as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
  const sourceGeometry = (targetMesh.geometry as THREE.BufferGeometry).clone();

  const glowMaterial = new THREE.MeshBasicMaterial({
    color: glowColors[type] ?? glowColors.default,
    transparent: true,
    opacity: 0.14,
    side: THREE.BackSide,
    depthWrite: false
  });
  const glowMesh = new THREE.Mesh(sourceGeometry.clone(), glowMaterial);
  glowMesh.scale.setScalar(1.35);
  glowMesh.name = 'mobGlowHull';
  targetMesh.add(glowMesh);

  const rimMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.35,
    side: THREE.FrontSide,
    depthWrite: false
  });
  const rimMesh = new THREE.Mesh(sourceGeometry.clone(), rimMaterial);
  rimMesh.scale.setScalar(1.05);
  rimMesh.name = 'mobRimHull';
  targetMesh.add(rimMesh);

  // Telegraph ring keeps combat readable; animation driven in the render loop.
  const telegraphRing = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.7, 40),
    new THREE.MeshBasicMaterial({
      color: glowColors[type] ?? glowColors.default,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  telegraphRing.name = 'mobTelegraph';
  telegraphRing.rotation.x = -Math.PI / 2;
  telegraphRing.position.y = 0.05;
  telegraphRing.scale.setScalar(targetBaseScale * WORLD_SCALE.MOB_WIDTH * 1.2);
  group.add(telegraphRing);

  const bounding = new THREE.Box3().setFromObject(group);
  const rawHeight = Math.max(0.001, bounding.max.y - bounding.min.y);
  const desiredHeight = baseScaleSource.height;
  const normalization = desiredHeight / rawHeight;

  group.scale.setScalar(normalization);
  group.userData.baseScale = normalization;
  group.userData.mobType = type;
  group.userData.isMobRoot = true;
}

// Clone archetype meshes and rehydrate materials while preserving our authored scale.
function clonePrototype(group: THREE.Group, type: EnemyTypeId): THREE.Object3D {
  const clone = group.clone(true);
  clone.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(mat => mat.clone());
      } else if (mesh.material) {
        mesh.material = (mesh.material as THREE.Material).clone();
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  // IMPORTANT: Do not height-normalize here.
  // Previously we measured the already-scaled object and applied a "correction"
  // toward MOB_TARGET_VISUAL_HEIGHT, which compounded the scale and shrank enemies
  // to microscopic sizes. We now use the baseScale directly for predictable sizing.
  // The snapshot loop re-applies userData.baseScale to preserve consistency.
  const baseScale = group.userData.baseScale ?? ENEMY_TYPES[type]?.scale ?? ENEMY_TYPES.grunt.scale;
  clone.scale.setScalar(baseScale);

  // Do NOT height-normalize here. Previous logic divided by the measured height
  // of the already scaled mesh, shrinking enemies to microscopic size. Keep the
  // baseScale authoritative so gameplay, telegraphs, and hitboxes stay in sync.
  clone.userData.baseScale = baseScale;
  clone.userData.isMobRoot = true;
  clone.userData.mobType = type;
  clone.userData.animPhase = Math.random() * Math.PI * 2;

  return clone;
}

function buildGruntPrototype(): THREE.Group {
  const palette = mobPalettes.grunt;
  const group = new THREE.Group();

  const chassis = new THREE.MeshStandardMaterial({ color: palette.base, roughness: 0.55, metalness: 0.35 });
  const trim = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.4, metalness: 0.45 });
  const glow = new THREE.MeshStandardMaterial({
    color: palette.glow,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 1.6,
    metalness: 0.2,
    roughness: 0.25
  });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.8, 1.2), chassis);
  torso.position.set(0, 1.3, 0);
  addInvertedOutline(torso);
  group.add(torso);

  const furnace = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 0.1), glow);
  furnace.position.set(0, 1.35, 0.7);
  addInvertedOutline(furnace, 1.02);
  group.add(furnace);

  const pauldrons = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.4, 0.9), trim);
  pauldrons.position.set(0, 1.95, 0);
  addInvertedOutline(pauldrons);
  group.add(pauldrons);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.9), chassis);
  head.position.set(0, 2.3, 0);
  addInvertedOutline(head);
  group.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.25, 0.1), glow);
  visor.position.set(0, 2.3, 0.55);
  addInvertedOutline(visor);
  group.add(visor);

  const hornGeom = new THREE.BoxGeometry(0.25, 0.25, 1.1);
  const hornL = new THREE.Mesh(hornGeom, glow);
  hornL.position.set(0.9, 2.55, 0.45);
  hornL.rotation.z = -0.2;
  addInvertedOutline(hornL);
  group.add(hornL);
  const hornR = hornL.clone();
  hornR.position.x = -0.9;
  hornR.rotation.z = 0.2;
  group.add(hornR);

  const upperArmGeo = new THREE.BoxGeometry(0.6, 0.8, 0.6);
  const foreArmGeo = new THREE.BoxGeometry(0.6, 0.7, 0.6);
  const fistGeo = new THREE.BoxGeometry(0.7, 0.6, 0.7);
  [-1, 1].forEach(side => {
    const upper = new THREE.Mesh(upperArmGeo, chassis);
    upper.position.set(side * 1.25, 1.6, 0);
    addInvertedOutline(upper);
    group.add(upper);

    const lower = new THREE.Mesh(foreArmGeo, chassis);
    lower.position.set(side * 1.25, 1.0, 0.15);
    addInvertedOutline(lower);
    group.add(lower);

    const fist = new THREE.Mesh(fistGeo, trim);
    fist.position.set(side * 1.25, 0.55, 0.3);
    addInvertedOutline(fist);
    group.add(fist);

    const flame = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.4), glow);
    flame.position.set(side * 1.25, 0.2, 0.3);
    addInvertedOutline(flame, 1.05);
    group.add(flame);
  });

  const pack = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.9), chassis);
  pack.position.set(0, 1.45, -0.8);
  addInvertedOutline(pack);
  group.add(pack);

  const thrusterGeo = new THREE.BoxGeometry(0.45, 0.95, 0.45);
  [-0.65, 0.65].forEach(offset => {
    const thruster = new THREE.Mesh(thrusterGeo, trim);
    thruster.position.set(offset, 0.95, -0.95);
    addInvertedOutline(thruster);
    group.add(thruster);

    const exhaust = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.85, 0.35), glow);
    exhaust.position.set(offset, 0.45, -0.95);
    addInvertedOutline(exhaust, 1.04);
    group.add(exhaust);
  });

  const legGeo = new THREE.BoxGeometry(0.75, 1.45, 0.75);
  [-0.6, 0.6].forEach(offset => {
    const leg = new THREE.Mesh(legGeo, chassis);
    leg.position.set(offset, 0.7, 0);
    addInvertedOutline(leg);
    group.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 1.2), trim);
    boot.position.set(offset, 0, 0.2);
    addInvertedOutline(boot);
    group.add(boot);
  });

  applyMobPostProcess(group, 'grunt');
  return group;
}

function buildSniperPrototype(): THREE.Group {
  // SNIPER CUBE - marksman with ghillie plates (blocky)
  const palette = mobPalettes.sniper;
  const group = new THREE.Group();

  const camoA = new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.3,
    roughness: 0.55
  });
  const camoB = new THREE.MeshStandardMaterial({
    color: palette.accent,
    metalness: 0.25,
    roughness: 0.6
  });
  const laserMat = new THREE.MeshStandardMaterial({
    color: palette.glow,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 1.0,
    metalness: 0.2,
    roughness: 0.3
  });

  // Body stack
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.5), camoA);
  pelvis.position.set(0, 0.6, 0);
  addInvertedOutline(pelvis);
  group.add(pelvis);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.6), camoB);
  torso.position.set(0, 1.2, 0);
  addInvertedOutline(torso);
  group.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), camoA);
  head.position.set(0, 1.8, 0);
  addInvertedOutline(head);
  group.add(head);

  // Ghillie plates (simple small boxes)
  const plates: Array<[number, number, number]> = [
    [-0.35, 1.45, 0.2], [0.35, 1.35, 0.1], [0.0, 1.55, -0.2], [0.2, 1.1, 0.25], [-0.2, 1.0, -0.25]
  ];
  for (const [px, py, pz] of plates) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.3), camoA);
    plate.position.set(px, py, pz);
    addInvertedOutline(plate);
    group.add(plate);
  }

  // Arms
  const armGeom = new THREE.BoxGeometry(0.22, 0.9, 0.22);
  const leftArm = new THREE.Mesh(armGeom, camoB);
  leftArm.position.set(-0.6, 1.25, 0.05);
  addInvertedOutline(leftArm);
  group.add(leftArm);
  const rightArm = new THREE.Mesh(armGeom, camoB);
  rightArm.position.set(0.6, 1.25, 0.05);
  addInvertedOutline(rightArm);
  group.add(rightArm);

  // Legs
  const legGeom = new THREE.BoxGeometry(0.28, 0.9, 0.28);
  const leftLeg = new THREE.Mesh(legGeom, camoA);
  leftLeg.position.set(-0.25, 0.45, 0.05);
  addInvertedOutline(leftLeg);
  group.add(leftLeg);
  const rightLeg = new THREE.Mesh(legGeom, camoA);
  rightLeg.position.set(0.25, 0.45, 0.05);
  addInvertedOutline(rightLeg);
  group.add(rightLeg);

  // Long rifle (boxy)
  const rifleBody = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.16), camoB);
  rifleBody.position.set(0.2, 1.35, 0.4);
  addInvertedOutline(rifleBody);
  rifleBody.name = 'weapon';
  group.add(rifleBody);

  const rifleBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 0.08), camoA);
  rifleBarrel.position.set(1.0, 1.35, 0.4);
  addInvertedOutline(rifleBarrel);
  group.add(rifleBarrel);

  // Laser box
  const laser = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05), laserMat);
  laser.position.set(1.0, 1.42, 0.52);
  addInvertedOutline(laser);
  group.add(laser);

  applyMobPostProcess(group, 'sniper');
  return group;
}

function buildHeavyPrototype(): THREE.Group {
  // RIOT SHIELD - defensive unit (blocky)
  const palette = mobPalettes.heavy;
  const group = new THREE.Group();

  const armor = new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.25,
    roughness: 0.7
  });
  const hazard = new THREE.MeshStandardMaterial({
    color: palette.accent,
    metalness: 0.4,
    roughness: 0.5
  });
  const redGlow = new THREE.MeshStandardMaterial({
    color: palette.glow,
    emissive: new THREE.Color(palette.glow),
    emissiveIntensity: 0.9,
    metalness: 0.15,
    roughness: 0.35
  });

  // Body
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.3, 0.6), armor);
  torso.position.set(0, 1.0, 0);
  addInvertedOutline(torso);
  group.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), armor);
  head.position.set(0, 1.7, 0);
  addInvertedOutline(head);
  group.add(head);

  // Shield panel
  const shield = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.8, 0.15), armor);
  shield.position.set(0, 1.1, 0.45);
  shield.name = 'shield';
  addInvertedOutline(shield);
  group.add(shield);

  // Viewport slit
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.05), redGlow);
  slit.position.set(0, 1.5, 0.54);
  addInvertedOutline(slit);
  group.add(slit);

  // Hazard stripes (rect boxes)
  const stripe1 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.02), hazard);
  stripe1.position.set(0, 0.7, 0.54);
  stripe1.rotation.z = 0.2;
  addInvertedOutline(stripe1);
  group.add(stripe1);

  const stripe2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.02), hazard);
  stripe2.position.set(0, 0.4, 0.54);
  stripe2.rotation.z = 0.2;
  addInvertedOutline(stripe2);
  group.add(stripe2);

  // Arms and legs
  const armGeom = new THREE.BoxGeometry(0.25, 0.9, 0.25);
  const leftArm = new THREE.Mesh(armGeom, armor);
  leftArm.position.set(-0.7, 1.2, 0.15);
  addInvertedOutline(leftArm);
  group.add(leftArm);

  const rightArm = new THREE.Mesh(armGeom, armor);
  rightArm.position.set(0.7, 1.2, 0.15);
  addInvertedOutline(rightArm);
  group.add(rightArm);

  const legGeom = new THREE.BoxGeometry(0.35, 1.0, 0.35);
  const leftLeg = new THREE.Mesh(legGeom, armor);
  leftLeg.position.set(-0.3, 0.5, 0.05);
  addInvertedOutline(leftLeg);
  group.add(leftLeg);

  const rightLeg = new THREE.Mesh(legGeom, armor);
  rightLeg.position.set(0.3, 0.5, 0.05);
  addInvertedOutline(rightLeg);
  group.add(rightLeg);

  // Baton holster (block)
  const baton = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.12), hazard);
  baton.position.set(0.6, 1.0, -0.35);
  addInvertedOutline(baton);
  group.add(baton);

  applyMobPostProcess(group, 'heavy');
  return group;
}

const mobPrototypeFactories: Record<EnemyTypeId, () => THREE.Group> = {
  grunt: buildGruntPrototype,
  sniper: buildSniperPrototype,
  heavy: buildHeavyPrototype
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

function createMobModel(type: EnemyTypeId): THREE.Object3D {
  const key: EnemyTypeId = mobPrototypeFactories[type] ? type : 'grunt';
  let prototype = mobPrototypes.get(key);

  if (!prototype) {
    const builder = mobPrototypeFactories[key];
    if (builder) {
      prototype = builder();
      mobPrototypes.set(key, prototype);
    }
  }

  if (!prototype) {
    prototype = buildGruntPrototype();
    mobPrototypes.set('grunt', prototype);
  }

  return clonePrototype(prototype, key);
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
type RemotePlayerMesh = THREE.Object3D & { equipped?: Gun | null };
const players = new Map<string, RemotePlayerMesh>();
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
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.warn('Unable to create muzzle flash texture; returning blank canvas');
    return canvas;
  }
  
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
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.warn('Unable to draw hit marker; missing 2D rendering context');
    return;
  }

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
let inventory: Gun[] = [];
let kills = 0;
let lives = 3;
let sendInputIntervalId: number | null = null;
let reconnectTimeout: number | null = null;

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
  if (reconnectTimeout !== null) {
    window.clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // For local development, connect to localhost:8787
  // For production, use the actual worker URL
  const wsBase = API_BASE.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/rooms/lobby/ws?pid=${pid}`;

  ws = new WebSocket(wsUrl);

  ws.onmessage = (ev) => {
    let parsed: unknown;
    try {
      parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(String(ev.data));
    } catch (error) {
      console.warn('Failed to parse message from server', { error, data: ev.data });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      console.warn('Ignoring unsupported server message', parsed);
      return;
    }

    const msg = parsed as ServerMessage;

    if (msg.type === 'hello') {
      trackEvent('session_start', { difficulty: msg.difficulty ?? currentDifficulty });
      pid = msg.id;
      myPlayer = msg.player;

      // Update inventory if player has items
      if (Array.isArray(msg.player?.inventory)) {
        inventory = msg.player.inventory.filter(isGun);
        console.log('Inventory updated:', inventory);
        updateInventoryUI();
      }

      if (isDifficulty(msg.difficulty)) {
        updateDifficultyUI(msg.difficulty);
      }

      if (roomLabel) {
        roomLabel.textContent = 'lobby';
      }
    }

    if (msg.type === 'snapshot') {
      if (isDifficulty(msg.difficulty)) {
        updateDifficultyUI(msg.difficulty);
      }
      // Update players
      const snapshotPlayers: Player[] = Array.isArray(msg.players) ? msg.players : [];
      if (playersOnlineLabel) {
        playersOnlineLabel.textContent = snapshotPlayers.length.toString();
      }
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
      if (healthFillBar) {
        healthFillBar.style.width = `${healthPercent}%`;
      }
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
            const state = entityStates.get(p.id);
            if (state) {
              state.current = { ...state.target };
              state.target = { x: p.x, y: p.y, z: p.z };
              state.lastUpdate = nowMs();
            }
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
      const snapshotMobs: Mob[] = Array.isArray(msg.mobs) ? msg.mobs : [];
      const seenMobs = new Set<string>();
      for (const m of snapshotMobs) {
        seenMobs.add(m.id);

        if (!mobs.has(m.id)) {
          const mobModel = createMobModel(m.type);
          scene.add(mobModel);
          mobs.set(m.id, mobModel);
        }

        // Store target position for interpolation
        // Use terrain height for mob Y position
        const mobY = getTerrainHeight(m.x, m.z);

        if (!entityStates.has(m.id)) {
          entityStates.set(m.id, {
            current: { x: m.x, y: mobY, z: m.z },
            target: { x: m.x, y: mobY, z: m.z },
            lastUpdate: nowMs()
          });
        } else {
          const state = entityStates.get(m.id);
          if (state) {
            state.current = { ...state.target };
            state.target = { x: m.x, y: mobY, z: m.z };
            state.lastUpdate = nowMs();
          }
        }

        // Scale based on health
        const mobMesh = mobs.get(m.id);
        if (mobMesh) {
          const baseScale = (mobMesh.userData.baseScale as number | undefined) ?? ENEMY_TYPES[m.type].scale;
          mobMesh.scale.setScalar(baseScale);
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
      const snapshotLoot: LootDrop[] = Array.isArray(msg.loot) ? msg.loot : [];
      const seenLoot = new Set<string>();
      for (const l of snapshotLoot) {
        seenLoot.add(l.id);

        if (!lootDrops.has(l.id)) {
          const lootModel = createLootModel(l.item);
          scene.add(lootModel);
          lootDrops.set(l.id, lootModel);
        }
        const mesh = lootDrops.get(l.id);
        if (mesh) {
          mesh.userData.baseY = l.y;
          mesh.position.set(l.x, l.y, l.z);
          mesh.rotation.y = 0;
        }
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
      if (msg.event === 'difficulty' && isDifficulty(msg.difficulty)) {
        updateDifficultyUI(msg.difficulty);
        trackEvent('difficulty_updated', { level: msg.difficulty });
      }

      if (msg.event === 'kill') {
        const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
        trackEvent('kill', { playerId, mobId: msg.mobId, isLocal: playerId === pid });
        if (playerId === pid) {
          kills++;
          if (killsLabel) {
            killsLabel.textContent = kills.toString();
          }
          audioManager.play('enemy_death');
        }
      }

      if (msg.event === 'pickup' && isGun(msg.item)) {
        trackEvent('loot_pickup', { playerId: msg.playerId, rarity: msg.item.rarity });
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
        if (!Array.isArray(msg.origin) || msg.origin.length < 3 || !Array.isArray(msg.direction) || msg.direction.length < 3) {
          console.warn('Ignoring malformed shot event', msg);
          return;
        }

        const shooterId = typeof msg.playerId === 'string' ? msg.playerId : undefined;
        const isLocalShot = shooterId === pid;
        const startVec =
          isLocalShot
            ? getMuzzleWorldPosition()
            : new THREE.Vector3(msg.origin[0], msg.origin[1], msg.origin[2]);
        const dirVec = new THREE.Vector3(msg.direction[0], msg.direction[1], msg.direction[2]).normalize();

        if (!(isSpectator && isLocalShot)) {
          createBulletVisual(startVec, dirVec, !!msg.hit); // NEW visual with tracer + projectile
        }

        // Play weapon sound based on the shooting player's equipped weapon
        if (isLocalShot) {
          if (!isSpectator) {
            const weaponType = myPlayer?.equipped?.archetype || 'pistol';
            const soundName = weaponType === 'smg' ? 'smg_fire' :
                             weaponType === 'rifle' ? 'rifle_fire' :
                             weaponType === 'shotgun' ? 'shotgun_fire' : 'pistol_fire';
            audioManager.play(soundName);
          }
        } else if (shooterId) {
          // Other player shooting - use 3D positional audio
          const remotePlayer = players.get(shooterId);
          const weaponType = remotePlayer?.equipped?.archetype ?? 'pistol';
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

      if (msg.event === 'damage' && typeof msg.targetId === 'string' && msg.targetId === pid) {
        if (isSpectator) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'damageAck',
              ignored: true,
              reason: 'spectator',
              amount: msg.damage,
              sourceId: msg.sourceId,
              t: nowMs()
            }));
          }
          trackEvent('spectator_damage_ignored', {
            amount: msg.damage,
            sourceId: msg.sourceId
          });
        } else {
          trackEvent('damage_taken', { amount: msg.damage, sourceId: msg.sourceId });

          const attackerObj = mobs.get(msg.sourceId) ?? players.get(msg.sourceId);
          if (attackerObj?.isObject3D) {
            attackerObj.getWorldPosition(damageIndicatorScratch.source);
            showDamageIndicator(damageIndicatorScratch.source);
          }

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
      }

      if (msg.event === 'lootDrop') {
        // handled by snapshot/loot map in next tick; keep as-is
      }

      if (msg.event === 'playerDeath' && typeof msg.playerId === 'string' && msg.playerId === pid) {
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

      if (msg.event === 'equip' && isGun(msg.item)) {
        trackEvent('weapon_equip', { playerId: msg.playerId, rarity: msg.item.rarity, archetype: msg.item.archetype });
        if (msg.playerId === pid) {
          myPlayer = myPlayer ? { ...myPlayer, equipped: msg.item } : myPlayer;
          console.log('Player equipped weapon:', msg.item);
          applyWeaponCosmetics(msg.item);

          // Play equip sound
          audioManager.play('menu_click');
        } else if (typeof msg.playerId === 'string') {
          // Update other player's equipped weapon
          const otherPlayer = players.get(msg.playerId);
          if (otherPlayer) {
            otherPlayer.equipped = msg.item;
          }
        }
      }

      if (msg.event === 'spectator' && typeof msg.playerId === 'string' && msg.playerId === pid) {
        isSpectator = true;
        spectatorUntil = msg.until ?? (Date.now() + 45000);
        firing = false;
        updateSpectatorUI();
      }

      if (msg.event === 'playerRespawn' && typeof msg.playerId === 'string' && msg.playerId === pid) {
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
    ws = null;
    if (reconnectTimeout !== null) {
      window.clearTimeout(reconnectTimeout);
    }
    reconnectTimeout = window.setTimeout(connect, 1000);
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
    if (!isSpectator) {
      firing = true;
    }
  }
  if (isPointerLocked && e.button === 2) { // Right click -> ADS on
    e.preventDefault();
    isADS = true;
    trackEvent('ads_on');
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    e.preventDefault();
    firing = false;
  }
  if (e.button === 2) {
    e.preventDefault();
    isADS = false;
    trackEvent('ads_off');
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
  if (e.code === 'Enter' && e.altKey) {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // Escape to unlock pointer
  if (e.code === 'Escape' && isPointerLocked) {
    document.exitPointerLock();
    return;
  }

  if (e.code === 'F1' || e.code === 'F2' || e.code === 'F3') {
    e.preventDefault();
    let level: Difficulty = 'normal';
    if (e.code === 'F1') level = 'easy';
    else if (e.code === 'F2') level = 'normal';
    else if (e.code === 'F3') level = 'hard';

    trackEvent('difficulty_selected', { level });
    sendDifficulty(level);
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
function resolveCollision(currentPos: THREE.Vector3, desiredPos: THREE.Vector3, radius = WORLD_SCALE.PLAYER_WIDTH * 0.5 + PHYSICS_TUNING.COLLISION_TOLERANCE): THREE.Vector3 {
  const result = desiredPos.clone();
  const STEP_HEIGHT = 0.6;

  for (const obstacle of obstacles.values()) {
    const expandedMin = obstacle.bounds.min.clone().subScalar(radius);
    const expandedMax = obstacle.bounds.max.clone().addScalar(radius);

    const intersects =
      desiredPos.x >= expandedMin.x && desiredPos.x <= expandedMax.x &&
      desiredPos.y >= expandedMin.y && desiredPos.y <= expandedMax.y &&
      desiredPos.z >= expandedMin.z && desiredPos.z <= expandedMax.z;

    if (!intersects) continue;

    // Determine axis with smallest penetration
    const penetrations = [
      { axis: 'x', depth: Math.min(desiredPos.x - expandedMin.x, expandedMax.x - desiredPos.x) },
      { axis: 'y', depth: Math.min(desiredPos.y - expandedMin.y, expandedMax.y - desiredPos.y) },
      { axis: 'z', depth: Math.min(desiredPos.z - expandedMin.z, expandedMax.z - desiredPos.z) }
    ].sort((a, b) => a.depth - b.depth);
    const smallest = penetrations[0];

    // Try a step-up when hitting vertical face (x/z), if the top of obstacle is within step height
    if ((smallest.axis === 'x' || smallest.axis === 'z')) {
      const topY = expandedMax.y + 0.001;
      const requiredLift = topY - currentPos.y;
      if (requiredLift > 0 && requiredLift <= STEP_HEIGHT) {
        // Step onto obstacle top and preserve intended horizontal motion
        result.set(desiredPos.x, topY, desiredPos.z);
        continue;
      }
    }

    // Otherwise slide-along as before
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

  const terrainHeight = getTerrainHeight(localPosition.x, localPosition.z);
  const onGround = localPosition.y <= terrainHeight + 0.1;

  if (isSpectator) {
    return;
  }

  // Stamina and sprint are unchanged...
  if (isSprinting && (keys.has('KeyW') || keys.has('KeyS') || keys.has('KeyA') || keys.has('KeyD'))) {
    stamina = Math.max(0, stamina - dt * 20);
    if (stamina <= 0) {
      isSprinting = false;
      isSliding = false;
    }
  } else {
    stamina = Math.min(100, stamina + dt * 10);
  }

  // Inputs
  let inputForward = 0;
  let inputRight = 0;
  if (keys.has('KeyW')) inputForward += 1;
  if (keys.has('KeyS')) inputForward -= 1;
  if (keys.has('KeyD')) inputRight += 1;
  if (keys.has('KeyA')) inputRight -= 1;
  const inputLen = Math.sqrt(inputForward * inputForward + inputRight * inputRight);
  if (inputLen > 1) {
    inputForward /= inputLen;
    inputRight /= inputLen;
  }

  // Movement modifiers (ADS penalty adds subtle control feel)
  let speedMultiplier = 1.0;
  if (isSliding) {
    speedMultiplier = MOVE.slideBoost;
  } else if (isSprinting && stamina > 0) {
    speedMultiplier = MOVE.sprintMultiplier;
  } else if (isCrouching) {
    speedMultiplier = MOVE.crouchMultiplier;
  }
  if (isADS) {
    speedMultiplier *= 0.85;
  }

  const targetVX = (inputRight * right.x + inputForward * forward.x) * MOVE.maxSpeed * speedMultiplier;
  const targetVZ = (inputRight * right.z + inputForward * forward.z) * MOVE.maxSpeed * speedMultiplier;

  // ... existing acceleration/friction/reconciliation/gravity logic unchanged ...

  const controlFactor = onGround ? 1.0 : MOVE.airControl;
  const ax = (targetVX - velocity.x) * MOVE.accel * controlFactor;
  const az = (targetVZ - velocity.z) * MOVE.accel * controlFactor;
  velocity.x += ax * dt;
  velocity.z += az * dt;

  if (onGround && inputRight === 0 && inputForward === 0 && !isSliding) {
    velocity.x *= 1 / (1 + MOVE.decel * dt);
    velocity.z *= 1 / (1 + MOVE.decel * dt);
  }

  if (isSliding) {
    velocity.x *= 1 / (1 + MOVE.decel * 0.2 * dt);
    velocity.z *= 1 / (1 + MOVE.decel * 0.2 * dt);
  }

  localPosition.x += reconcileError.x * RECONCILE.posGain * dt;
  localPosition.y += reconcileError.y * RECONCILE.posGain * dt;
  localPosition.z += reconcileError.z * RECONCILE.posGain * dt;
  const decay = Math.max(0, 1 - RECONCILE.posGain * dt);
  reconcileError.x *= decay;
  reconcileError.y *= decay;
  reconcileError.z *= decay;

  const vLen = Math.hypot(velocity.x, velocity.z);
  if (vLen > MOVE.maxSpeed * 1.5) {
    const scale = (MOVE.maxSpeed * 1.5) / vLen;
    velocity.x *= scale;
    velocity.z *= scale;
  }

  if (onGround) {
    coyoteTime = COYOTE_TIME_MAX;
  } else {
    coyoteTime = Math.max(0, coyoteTime - dt);
  }

  if (keys.has('Space')) {
    jumpBufferTime = JUMP_BUFFER_MAX;
  } else {
    jumpBufferTime = Math.max(0, jumpBufferTime - dt);
  }

  if (jumpBufferTime > 0 && (onGround || coyoteTime > 0)) {
    velocity.y = PHYSICS.jumpPower;
    if (isSliding) {
      velocity.x *= 1.3;
      velocity.z *= 1.3;
    }
    coyoteTime = 0;
    jumpBufferTime = 0;
  }

  if (!onGround) {
    velocity.y -= PHYSICS.gravity * dt;
    velocity.y = Math.max(-PHYSICS.terminalVelocity, velocity.y);
    velocity.x *= 1 - PHYSICS.airResistance * dt;
    velocity.z *= 1 - PHYSICS.airResistance * dt;
  }

  const currentPos = new THREE.Vector3(localPosition.x, localPosition.y, localPosition.z);
  const desiredPos = new THREE.Vector3(
    localPosition.x + velocity.x * dt,
    localPosition.y + velocity.y * dt,
    localPosition.z + velocity.z * dt
  );

  const resolvedPos = resolveCollision(currentPos, desiredPos);

  localPosition.x = resolvedPos.x;
  localPosition.y = resolvedPos.y;
  localPosition.z = resolvedPos.z;

  if (Math.abs(resolvedPos.x - desiredPos.x) > 0.01) velocity.x *= 0.5;
  if (Math.abs(resolvedPos.y - desiredPos.y) > 0.01) velocity.y = 0;
  if (Math.abs(resolvedPos.z - desiredPos.z) > 0.01) velocity.z *= 0.5;

  const newTerrainHeight = getTerrainHeight(localPosition.x, localPosition.z);
  if (localPosition.y <= newTerrainHeight) {
    localPosition.y = newTerrainHeight;
    if (velocity.y < 0) {
      velocity.y = 0;
      const slopeNormal = getTerrainNormal(localPosition.x, localPosition.z);
      const slope = Math.sqrt(1 - slopeNormal.y * slopeNormal.y);
      if (slope > Math.tan(PHYSICS.slopeSlideAngle * Math.PI / 180)) {
        const downhill = new THREE.Vector3(-slopeNormal.x, 0, -slopeNormal.z).normalize();
        velocity.x += downhill.x * 2;
        velocity.z += downhill.z * 2;
      }
    }
  }

  localPosition.x = Math.max(0, Math.min(64, localPosition.x));
  localPosition.z = Math.max(0, Math.min(64, localPosition.z));

  me.position.set(localPosition.x, localPosition.y, localPosition.z);
}

// Send input to server
function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

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
    firing: !isSpectator && firing,
    ads: !!isADS
  };

  ws.send(JSON.stringify(inputData));
}

if (sendInputIntervalId !== null) {
  window.clearInterval(sendInputIntervalId);
}
sendInputIntervalId = window.setInterval(sendInput, 50);

// Update inventory UI
function updateInventoryUI() {
  if (!inventoryPanelRoot) {
    return;
  }

  inventoryPanelRoot.innerHTML = '';

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

    inventoryPanelRoot.appendChild(slot);
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

  // Target FOV by ADS state; smooth toward it
  targetFov = isADS ? ADS_FOV : BASE_FOV;
  camera.fov += (targetFov - camera.fov) * 0.18;
  camera.updateProjectionMatrix();

  // Apply rotation from mouse look with small recoil decay
  recoilKick *= 0.9;
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch - recoilKick;

  // Subtle weapon mounting changes in ADS
  if (gunGroup) {
    const targetY = isADS ? -0.28 : -0.25;
    const targetX = isADS ? 0.28 : 0.35;
    const targetZ = isADS ? -1.05 : -0.9;
    gunGroup.position.x += (targetX - gunGroup.position.x) * 0.2;
    gunGroup.position.y += (targetY - gunGroup.position.y) * 0.2;
    gunGroup.position.z += (targetZ - gunGroup.position.z) * 0.2;
  }
}

function updateSpectatorUI() {
  const overlay = document.getElementById('spectator-overlay');
  const countdownLabel = document.getElementById('spectator-countdown');
  if (overlay && countdownLabel) {
    if (isSpectator) {
      overlay.style.display = 'flex';
      const remaining = Math.max(0, spectatorUntil - Date.now());
      countdownLabel.textContent = Math.ceil(remaining / 1000).toString();
    } else {
      overlay.style.display = 'none';
    }
  }

  if (gunGroup) {
    gunGroup.visible = !isSpectator;
  }

  const crosshair = document.querySelector<HTMLElement>('.crosshair');
  if (crosshair) {
    crosshair.style.opacity = isSpectator ? '0' : '1';
  }

  if (inventoryPanelRoot) {
    inventoryPanelRoot.style.opacity = isSpectator ? '0.4' : '1';
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

  updateDayNight(frameTime);
  terrainProbe.set(localPosition.x, localPosition.y, localPosition.z);
  updateTerrainAround(terrainProbe);

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
    if (mobMesh) {
      const type = (mobMesh.userData.mobType as EnemyTypeId | undefined) ?? 'grunt';
      const baseScale = (mobMesh.userData.baseScale as number | undefined) ?? ENEMY_TYPES[type].scale;
      const enemyConfig = ENEMY_TYPES[type];
      const phase = (mobMesh.userData.animPhase as number | undefined) ?? 0;
      const behaviorBob = enemyConfig.behavior === 'defensive' ? 0.06 : enemyConfig.behavior === 'sniper' ? 0.05 : 0.09;
      const bob = Math.sin((now + phase) * 0.0025) * behaviorBob * enemyConfig.height * 0.15;
      mobMesh.position.set(x, y + bob, z);

      const spinRate = enemyConfig.behavior === 'defensive' ? 0.0008 : enemyConfig.behavior === 'sniper' ? 0.0012 : 0.002;
      mobMesh.rotation.y += spinRate;

      const telegraph = mobMesh.getObjectByName('mobTelegraph') as THREE.Mesh | undefined;
      if (telegraph && telegraph.material instanceof THREE.MeshBasicMaterial) {
        const pulse = 0.26 + Math.sin((now + phase) * 0.004) * 0.1;
        telegraph.material.opacity = Math.max(0.12, Math.min(0.5, pulse));
        telegraph.scale.setScalar(enemyConfig.width * 1.8);
    
        if (!telegraph.userData.particles) {
          const jetGeom = new THREE.BufferGeometry();
          const positions = new Float32Array(180);
          for (let i = 0; i < positions.length; i += 3) {
            const angle = (i / positions.length) * Math.PI * 2;
            const radius = 0.55 + Math.random() * 0.15;
            positions[i] = Math.cos(angle) * radius;
            positions[i + 1] = 0;
            positions[i + 2] = Math.sin(angle) * radius;
          }
          jetGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          const jetMat = new THREE.PointsMaterial({
            color: glowColors[type] ?? glowColors.default,
            size: 0.08,
            transparent: true,
            opacity: 0.45,
            depthWrite: false
          });
          const ringFx = new THREE.Points(jetGeom, jetMat);
          ringFx.name = 'telegraphFX';
          telegraph.add(ringFx);
          telegraph.userData.particles = ringFx;
        }
        const fx = telegraph.userData.particles as THREE.Points;
        if (fx && fx.material instanceof THREE.PointsMaterial) {
          fx.rotateY(0.01);
          fx.material.opacity = telegraph.material.opacity * 0.85;
        }
      }
    }
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
      const mobObjects = Array.from(mobs.values());
      const intersects = raycaster.intersectObjects(mobObjects, true);
      const outlineSet = new Set<THREE.Object3D>();
      const candidates: Array<{ obj: THREE.Object3D; distance: number }> = [];
      const pushCandidate = (obj: THREE.Object3D | null | undefined, distance: number) => {
        if (!obj) return;
        let root: THREE.Object3D | null = obj;
        while (root && !root.userData?.isMobRoot && root.parent) {
          root = root.parent as THREE.Object3D;
        }
        if (!root) root = obj;
        if (outlineSet.has(root)) return;
        outlineSet.add(root);
        candidates.push({ obj: root, distance });
      };

      const forwardDir = outlineScratch.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      forwardDir.y = 0;
      if (forwardDir.lengthSq() < 1e-4) {
        forwardDir.set(0, 0, -1);
      }
      forwardDir.normalize();

      const toMob = outlineScratch.toMob;
      mobObjects.forEach(mobObj => {
        toMob.copy(mobObj.position).sub(camera.position);
        const distance = toMob.length();
        if (distance < 0.5 || distance > 42) return;
        toMob.normalize();
        const facing = toMob.dot(forwardDir);
        if (facing > -0.25) {
          pushCandidate(mobObj, distance);
        }
      });

      if (intersects.length > 0) {
        const primary = intersects[0];
        pushCandidate(primary.object, primary.distance ?? 0);
      }

      candidates.sort((a, b) => a.distance - b.distance);
      const MAX_OUTLINED = 6;
      outlinePass.selectedObjects = candidates.slice(0, MAX_OUTLINED).map(entry => entry.obj);
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
  const weaponRange = myPlayer?.equipped?.range ?? 35;
  const maxDistance = Math.max(25, Math.min(weaponRange, 120));
  const distance = hit ? Math.min(maxDistance, weaponRange) : maxDistance;
  const end = new THREE.Vector3().copy(start).addScaledVector(direction, distance);

  // Projectile (small glowing sphere)
  const projectileGeometry = new THREE.SphereGeometry(0.12, 8, 6);
  const projectileMaterial = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 1
  });
  const projectile = new THREE.Mesh(projectileGeometry, projectileMaterial);
  projectile.position.copy(start);
  scene.add(projectile);

  // Tracer streak
  const tracer = allocTracer();
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = Math.max(0.001, dir.length());
  tracer.position.copy(mid);
  tracer.scale.set(1, len, 1);
  tracer.lookAt(end);
  tracer.rotateX(Math.PI / 2);
  scene.add(tracer);
  activeTracers.push({ mesh: tracer, start: performance.now(), lifetime: PHYSICS_TUNING.PROJECTILE_LIFETIME * 1000 });

  // Glowing line overlay
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
  setTimeout(() => {
    scene.remove(line);
    lineGeometry.dispose();
    lineMaterial.dispose();
  }, 250);

  // Muzzle flash and projectile tween (unchanged core)
  createMuzzleFlash([start.x, start.y, start.z]);

  const projectileEntry = {
    projectile,
    trail: [] as THREE.Line[],
    startTime: Date.now(),
    duration: PHYSICS_TUNING.PROJECTILE_LIFETIME * 1000,
    startPos: start.clone(),
    endPos: end.clone(),
    lastTrailTime: Date.now()
  };
  activeBullets.push(projectileEntry);

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

  while (activeTracers.length > 30) {
    const t = activeTracers.shift();
    if (!t) break;
    scene.remove(t.mesh);
    freeTracer(t.mesh);
  }

  // Add micro recoil
  recoilKick += isADS ? 0.004 : 0.008;
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

window.addEventListener('beforeunload', () => {
  if (sendInputIntervalId !== null) {
    window.clearInterval(sendInputIntervalId);
    sendInputIntervalId = null;
  }
  if (reconnectTimeout !== null) {
    window.clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
});

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

// Cross-browser fullscreen helpers
function getFullscreenElement(): Element | null {
  const d = document as any;
  return document.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement || null;
}

async function requestAppFullscreen(target?: HTMLElement) {
  const el = target ?? document.documentElement;
  const anyEl = el as any;
  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen();
    } else if (anyEl.webkitRequestFullscreen) {
      await anyEl.webkitRequestFullscreen();
    } else if (anyEl.mozRequestFullScreen) {
      await anyEl.mozRequestFullScreen();
    } else if (anyEl.msRequestFullscreen) {
      await anyEl.msRequestFullscreen();
    }
  } catch (_err) {
    // ignore failures; browser may block without user gesture
  }
}

async function exitAppFullscreen() {
  const d = document as any;
  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (d.webkitExitFullscreen) {
      await d.webkitExitFullscreen();
    } else if (d.mozCancelFullScreen) {
      await d.mozCancelFullScreen();
    } else if (d.msExitFullscreen) {
      await d.msExitFullscreen();
    }
  } catch (_err) {
    // ignore
  }
}

async function toggleFullscreen() {
  if (getFullscreenElement()) {
    trackEvent('fullscreen_exit');
    await exitAppFullscreen();
  } else {
    trackEvent('fullscreen_enter');
    // Fullscreen the entire game page (canvas + HUD) so the browser UI is hidden.
    await requestAppFullscreen(document.documentElement);
  }
}

// Keep renderer sized correctly when entering/exiting fullscreen (cross-vendor events)
['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach((evt) => {
  (document as any).addEventListener(evt, () => {
    // Recompute sizes immediately (in addition to window 'resize')
    resize();
  });
});

export const WORLD_SCALE = {
  PLAYER_HEIGHT: 1.8,
  PLAYER_WIDTH: 0.6,
  MOB_HEIGHT: 1.8,
  MOB_WIDTH: 0.6,
  WEAPON_SCALE: 1.0,
  WORLD_UNIT: 1.0,
  PIXEL_PER_UNIT: 32
} as const;

export type EnemyBehavior = 'aggressive' | 'defensive' | 'sniper';
export type EnemyTypeId = 'grunt' | 'sniper' | 'heavy';

export interface EnemyDefinition {
  id: EnemyTypeId;
  name: string;
  scale: number;
  height: number;
  width: number;
  hitRadius: number;
  behavior: EnemyBehavior;
}

const baseHeight = WORLD_SCALE.MOB_HEIGHT;
const baseWidth = WORLD_SCALE.MOB_WIDTH;

export const ENEMY_TYPES: Record<EnemyTypeId, EnemyDefinition> = {
  grunt: {
    id: 'grunt',
    name: 'Grunt',
    scale: 1.0,
    height: baseHeight,
    width: baseWidth,
    hitRadius: baseWidth * 0.55,
    behavior: 'aggressive'
  },
  sniper: {
    id: 'sniper',
    name: 'Sniper',
    scale: 1.0,
    height: baseHeight,
    width: baseWidth,
    hitRadius: baseWidth * 0.5,
    behavior: 'sniper'
  },
  heavy: {
    id: 'heavy',
    name: 'Heavy',
    scale: 1.2,
    height: baseHeight * 1.2,
    width: baseWidth * 1.2,
    hitRadius: baseWidth * 0.7,
    behavior: 'defensive'
  }
};

export const ENEMY_TYPE_LIST: EnemyDefinition[] = Object.values(ENEMY_TYPES);

export const VISUAL_STYLE = {
  COLORS: {
    PRIMARY: '#ff6b35',
    SECONDARY: '#2d5aa0',
    ACCENT: '#f39c12',
    NEUTRAL: '#95a5a6',
    DESTRUCTIVE: '#e74c3c'
  },
  LIGHTING: {
    AMBIENT_INTENSITY: 0.4,
    DIRECTIONAL_INTENSITY: 0.8,
    POINT_LIGHT_RANGE: 10,
    SHADOW_MAP_SIZE: 1024
  },
  POST_PROCESSING: {
    BLOOM_THRESHOLD: 0.8,
    BLOOM_INTENSITY: 1.2,
    VIGNETTE_INTENSITY: 0.3,
    COLOR_CORRECTION: true
  }
} as const;

export const PHYSICS_TUNING = {
  PLAYER_ACCELERATION: 20,
  PLAYER_DECELERATION: 15,
  PLAYER_MAX_SPEED: 8,
  PLAYER_JUMP_FORCE: 8,
  PROJECTILE_SPEED: 60,
  PROJECTILE_LIFETIME: 2,
  HIT_FEEDBACK_DELAY: 0.05,
  GRAVITY: -20,
  FRICTION: 0.8,
  BOUNCE_DAMPING: 0.3,
  COLLISION_TOLERANCE: 0.1
} as const;

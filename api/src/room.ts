import { Env } from './index';
import { rollGun, Gun } from './loot';
import { createTerrainHeightMap } from './terrain';
import { ENEMY_TYPES, EnemyTypeId, WORLD_SCALE, PHYSICS_TUNING } from '../../shared/gameConfig';
import { GameLoop } from '../../shared/GameLoop';

const MOVE = {
  maxSpeed: PHYSICS_TUNING.PLAYER_MAX_SPEED,
  accel: PHYSICS_TUNING.PLAYER_ACCELERATION,
  decel: PHYSICS_TUNING.PLAYER_DECELERATION,
  airControl: 0.35,
  sprintMultiplier: 1.5
};

const PHYSICS = {
  gravity: Math.abs(PHYSICS_TUNING.GRAVITY),
  jumpPower: PHYSICS_TUNING.PLAYER_JUMP_FORCE,
  terminalVelocity: 55,
  airResistance: 0.018
};

const JUMP = {
  coyoteMs: 150,
  bufferMs: 120
};

const PLAYER_EYE_HEIGHT = 1.5;
const WORLD_SIZE = 64;
const FIXED_TICK = 1 / 60;
const MAX_LIVES = 3;
const SPECTATOR_TIMEOUT_MS = 45000;

type Difficulty = 'easy' | 'normal' | 'hard';

const DIFFICULTY_CONFIG: Record<Difficulty, {
  maxMobs: number;
  spawnInterval: number;
  damageMultiplier: number;
  speedMultiplier: number;
  rangeMultiplier: number;
  mobTypes: EnemyTypeId[];
}> = {
  easy: {
    maxMobs: 3,
    spawnInterval: 220,
    damageMultiplier: 0.45,
    speedMultiplier: 0.75,
    rangeMultiplier: 0.6,
    mobTypes: ['grunt', 'sniper']
  },
  normal: {
    maxMobs: 8,
    spawnInterval: 150,
    damageMultiplier: 0.85,
    speedMultiplier: 0.9,
    rangeMultiplier: 0.9,
    mobTypes: ['grunt', 'sniper', 'heavy']
  },
  hard: {
    maxMobs: 12,
    spawnInterval: 110,
    damageMultiplier: 1.15,
    speedMultiplier: 1.05,
    rangeMultiplier: 1.1,
    mobTypes: ['grunt', 'sniper', 'heavy']
  }
};

export class Room {
  private state: DurableObjectState;
  private env: Env;
  private sockets = new Map<string, WebSocket>();
  private players = new Map<string, Player>();
  private mobs = new Map<string, Mob>();
  private loot = new Map<string, LootDrop>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private gameLoop: GameLoop | null = null;
  private tickMs: number;
  private updatesPerSecond: number;
  private tickCounter = 0;
  private roomSeed: string;
  private terrain = createTerrainHeightMap(WORLD_SIZE, WORLD_SIZE, 1337);
  private difficulty: Difficulty = 'normal';

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    const hz = Math.max(20, Number(env.TICK_HZ || 60));
    this.updatesPerSecond = hz;
    this.tickMs = Math.max(10, Math.floor(1000 / hz));
    this.roomSeed = crypto.randomUUID();
  }

  private getTerrainHeight(x: number, z: number) {
    return this.terrain.getHeight(x, z);
  }

  private getDifficultyConfig() {
    return DIFFICULTY_CONFIG[this.difficulty];
  }

  private setDifficulty(level: Difficulty) {
    if (this.difficulty === level) return;
    this.difficulty = level;

    // Trim excess mobs if the new difficulty has a lower cap
    const config = this.getDifficultyConfig();
    if (this.mobs.size > config.maxMobs) {
      const surplus = this.mobs.size - config.maxMobs;
      const ids = Array.from(this.mobs.keys());
      for (let i = 0; i < surplus; i++) {
        const id = ids[i];
        if (!id) break;
        this.mobs.delete(id);
      }
    }

    this.broadcast({
      type: 'event',
      event: 'difficulty',
      difficulty: level
    });
  }

  private handleDifficulty(_playerId: string, level: unknown) {
    if (typeof level !== 'string') return;
    if (level === 'easy' || level === 'normal' || level === 'hard') {
      this.setDifficulty(level);
    }
  }

  private async handleAnalytics(data: unknown) {
    try {
      // Forward analytics to the main worker for storage
      // (D1 is not directly accessible from Durable Objects)
      const response = await fetch('https://borderboxes-api.highfive.workers.dev/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        console.error('Failed to forward analytics:', response.status);
      }
    } catch (error) {
      console.error('Failed to save analytics event:', error);
      // Don't throw - analytics should not break gameplay
    }
  }

  private handleDamageAck(playerId: string, msg: unknown) {
    if (!msg || typeof msg !== 'object') return;
    const player = this.players.get(playerId);
    if (!player) return;

    const payload = msg as { ignored?: unknown; reason?: unknown };
    if (!payload.ignored) return;

    if (payload.reason === 'spectator') {
      player.lastSpectatorAck = Date.now();
    }
  }

  private hasLineOfSight(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number
  ): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(4, Math.ceil(distance * 1.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const sx = ax + dx * t;
      const sz = az + dz * t;
      const sy = ay + dy * t;
      const terrainTop = this.getTerrainHeight(sx, sz) + 0.6;
      if (terrainTop > sy) {
        return false;
      }
    }
    return true;
  }

  private applyDamage(player: Player, baseDamage: number, sourceId: string, options: { ignoreLineOfSight?: boolean } = {}) {
    if (player.invulnerable) return false;
    const now = Date.now();
    const COOLDOWN_MS = 200;
    if (player.lastDamageAt && now - player.lastDamageAt < COOLDOWN_MS) {
      return false;
    }

    if (!options.ignoreLineOfSight) {
      const sourceMob = this.mobs.get(sourceId);
      if (sourceMob) {
        const sourceY = sourceMob.y + 0.8;
        const targetY = player.y + PLAYER_EYE_HEIGHT;
        if (!this.hasLineOfSight(sourceMob.x, sourceY, sourceMob.z, player.x, targetY, player.z)) {
          return false;
        }
      }
    }

    const scaled = Math.max(1, Math.round(baseDamage * this.getDifficultyConfig().damageMultiplier));
    player.hp = Math.max(0, player.hp - scaled);
    player.lastDamageAt = now;
    this.broadcast({
      type: 'event',
      event: 'damage',
      targetId: player.id,
      damage: scaled,
      sourceId
    });
    return true;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);

    // Enable CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname.endsWith("/ws") && req.headers.get("Upgrade") === "websocket") {
      const pid = url.searchParams.get("pid") ?? crypto.randomUUID();
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      await this.handleSocket(server, pid);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("room ok", { headers: corsHeaders });
  }

  private async handleSocket(ws: WebSocket, playerId: string) {
    ws.accept();
    this.sockets.set(playerId, ws);

    // Initialize player if new
    if (!this.players.has(playerId)) {
      const spawnX = 32 + (Math.random() - 0.5) * 10;
      const spawnZ = 32 + (Math.random() - 0.5) * 10;
      const spawnY = this.getTerrainHeight(spawnX, spawnZ);

      // Give player a starter pistol
      const starterGun = rollGun(`starter_${playerId}_${Date.now()}`);

      const now = Date.now();
      this.players.set(playerId, {
        id: playerId,
        name: `Player${playerId.substring(0, 4)}`,
        x: spawnX,
        y: spawnY,
        z: spawnZ,
        vx: 0,
        vy: 0,
        vz: 0,
        hp: 100,
        maxHp: 100,
        equipped: starterGun,
        inventory: [starterGun],
        firing: false,
        aimX: 0,
        aimY: 0,
        aimZ: 0,
        lastFireTime: 0,
        t: now,
        inputForward: 0,
        inputRight: 0,
        jumpQueued: false,
        jumpHeld: false,
        jumpRequestedAt: 0,
        lastGroundTime: now,
        invulnerable: true,
        invulnerableUntil: now + 5000,
        lives: MAX_LIVES,
        isSpectator: false,
        spectatorUntil: 0,
        lastSpectatorAck: 0
      });
    }

    // Send initial hello with player state
    ws.send(JSON.stringify({
      type: "hello",
      id: playerId,
      now: Date.now(),
      player: this.players.get(playerId),
      difficulty: this.difficulty
    }));

    // Handle messages
    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
        const msg = JSON.parse(raw);
        if (msg.type === "input") this.applyInput(playerId, msg);
        else if (msg.type === "pickup") this.handlePickup(playerId, msg.lootId);
        else if (msg.type === "equip") this.handleEquip(playerId, msg.itemId);
        else if (msg.type === "setDifficulty") this.handleDifficulty(playerId, msg.level);
        else if (msg.type === "analytics") this.handleAnalytics(msg.data);
        else if (msg.type === "damageAck") this.handleDamageAck(playerId, msg);
      } catch (e) {
        console.error("Error handling message:", e);
      }
    });

    // Handle disconnect
    ws.addEventListener("close", () => {
      this.sockets.delete(playerId);
      // Keep player state for 60 seconds for reconnection
      setTimeout(() => {
        if (!this.sockets.has(playerId)) {
          this.players.delete(playerId);
        }
      }, 60000);

      // Stop ticking if room is empty
      if (this.sockets.size === 0) this.stopTick();
    });

    // Start game loop if not running
    if (!this.tickTimer) this.startTick();
  }

  private applyInput(id: string, msg: unknown) {
    const player = this.players.get(id);
    if (!player || !msg || typeof msg !== 'object') return;

    const payload = msg as {
      move?: unknown;
      aim?: unknown;
      firing?: unknown;
      ads?: unknown;
      t?: unknown;
    };

    const moveArray = Array.isArray(payload.move) ? payload.move : [];
    const rawRight = typeof moveArray[0] === 'number' ? moveArray[0] : 0;
    const rawJump = typeof moveArray[1] === 'number' ? moveArray[1] : 0;
    const rawBack = typeof moveArray[2] === 'number' ? moveArray[2] : 0;

    player.inputRight = Math.max(-1, Math.min(1, rawRight));
    player.inputForward = Math.max(-1, Math.min(1, -rawBack));

    const aimArray = Array.isArray(payload.aim) ? payload.aim : null;
    if (player.isSpectator) {
      if (aimArray && aimArray.length >= 3) {
        player.aimX = typeof aimArray[0] === 'number' ? aimArray[0] : player.aimX;
        player.aimY = typeof aimArray[1] === 'number' ? aimArray[1] : player.aimY;
        player.aimZ = typeof aimArray[2] === 'number' ? aimArray[2] : player.aimZ;
      }
      return;
    }

    const jumpPressed = rawJump > 0.5;
    if (jumpPressed && !player.jumpHeld) {
      player.jumpQueued = true;
      player.jumpRequestedAt = Date.now();
    }
    player.jumpHeld = jumpPressed;

    if (aimArray && aimArray.length >= 3) {
      player.aimX = typeof aimArray[0] === 'number' ? aimArray[0] : player.aimX;
      player.aimY = typeof aimArray[1] === 'number' ? aimArray[1] : player.aimY;
      player.aimZ = typeof aimArray[2] === 'number' ? aimArray[2] : player.aimZ;
    }

    if (typeof payload.ads === 'boolean') {
      player.ads = payload.ads;
    }

    player.firing = !!payload.firing;
    player.t = typeof payload.t === 'number' ? payload.t : Date.now();
  }

  private handlePickup(playerId: string, lootId: string) {
    const player = this.players.get(playerId);
    const loot = this.loot.get(lootId);
    if (!player || !loot) return;

    // Check distance
    const dx = player.x - loot.x;
    const dz = player.z - loot.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 3) return; // Too far

    // Add to inventory
    player.inventory.push(loot.item);
    if (!player.equipped) {
      player.equipped = loot.item;
    }

    // Remove loot from world
    this.loot.delete(lootId);

    // Broadcast pickup event
    this.broadcast({
      type: "event",
      event: "pickup",
      playerId,
      lootId,
      item: loot.item
    });
  }

  private handleEquip(playerId: string, itemId: string) {
    const player = this.players.get(playerId);
    if (!player) return;

    const item = player.inventory.find(i => i.seed === itemId);
    if (item) {
      player.equipped = item;

      // Broadcast equip event to all players
      this.broadcast({
        type: 'event',
        event: 'equip',
        playerId,
        item
      });
    }
  }

  private spawnMob() {
    const difficultyConfig = this.getDifficultyConfig();
    if (this.mobs.size >= difficultyConfig.maxMobs) return;

    const allowedTypes = difficultyConfig.mobTypes.length > 0 ? difficultyConfig.mobTypes : (['grunt', 'sniper', 'heavy'] as const);
    if (allowedTypes.length === 0) return;

    const weightByType: Record<EnemyTypeId, number> = {
      grunt: 60,
      sniper: 25,
      heavy: 15
    };

    const weightedPool = allowedTypes.map(type => ({ type, weight: weightByType[type] ?? 1 }));
    const totalWeight = weightedPool.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    let random = Math.random() * totalWeight;
    let type: EnemyTypeId = weightedPool[0]?.type ?? 'grunt';

    for (const entry of weightedPool) {
      random -= entry.weight;
      if (random <= 0) {
        type = entry.type;
        break;
      }
    }

    const baseHp: Record<EnemyTypeId, number> = {
      grunt: 55,
      sniper: 35,
      heavy: 140
    };

    const id = `mob_${this.tickCounter}_${Math.random().toString(36).substring(7)}`;
    let angle = Math.random() * Math.PI * 2;
    let dist = 20 + Math.random() * 20;
    let spawnX = 32 + Math.cos(angle) * dist;
    let spawnZ = 32 + Math.sin(angle) * dist;

    for (let attempt = 0; attempt < 4; attempt++) {
      let tooClose = false;
      for (const player of this.players.values()) {
        const dx = player.x - spawnX;
        const dz = player.z - spawnZ;
        if (Math.sqrt(dx * dx + dz * dz) < 12) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) break;
      angle = Math.random() * Math.PI * 2;
      dist = 20 + Math.random() * 20;
      spawnX = 32 + Math.cos(angle) * dist;
      spawnZ = 32 + Math.sin(angle) * dist;
    }

    const spawnY = this.getTerrainHeight(spawnX, spawnZ);
    const hp = baseHp[type];
    const maxHp = hp;

    this.mobs.set(id, {
      id,
      type,
      x: spawnX,
      y: spawnY + 0.5,
      z: spawnZ,
      vx: 0,
      vy: 0,
      vz: 0,
      hp,
      maxHp,
      target: null,
      lastAttackTime: 0,
      state: 'patrol',
      patrolTarget: { x: Math.random() * 64, z: Math.random() * 64 }
    });
  }

  private updateMobs(dt: number) {
    const now = Date.now();
    const config = this.getDifficultyConfig();
    const speedScale = config.speedMultiplier;

    for (const mob of this.mobs.values()) {
      const enemyConfig = ENEMY_TYPES[mob.type];
      if (!enemyConfig) {
        continue;
      }

      let nearestPlayer: Player | null = null;
      let nearestDist = Infinity;

      for (const player of this.players.values()) {
        if (player.invulnerable) continue;
        const dx = player.x - mob.x;
        const dz = player.z - mob.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPlayer = player;
        }
      }

      mob.target = nearestPlayer?.id ?? null;

      const baseAlert = enemyConfig.behavior === 'sniper' ? 45 : enemyConfig.behavior === 'defensive' ? 24 : 30;
      const baseAttack = enemyConfig.behavior === 'sniper' ? 40 : enemyConfig.behavior === 'defensive' ? 10 : 6;
      const alertRange = baseAlert * config.rangeMultiplier;
      const attackRange = baseAttack * config.rangeMultiplier;

      if (nearestPlayer && nearestDist < alertRange) {
        mob.state = nearestDist < attackRange ? 'attack' : 'alert';

        const dx = nearestPlayer.x - mob.x;
        const dz = nearestPlayer.z - mob.z;
        const dist = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));

        switch (mob.type) {
          case 'grunt': {
            const chaseSpeed = 0.09 * speedScale;
            mob.vx = (dx / dist) * chaseSpeed;
            mob.vz = (dz / dist) * chaseSpeed;
            mob.vx += -(dz / dist) * 0.015 * speedScale;
            mob.vz += (dx / dist) * 0.015 * speedScale;

            if (dist < 2.6 && now - mob.lastAttackTime > 900) {
              if (this.applyDamage(nearestPlayer, 16, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
          }
          case 'sniper': {
            const retreatDist = 32;
            const reengageDist = 44;
            if (dist < retreatDist) {
              mob.vx = -(dx / dist) * 0.04 * speedScale;
              mob.vz = -(dz / dist) * 0.04 * speedScale;
            } else if (dist > reengageDist) {
              mob.vx = (dx / dist) * 0.026 * speedScale;
              mob.vz = (dz / dist) * 0.026 * speedScale;
            } else {
              mob.vx = 0;
              mob.vz = 0;
            }

            if (dist < reengageDist && now - mob.lastAttackTime > 3200) {
              if (this.applyDamage(nearestPlayer, 34, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
          }
          case 'heavy': {
            const lumberSpeed = 0.035 * speedScale;
            mob.vx = (dx / dist) * lumberSpeed;
            mob.vz = (dz / dist) * lumberSpeed;

            if (dist < 6 && now - mob.lastAttackTime > 2200) {
              for (const player of this.players.values()) {
                const pdx = player.x - mob.x;
                const pdz = player.z - mob.z;
                const pdist = Math.sqrt(pdx * pdx + pdz * pdz);
                if (pdist < 8.5) {
                  const falloff = Math.max(2, Math.floor(26 - pdist * 2.2));
                  this.applyDamage(player, falloff, mob.id, { ignoreLineOfSight: true });
                }
              }
              mob.lastAttackTime = now;
            }
            break;
          }
        }
      } else {
        mob.state = 'patrol';
        if (mob.patrolTarget) {
          const dx = mob.patrolTarget.x - mob.x;
          const dz = mob.patrolTarget.z - mob.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < 2) {
            mob.patrolTarget = { x: Math.random() * WORLD_SIZE, z: Math.random() * WORLD_SIZE };
          } else {
            const patrolSpeed = 0.05 * speedScale;
            mob.vx = (dx / dist) * patrolSpeed;
            mob.vz = (dz / dist) * patrolSpeed;
          }
        } else if (Math.random() < 0.02) {
          mob.vx = (Math.random() - 0.5) * 0.05 * speedScale;
          mob.vz = (Math.random() - 0.5) * 0.05 * speedScale;
        }
      }

      const stepScale = Math.max(0.001, dt / FIXED_TICK);
      const GRAVITY = 0.03;
      const TERMINAL_VEL = 2.0;

      mob.vy -= GRAVITY * stepScale;
      if (mob.vy < -TERMINAL_VEL) {
        mob.vy = -TERMINAL_VEL;
      }

      mob.x += mob.vx * stepScale;
      mob.y += mob.vy * stepScale;
      mob.z += mob.vz * stepScale;

      const ground = this.getTerrainHeight(mob.x, mob.z);
      if (mob.y <= ground) {
        mob.y = ground;
        if (mob.vy < 0) {
          mob.vy = 0;
        }
      }

      const onGround = Math.abs(mob.y - ground) < 0.05;
      const damp = onGround ? 0.9 : 0.98;
      mob.vx *= Math.pow(damp, stepScale);
      mob.vz *= Math.pow(damp, stepScale);

      mob.x = Math.max(0, Math.min(WORLD_SIZE, mob.x));
      mob.z = Math.max(0, Math.min(WORLD_SIZE, mob.z));

      for (const player of this.players.values()) {
        const dx = mob.x - player.x;
        const dz = mob.z - player.z;
        const horizontalDist = Math.sqrt(dx * dx + dz * dz);
        const minSeparation = enemyConfig.width + WORLD_SCALE.PLAYER_WIDTH;
        if (horizontalDist < minSeparation) {
          const pushDist = minSeparation - horizontalDist;
          const inv = horizontalDist > 0.001 ? 1 / horizontalDist : 0;
          const offsetX = (horizontalDist > 0.001 ? dx * inv : (Math.random() - 0.5)) * pushDist;
          const offsetZ = (horizontalDist > 0.001 ? dz * inv : (Math.random() - 0.5)) * pushDist;
          mob.x = Math.max(0, Math.min(WORLD_SIZE, mob.x + offsetX));
          mob.z = Math.max(0, Math.min(WORLD_SIZE, mob.z + offsetZ));
          mob.y = this.getTerrainHeight(mob.x, mob.z);
        }
      }

      if (mob.hp <= 0) {
        if (Math.random() < 0.3) {
          const lootId = `loot_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          const gun = rollGun(`${this.roomSeed}_${lootId}`);
          this.loot.set(lootId, {
            id: lootId,
            x: mob.x,
            y: mob.y,
            z: mob.z,
            item: gun
          });

          this.broadcast({
            type: "event",
            event: "lootDrop",
            lootId,
            x: mob.x,
            y: mob.y,
            z: mob.z,
            item: gun
          });
        }

        this.mobs.delete(mob.id);
      }
    }
  }

  private updatePlayers(dt: number) {
    const now = Date.now();

    for (const player of this.players.values()) {
      if (player.invulnerable && player.invulnerableUntil && now >= player.invulnerableUntil) {
        player.invulnerable = false;
        player.invulnerableUntil = undefined;
      }

      if (player.isSpectator) {
        if (player.spectatorUntil && now >= player.spectatorUntil) {
          player.isSpectator = false;
          player.lives = MAX_LIVES;
          player.spectatorUntil = 0;
          this.respawnPlayer(player);
        } else {
          player.firing = false;
          continue;
        }
      }

      if (player.hp <= 0 && !player.isDead) {
        player.isDead = true;
        player.lives = Math.max(0, player.lives - 1);
        this.broadcast({
          type: "event",
          event: "playerDeath",
          playerId: player.id,
          x: player.x,
          y: player.y,
          z: player.z,
          lives: player.lives
        });

        if (player.lives > 0) {
          setTimeout(() => this.respawnPlayer(player), 3000);
        } else {
          player.isSpectator = true;
          player.spectatorUntil = now + SPECTATOR_TIMEOUT_MS;
          this.broadcast({
            type: "event",
            event: "spectator",
            playerId: player.id,
            until: player.spectatorUntil
          });
        }
        continue;
      }

      if (player.isDead) {
        player.firing = false;
        continue;
      }

      if (player.jumpQueued && now - player.jumpRequestedAt > JUMP.bufferMs) {
        player.jumpQueued = false;
      }

      let forwardX = 0;
      let forwardZ = -1;
      const aimLen = Math.sqrt(player.aimX * player.aimX + player.aimY * player.aimY + player.aimZ * player.aimZ);
      if (aimLen > 1e-5) {
        forwardX = player.aimX / aimLen;
        forwardZ = player.aimZ / aimLen;
        const forwardLen = Math.hypot(forwardX, forwardZ);
        if (forwardLen > 1e-5) {
          forwardX /= forwardLen;
          forwardZ /= forwardLen;
        }
      }
      const rightX = forwardZ;
      const rightZ = -forwardX;

      let desiredX = rightX * player.inputRight + forwardX * player.inputForward;
      let desiredZ = rightZ * player.inputRight + forwardZ * player.inputForward;
      const desiredLen = Math.hypot(desiredX, desiredZ);
      if (desiredLen > 1) {
        desiredX /= desiredLen;
        desiredZ /= desiredLen;
      }

      // ADS imposes a small speed penalty server-side for fairness
      const adsSpeedScale = player.ads ? 0.85 : 1.0;

      const targetVx = desiredX * MOVE.maxSpeed * adsSpeedScale;
      const targetVz = desiredZ * MOVE.maxSpeed * adsSpeedScale;

      const ground = this.getTerrainHeight(player.x, player.z);
      const onGround = player.y <= ground + 0.05;
      if (onGround) {
        player.lastGroundTime = now;
        if (player.y < ground) {
          player.y = ground;
        }
      }

      const control = onGround ? 1 : MOVE.airControl;
      player.vx += (targetVx - player.vx) * Math.min(1, MOVE.accel * dt * control);
      player.vz += (targetVz - player.vz) * Math.min(1, MOVE.accel * dt * control);

      if (onGround && desiredLen < 0.01) {
        const damping = 1 / (1 + MOVE.decel * dt);
        player.vx *= damping;
        player.vz *= damping;
      }

      if (!onGround) {
        player.vx *= 1 - PHYSICS.airResistance * dt;
        player.vz *= 1 - PHYSICS.airResistance * dt;
      }

      const canJump = onGround || now - player.lastGroundTime < JUMP.coyoteMs;
      if (player.jumpQueued && canJump) {
        player.vy = PHYSICS.jumpPower;
        player.jumpQueued = false;
        player.jumpHeld = true;
      }

      if (!onGround) {
        player.vy -= PHYSICS.gravity * dt;
        if (player.vy < -PHYSICS.terminalVelocity) {
          player.vy = -PHYSICS.terminalVelocity;
        }
      } else if (player.vy < 0) {
        player.vy = 0;
      }

      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.z += player.vz * dt;

      const newGround = this.getTerrainHeight(player.x, player.z);
      if (player.y <= newGround) {
        player.y = newGround;
        if (player.vy < 0) {
          player.vy = 0;
        }
        player.lastGroundTime = now;
      }

      if (player.x < 0 || player.x > WORLD_SIZE) {
        player.x = Math.max(0, Math.min(WORLD_SIZE, player.x));
        player.vx = 0;
      }
      if (player.z < 0 || player.z > WORLD_SIZE) {
        player.z = Math.max(0, Math.min(WORLD_SIZE, player.z));
        player.vz = 0;
      }

      if (player.firing && player.equipped) {
        const fireDelay = 1000 / player.equipped.fireRate;
        if (now - player.lastFireTime > fireDelay) {
          player.lastFireTime = now;
          this.handleFire(player);
        }
      }
    }
  }
  
  private respawnPlayer(player: Player) {
    // Find safe spawn point (away from enemies)
    const spawnPoints = [
      { x: 32, z: 32 },
      { x: 10, z: 10 },
      { x: 54, z: 10 },
      { x: 10, z: 54 },
      { x: 54, z: 54 }
    ];
    
    // Find spawn point farthest from enemies
    let bestSpawn = spawnPoints[0];
    let bestDistance = 0;
    
    for (const spawn of spawnPoints) {
      let minMobDistance = Infinity;
      
      for (const mob of this.mobs.values()) {
        const dist = Math.sqrt(
          Math.pow(mob.x - spawn.x, 2) +
          Math.pow(mob.z - spawn.z, 2)
        );
        minMobDistance = Math.min(minMobDistance, dist);
      }
      
      if (minMobDistance > bestDistance) {
        bestDistance = minMobDistance;
        bestSpawn = spawn;
      }
    }
    
    // Reset player
    const spawnY = this.getTerrainHeight(bestSpawn.x, bestSpawn.z);

    player.hp = player.maxHp;
    player.x = bestSpawn.x;
    player.y = spawnY;
    player.z = bestSpawn.z;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.inputForward = 0;
    player.inputRight = 0;
    player.jumpQueued = false;
    player.jumpRequestedAt = 0;
    player.jumpHeld = false;
    player.isDead = false;
    const now = Date.now();
    player.invulnerable = true;
    player.invulnerableUntil = now + 5000;
    player.lastGroundTime = now;
    
    // Push nearby mobs away from the spawn bubble
    for (const mob of this.mobs.values()) {
      const dx = mob.x - player.x;
      const dz = mob.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 12) {
        const push = 12 - dist;
        let offsetX = 0;
        let offsetZ = 0;
        if (dist > 0.001) {
          const invDist = 1 / dist;
          offsetX = dx * invDist * push;
          offsetZ = dz * invDist * push;
        } else {
          offsetX = (Math.random() - 0.5) * push;
          offsetZ = (Math.random() - 0.5) * push;
        }
        mob.x = Math.max(0, Math.min(WORLD_SIZE, mob.x + offsetX));
        mob.z = Math.max(0, Math.min(WORLD_SIZE, mob.z + offsetZ));
        mob.y = this.getTerrainHeight(mob.x, mob.z);
        mob.vx = 0;
        mob.vz = 0;
      }
    }
    
    // Broadcast respawn event
    this.broadcast({
      type: "event",
      event: "playerRespawn",
      playerId: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      hp: player.hp,
      invulnerable: true,
      lives: player.lives
    });
  }

  private handleFire(player: Player) {
    if (!player.equipped) return;

    // ADS and movement influence spread
    const baseSpread = (1 - player.equipped.accuracy) * 0.1;
    const adsScale = player.ads ? 0.4 : 1.0;
    const moveSpeed = Math.hypot(player.vx, player.vz);
    const moveScale = 1 + Math.min(0.5, (moveSpeed / MOVE.maxSpeed) * 0.5);
    const spread = baseSpread * adsScale * moveScale;

    const aimX = player.aimX + (Math.random() - 0.5) * spread;
    const aimY = player.aimY + (Math.random() - 0.5) * spread;
    const aimZ = player.aimZ + (Math.random() - 0.5) * spread;

    const aimLength = Math.sqrt(aimX * aimX + aimY * aimY + aimZ * aimZ);
    if (aimLength < 1e-5) {
      return;
    }
    const dirX = aimX / aimLength;
    const dirY = aimY / aimLength;
    const dirZ = aimZ / aimLength;

    let muzzleOffsetX = 0;
    let muzzleOffsetZ = 0;
    const planarLen = Math.hypot(dirX, dirZ);
    if (planarLen > 1e-5) {
      const fX = dirX / planarLen;
      const fZ = dirZ / planarLen;
      const rX = fZ;
      const rZ = -fX;
      const muzzleForward = 0.6;
      const muzzleRight = 0.25;
      muzzleOffsetX = fX * muzzleForward + rX * muzzleRight;
      muzzleOffsetZ = fZ * muzzleForward + rZ * muzzleRight;
    }

    const originX = player.x + muzzleOffsetX;
    const originY = player.y + PLAYER_EYE_HEIGHT;
    const originZ = player.z + muzzleOffsetZ;

    let closestHit: { mob: Mob, distance: number, rayOff: number } | null = null;

    for (const mob of this.mobs.values()) {
      const toMobX = mob.x - originX;
      const toMobY = mob.y - originY;
      const toMobZ = mob.z - originZ;
      const distance = Math.sqrt(toMobX * toMobX + toMobY * toMobY + toMobZ * toMobZ);
      if (distance > player.equipped.range) continue;

      const dot = toMobX * dirX + toMobY * dirY + toMobZ * dirZ;
      if (dot < 0) continue;

      const closestPointX = originX + dirX * dot;
      const closestPointY = originY + dirY * dot;
      const closestPointZ = originZ + dirZ * dot;

      const rayDist = Math.hypot(mob.x - closestPointX, mob.y - closestPointY, mob.z - closestPointZ);

      const hitboxRadius = ENEMY_TYPES[mob.type]?.hitRadius ?? WORLD_SCALE.MOB_WIDTH;

      if (rayDist <= hitboxRadius) {
        if (!closestHit || distance < closestHit.distance) {
          closestHit = { mob, distance, rayOff: rayDist };
        }
      }
    }

    let closestPlayerHit: { player: Player, distance: number, hitX: number, hitY: number, hitZ: number, rayOff: number } | null = null;
    for (const target of this.players.values()) {
      if (target.id === player.id) continue;
      if (target.isDead) continue;
      if (target.invulnerable) continue;

      const targetCenterX = target.x;
      const targetCenterY = target.y + 0.9;
      const targetCenterZ = target.z;

      const toPlayerX = targetCenterX - originX;
      const toPlayerY = targetCenterY - originY;
      const toPlayerZ = targetCenterZ - originZ;
      const distance = Math.sqrt(toPlayerX * toPlayerX + toPlayerY * toPlayerY + toPlayerZ * toPlayerZ);
      if (distance > player.equipped.range) continue;

      const dot = toPlayerX * dirX + toPlayerY * dirY + toPlayerZ * dirZ;
      if (dot < 0) continue;

      const closestX = originX + dirX * dot;
      const closestY = originY + dirY * dot;
      const closestZ = originZ + dirZ * dot;

      const offX = targetCenterX - closestX;
      const offY = targetCenterY - closestY;
      const offZ = targetCenterZ - closestZ;
      const rayDistance = Math.sqrt(offX * offX + offY * offY + offZ * offZ);
      const hitboxRadius = WORLD_SCALE.PLAYER_WIDTH * 0.9;
      if (rayDistance <= hitboxRadius) {
        if (!closestPlayerHit || distance < closestPlayerHit.distance) {
          closestPlayerHit = {
            player: target,
            distance,
            hitX: closestX,
            hitY: closestY,
            hitZ: closestZ,
            rayOff: rayDistance
          };
        }
      }
    }

    const basePerShot = player.equipped.dps / player.equipped.fireRate;

    // Helper: precision crit if ray offset is very small or long-range tight shot while ADS
    const computeCrit = (distance: number, rayOff: number, baseRadius: number) => {
      const tight = rayOff <= baseRadius * 0.45;
      const longTight = player.ads && distance > 18 && rayOff <= baseRadius * 0.6;
      return tight || longTight;
    };

    let hitSomething = false;

    if (closestPlayerHit && (!closestHit || closestPlayerHit.distance <= closestHit.distance)) {
      const targetPlayer = closestPlayerHit.player;
      const falloff = Math.max(0.5, 1 - (closestPlayerHit.distance / player.equipped.range) * 0.5);
      const isCrit = computeCrit(closestPlayerHit.distance, closestPlayerHit.rayOff, 0.6);
      const critMul = isCrit ? 2.2 : 1.0;
      const damage = Math.floor(basePerShot * falloff * critMul * (0.9 + Math.random() * 0.2));

      if (!targetPlayer.invulnerable && !targetPlayer.isDead) {
        targetPlayer.hp = Math.max(0, targetPlayer.hp - damage);

        this.broadcast({
          type: "event",
          event: "hit",
          sourceId: player.id,
          targetId: targetPlayer.id,
          damage,
          crit: isCrit,
          x: closestPlayerHit.hitX,
          y: closestPlayerHit.hitY,
          z: closestPlayerHit.hitZ,
          targetType: 'player'
        });

        this.broadcast({
          type: "event",
          event: "damage",
          targetId: targetPlayer.id,
          damage,
          sourceId: player.id
        });

        if (targetPlayer.hp <= 0) {
          this.broadcast({
            type: "event",
            event: "kill",
            playerId: player.id,
            victimId: targetPlayer.id
          });
        }
      }

      hitSomething = true;
    } else if (closestHit) {
      const { mob, distance, rayOff } = closestHit;
      const falloff = Math.max(0.5, 1 - (distance / player.equipped.range) * 0.5);
      const baseRadius = ENEMY_TYPES[mob.type]?.hitRadius ?? WORLD_SCALE.MOB_WIDTH;
      const isCrit = computeCrit(distance, rayOff, baseRadius);
      const critMul = isCrit ? 2.0 : 1.0;
      const damage = Math.floor(basePerShot * falloff * critMul * (0.9 + Math.random() * 0.2));

      mob.hp = Math.max(0, mob.hp - damage);

      this.broadcast({
        type: "event",
        event: "hit",
        sourceId: player.id,
        targetId: mob.id,
        damage,
        crit: isCrit,
        x: mob.x,
        y: mob.y,
        z: mob.z
      });

      if (mob.hp <= 0) {
        this.broadcast({
          type: "event",
          event: "kill",
          playerId: player.id,
          mobId: mob.id
        });
      }

      hitSomething = true;
    }

    this.broadcast({
      type: "event",
      event: "shot",
      playerId: player.id,
      origin: [originX, originY, originZ],
      direction: [dirX, dirY, dirZ],
      hit: hitSomething
    });
  }

  private startTick() {
    if (!this.gameLoop) {
      this.gameLoop = new GameLoop(
        (deltaMs) => this.stepSimulation(deltaMs),
        () => {},
        this.updatesPerSecond,
        100
      );
      this.gameLoop.reset(Date.now());
    }

    if (this.tickTimer) {
      return;
    }

    this.tickTimer = setInterval(() => {
      this.gameLoop?.tick(Date.now());
    }, this.tickMs);
  }

  private stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    if (this.sockets.size === 0) {
      this.gameLoop = null;
    }
  }

  private stepSimulation(deltaMs: number) {
    this.tickCounter++;

    const difficultyConfig = this.getDifficultyConfig();
    if (this.tickCounter % difficultyConfig.spawnInterval === 0 && this.mobs.size < difficultyConfig.maxMobs) {
      this.spawnMob();
    }

    const dtSeconds = Math.max(0.001, deltaMs / 1000);
    this.updatePlayers(dtSeconds);
    this.updateMobs(dtSeconds);

    this.broadcastState();
  }

  private broadcastState() {
    const snapshot = {
      type: "snapshot",
      t: Date.now(),
      tick: this.tickCounter,
      difficulty: this.difficulty,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        z: p.z,
        hp: p.hp,
        maxHp: p.maxHp,
        equipped: p.equipped,
        lives: p.lives,
        isSpectator: p.isSpectator,
        spectatorUntil: p.spectatorUntil
      })),
      mobs: Array.from(this.mobs.values()).map(m => ({
        id: m.id,
        type: m.type,
        x: m.x,
        y: m.y,
        z: m.z,
        hp: m.hp,
        maxHp: m.maxHp
      })),
      loot: Array.from(this.loot.values())
    };

    this.broadcast(snapshot);
  }

  private broadcast(message: unknown) {
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (error) {
      console.error('Failed to serialize broadcast message', error, message);
      return;
    }

    for (const socket of this.sockets.values()) {
      try {
        socket.send(payload);
      } catch (e) {
        console.error("Error broadcasting:", e);
      }
    }
  }
}

type Player = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  maxHp: number;
  equipped: Gun | null;
  inventory: Gun[];
  firing: boolean;
  aimX: number;
  aimY: number;
  aimZ: number;
  lastFireTime: number;
  t: number;
  inputForward: number;
  inputRight: number;
  jumpQueued: boolean;
  jumpHeld: boolean;
  jumpRequestedAt: number;
  lastGroundTime: number;
  lives: number;
  isSpectator: boolean;
  spectatorUntil: number;
  isDead?: boolean;
  invulnerable?: boolean;
  invulnerableUntil?: number;
  ads?: boolean;             // NEW: aim-down-sights state
  lastDamageAt?: number;     // NEW: short hit cooldown timestamp
  lastSpectatorAck?: number;
};

type Mob = {
  id: string;
  type: EnemyTypeId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  maxHp: number;
  target: string | null;
  lastAttackTime: number;
  state?: 'idle' | 'patrol' | 'alert' | 'attack' | 'retreat';
  patrolTarget?: { x: number; z: number };
};

type LootDrop = {
  id: string;
  x: number;
  y: number;
  z: number;
  item: Gun;
};
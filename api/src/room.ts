import { Env } from './index';
import { rollGun, Gun } from './loot';
import { createTerrainHeightMap } from './terrain';

const MOVE = {
  maxSpeed: 6,
  accel: 28,
  friction: 10,
  airControl: 0.3,
  sprintMultiplier: 1.5
};

const PHYSICS = {
  gravity: 25,
  jumpPower: 10,
  terminalVelocity: 50,
  airResistance: 0.02
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
  mobTypes: Mob['type'][];
}> = {
  easy: {
    maxMobs: 2,
    spawnInterval: 180,
    damageMultiplier: 0.15,
    speedMultiplier: 0.5,
    rangeMultiplier: 0.4,
    mobTypes: ['charger', 'swarm']
  },
  normal: {
    maxMobs: 10,
    spawnInterval: 100,
    damageMultiplier: 1,
    speedMultiplier: 1,
    rangeMultiplier: 1,
    mobTypes: ['shooter', 'charger', 'jumper', 'sniper', 'tank', 'swarm']
  },
  hard: {
    maxMobs: 14,
    spawnInterval: 80,
    damageMultiplier: 1.5,
    speedMultiplier: 1.1,
    rangeMultiplier: 1.2,
    mobTypes: ['shooter', 'charger', 'jumper', 'sniper', 'tank', 'swarm']
  }
};

export class Room {
  private state: DurableObjectState;
  private env: Env;
  private sockets = new Map<string, WebSocket>();
  private players = new Map<string, Player>();
  private mobs = new Map<string, Mob>();
  private loot = new Map<string, LootDrop>();
  private tickTimer: any | null = null;
  private tickMs: number;
  private tickCounter = 0;
  private roomSeed: string;
  private terrain = createTerrainHeightMap(WORLD_SIZE, WORLD_SIZE, 1337);
  private lastTickTime = Date.now();
  private difficulty: Difficulty = 'normal';

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.tickMs = Math.max(10, Math.floor(1000 / Number(env.TICK_HZ || 20)));
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

  private handleDifficulty(_playerId: string, level: any) {
    if (typeof level !== 'string') return;
    if (level === 'easy' || level === 'normal' || level === 'hard') {
      this.setDifficulty(level);
    }
  }

  private async handleAnalytics(data: any) {
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

  private applyDamage(player: Player, baseDamage: number, sourceId: string) {
    if (player.invulnerable) return false;
    const scaled = Math.max(1, Math.round(baseDamage * this.getDifficultyConfig().damageMultiplier));
    player.hp = Math.max(0, player.hp - scaled);
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
        spectatorUntil: 0
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
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "input") this.applyInput(playerId, msg);
        else if (msg.type === "pickup") this.handlePickup(playerId, msg.lootId);
        else if (msg.type === "equip") this.handleEquip(playerId, msg.itemId);
        else if (msg.type === "setDifficulty") this.handleDifficulty(playerId, msg.level);
        else if (msg.type === "analytics") this.handleAnalytics(msg.data);
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

  private applyInput(id: string, msg: any) {
    const p = this.players.get(id);
    if (!p) return;

    const move = Array.isArray(msg.move) ? msg.move : [0, 0, 0];
    const rawRight = typeof move[0] === 'number' ? move[0] : 0;
    const rawJump = typeof move[1] === 'number' ? move[1] : 0;
    const rawBack = typeof move[2] === 'number' ? move[2] : 0;

    p.inputRight = Math.max(-1, Math.min(1, rawRight));
    p.inputForward = Math.max(-1, Math.min(1, -rawBack));

    if (p.isSpectator) {
      if (msg.aim) {
        p.aimX = msg.aim[0];
        p.aimY = msg.aim[1];
        p.aimZ = msg.aim[2];
      }
      return;
    }

    const jumpPressed = rawJump > 0.5;
    if (jumpPressed && !p.jumpHeld) {
      p.jumpQueued = true;
      p.jumpRequestedAt = Date.now();
    }
    if (!jumpPressed) {
      p.jumpHeld = false;
    } else {
      p.jumpHeld = true;
    }

    if (msg.aim) {
      p.aimX = msg.aim[0];
      p.aimY = msg.aim[1];
      p.aimZ = msg.aim[2];
    }

    p.firing = !!msg.firing;
    p.t = msg.t || Date.now();
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

    const id = `mob_${this.tickCounter}_${Math.random().toString(36).substring(7)}`;
    let angle = Math.random() * Math.PI * 2;
    let dist = 20 + Math.random() * 20;
    
    // Weighted random mob type selection
    const availableTypes = difficultyConfig.mobTypes.length > 0
      ? difficultyConfig.mobTypes
      : ['shooter', 'charger', 'jumper', 'sniper', 'tank', 'swarm'];

    // Weighted random mob type selection
    const baseTypes: Array<Mob['type']> = ['shooter', 'charger', 'jumper', 'sniper', 'tank', 'swarm'];
    const weights = [30, 25, 20, 10, 5, 10]; // Spawn weights

    const filteredEntries = baseTypes
      .map((type, idx) => ({ type, weight: weights[idx] }))
      .filter(entry => availableTypes.includes(entry.type));

    const totalWeight = filteredEntries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    let random = Math.random() * totalWeight;
    let type: Mob['type'] = filteredEntries[0]?.type ?? 'charger';

    for (const entry of filteredEntries) {
      random -= entry.weight;
      if (random <= 0) {
        type = entry.type;
        break;
      }
    }
    
    let hp = 30;
    let maxHp = 30;
    
    switch(type) {
      case 'tank': hp = maxHp = 150; break;
      case 'charger': hp = maxHp = 50; break;
      case 'jumper': hp = maxHp = 40; break;
      case 'sniper': hp = maxHp = 25; break;
      case 'swarm': hp = maxHp = 15; break;
      case 'shooter': hp = maxHp = 30; break;
    }

    let spawnX = 32 + Math.cos(angle) * dist;
    let spawnZ = 32 + Math.sin(angle) * dist;

    // Keep mobs from spawning right on top of players
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
      patrolTarget: { x: Math.random() * 64, z: Math.random() * 64 },
      jumpCooldown: 0
    });
  }

  private updateMobs(dt: number) {
    const now = Date.now();
    const config = this.getDifficultyConfig();
    const speedScale = config.speedMultiplier;

    for (const mob of this.mobs.values()) {
      // Find nearest player
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

      mob.target = nearestPlayer?.id || null;

      // Update AI state
      const baseAlert = mob.type === 'sniper' ? 40 : 25;
      const baseAttack = mob.type === 'sniper' ? 35 : mob.type === 'tank' ? 8 : 15;
      const alertRange = baseAlert * config.rangeMultiplier;
      const attackRange = baseAttack * config.rangeMultiplier;
      
    if (nearestPlayer && nearestDist < alertRange) {
        mob.state = nearestDist < attackRange ? 'attack' : 'alert';
        
        const dx = nearestPlayer.x - mob.x;
        const dz = nearestPlayer.z - mob.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Type-specific behavior
        switch (mob.type) {
          case 'charger':
            // Rush towards player
            mob.vx = (dx / dist) * 0.15 * speedScale;
            mob.vz = (dz / dist) * 0.15 * speedScale;
            if (dist < 2 && now - mob.lastAttackTime > 500) {
              if (this.applyDamage(nearestPlayer, 15, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
            
          case 'jumper':
            // Jump attack
            const groundHere = this.getTerrainHeight(mob.x, mob.z);
            const onGround = Math.abs(mob.y - groundHere) < 0.05;
            mob.jumpCooldown = (mob.jumpCooldown ?? 0) - dt;
            if (mob.jumpCooldown <= 0 && dist < 15 && onGround) {
              mob.vx = (dx / dist) * 0.3 * speedScale;
              mob.vy = 0.5;
              mob.vz = (dz / dist) * 0.3 * speedScale;
              mob.jumpCooldown = 2;
            }
            if (dist < 3 && now - mob.lastAttackTime > 1000) {
              if (this.applyDamage(nearestPlayer, 20, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
            
          case 'sniper':
            // Keep distance
            if (dist < 25) {
              mob.vx = -(dx / dist) * 0.05 * speedScale;
              mob.vz = -(dz / dist) * 0.05 * speedScale;
            } else if (dist > 35) {
              mob.vx = (dx / dist) * 0.03 * speedScale;
              mob.vz = (dz / dist) * 0.03 * speedScale;
            } else {
              mob.vx = 0;
              mob.vz = 0;
            }
            if (dist < 40 && now - mob.lastAttackTime > 3000) {
              if (this.applyDamage(nearestPlayer, 35, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
            
          case 'tank':
            // Slow approach
            mob.vx = (dx / dist) * 0.04 * speedScale;
            mob.vz = (dz / dist) * 0.04 * speedScale;
            if (dist < 5 && now - mob.lastAttackTime > 2000) {
              // Area damage
              for (const player of this.players.values()) {
                const pdx = player.x - mob.x;
                const pdz = player.z - mob.z;
                const pdist = Math.sqrt(pdx * pdx + pdz * pdz);
                if (pdist < 8) {
                  const damage = Math.max(1, Math.floor(25 - pdist * 3));
                  this.applyDamage(player, damage, mob.id);
                }
              }
              mob.lastAttackTime = now;
            }
            break;
            
          case 'swarm':
            // Fast swarming
            mob.vx = (dx / dist) * 0.12 * speedScale;
            mob.vz = (dz / dist) * 0.12 * speedScale;
            // Flocking behavior
            for (const other of this.mobs.values()) {
              if (other.id !== mob.id && other.type === 'swarm') {
                const sdx = other.x - mob.x;
                const sdz = other.z - mob.z;
                const sdist = Math.sqrt(sdx * sdx + sdz * sdz);
                if (sdist < 3) {
                  mob.vx -= (sdx / sdist) * 0.05 * speedScale;
                  mob.vz -= (sdz / sdist) * 0.05 * speedScale;
                } else if (sdist < 10) {
                  mob.vx += (sdx / sdist) * 0.02 * speedScale;
                  mob.vz += (sdz / sdist) * 0.02 * speedScale;
                }
              }
            }
            if (dist < 2 && now - mob.lastAttackTime > 500) {
              if (this.applyDamage(nearestPlayer, 5, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
            
          case 'shooter':
          default:
            // Keep distance and shoot
            const idealDist = 15;
            if (dist > idealDist) {
              mob.vx = (dx / dist) * 0.08 * speedScale;
              mob.vz = (dz / dist) * 0.08 * speedScale;
            } else if (dist < idealDist - 5) {
              mob.vx = -(dx / dist) * 0.08 * speedScale;
              mob.vz = -(dz / dist) * 0.08 * speedScale;
            }
            if (dist < 20 && now - mob.lastAttackTime > 1000) {
              if (this.applyDamage(nearestPlayer, 10, mob.id)) {
                mob.lastAttackTime = now;
              }
            }
            break;
        }
      } else {
        // Patrol behavior
        mob.state = 'patrol';
        if (mob.patrolTarget) {
          const dx = mob.patrolTarget.x - mob.x;
          const dz = mob.patrolTarget.z - mob.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          
          if (dist < 2) {
            mob.patrolTarget = { x: Math.random() * 64, z: Math.random() * 64 };
          } else {
            mob.vx = (dx / dist) * 0.05 * speedScale;
            mob.vz = (dz / dist) * 0.05 * speedScale;
          }
        } else if (Math.random() < 0.02) {
          mob.vx = (Math.random() - 0.5) * 0.05 * speedScale;
          mob.vz = (Math.random() - 0.5) * 0.05 * speedScale;
        }
      }

      // Apply physics at a nominal 60Hz base
      const stepScale = Math.max(0.001, dt / FIXED_TICK);
      const GRAVITY = 0.03;
      const TERMINAL_VEL = 2.0;
      
      // Apply gravity
      mob.vy -= GRAVITY * stepScale;
      if (mob.vy < -TERMINAL_VEL) {
        mob.vy = -TERMINAL_VEL;
      }
      
      // Integrate positions
      mob.x += mob.vx * stepScale;
      mob.y += mob.vy * stepScale;
      mob.z += mob.vz * stepScale;
      
      // Ground collision using terrain
      const ground = this.getTerrainHeight(mob.x, mob.z);
      if (mob.y <= ground) {
        mob.y = ground;
        if (mob.vy < 0) {
          mob.vy = 0;
        }
      }
      
      // Apply friction / drag
      const onGround = Math.abs(mob.y - ground) < 0.05;
      if (onGround) {
        mob.vx *= Math.pow(0.9, stepScale);
        mob.vz *= Math.pow(0.9, stepScale);
      } else {
        mob.vx *= Math.pow(0.98, stepScale);
        mob.vz *= Math.pow(0.98, stepScale);
      }

      // Keep mobs from occupying the exact player position
      for (const player of this.players.values()) {
        const dx = mob.x - player.x;
        const dz = mob.z - player.z;
        const horizontalDist = Math.sqrt(dx * dx + dz * dz);
        if (horizontalDist < 1.8) {
          const pushDist = 1.8 - horizontalDist;
          const inv = horizontalDist > 0.001 ? 1 / horizontalDist : 0;
          const offsetX = (horizontalDist > 0.001 ? dx * inv : (Math.random() - 0.5)) * pushDist;
          const offsetZ = (horizontalDist > 0.001 ? dz * inv : (Math.random() - 0.5)) * pushDist;
          mob.x = Math.max(0, Math.min(WORLD_SIZE, mob.x + offsetX));
          mob.z = Math.max(0, Math.min(WORLD_SIZE, mob.z + offsetZ));
          mob.y = this.getTerrainHeight(mob.x, mob.z);
        }
      }

      // Remove dead mobs
      if (mob.hp <= 0) {
        // Drop loot chance
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
      // Expire spawn protection without relying on timeouts
      if (player.invulnerable && player.invulnerableUntil && now >= player.invulnerableUntil) {
        player.invulnerable = false;
        player.invulnerableUntil = undefined;
      }

      // Handle death/respawn transitions
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

      // Expire buffered jump requests
      if (player.jumpQueued && now - player.jumpRequestedAt > JUMP.bufferMs) {
        player.jumpQueued = false;
      }

      // Determine movement basis from aim direction
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

      // Combine inputs into desired velocity
      let desiredX = rightX * player.inputRight + forwardX * player.inputForward;
      let desiredZ = rightZ * player.inputRight + forwardZ * player.inputForward;
      const desiredLen = Math.hypot(desiredX, desiredZ);
      if (desiredLen > 1) {
        desiredX /= desiredLen;
        desiredZ /= desiredLen;
      }

      const targetVx = desiredX * MOVE.maxSpeed;
      const targetVz = desiredZ * MOVE.maxSpeed;

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
        const frictionFactor = 1 / (1 + MOVE.friction * dt);
        player.vx *= frictionFactor;
        player.vz *= frictionFactor;
      }

      if (!onGround) {
        player.vx *= 1 - PHYSICS.airResistance * dt;
        player.vz *= 1 - PHYSICS.airResistance * dt;
      }

      // Jump buffer + coyote time
      const canJump = onGround || now - player.lastGroundTime < JUMP.coyoteMs;
      if (player.jumpQueued && canJump) {
        player.vy = PHYSICS.jumpPower;
        player.jumpQueued = false;
        player.jumpHeld = true;
      }

      // Gravity
      if (!onGround) {
        player.vy -= PHYSICS.gravity * dt;
        if (player.vy < -PHYSICS.terminalVelocity) {
          player.vy = -PHYSICS.terminalVelocity;
        }
      } else if (player.vy < 0) {
        player.vy = 0;
      }

      // Integrate position
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

      // Bounds and simple wall response
      if (player.x < 0 || player.x > WORLD_SIZE) {
        player.x = Math.max(0, Math.min(WORLD_SIZE, player.x));
        player.vx = 0;
      }
      if (player.z < 0 || player.z > WORLD_SIZE) {
        player.z = Math.max(0, Math.min(WORLD_SIZE, player.z));
        player.vz = 0;
      }

      // Handle firing cadence
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

    // Calculate spread based on weapon accuracy
    const spread = (1 - player.equipped.accuracy) * 0.1;
    const aimX = player.aimX + (Math.random() - 0.5) * spread;
    const aimY = player.aimY + (Math.random() - 0.5) * spread;
    const aimZ = player.aimZ + (Math.random() - 0.5) * spread;

    // Normalize aim direction
    const aimLength = Math.sqrt(aimX * aimX + aimY * aimY + aimZ * aimZ);
    if (aimLength < 1e-5) {
      return;
    }
    const dirX = aimX / aimLength;
    const dirY = aimY / aimLength;
    const dirZ = aimZ / aimLength;

    // Compute muzzle origin offset once so ray + visuals align
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

    // Check all mobs for hits using proper raycasting
    let closestHit: { mob: Mob, distance: number } | null = null;

    for (const mob of this.mobs.values()) {
      // Vector from muzzle to mob center
      const toMobX = mob.x - originX;
      const toMobY = mob.y - originY;
      const toMobZ = mob.z - originZ;

      // Distance to mob
      const distance = Math.sqrt(toMobX * toMobX + toMobY * toMobY + toMobZ * toMobZ);

      // Check if within weapon range
      if (distance > player.equipped.range) continue;

      // Project mob position onto aim ray
      const dot = toMobX * dirX + toMobY * dirY + toMobZ * dirZ;

      // If behind player, skip
      if (dot < 0) continue;

      // Find closest point on ray to mob center
      const closestPointX = originX + dirX * dot;
      const closestPointY = originY + dirY * dot;
      const closestPointZ = originZ + dirZ * dot;

      // Distance from ray to mob center (for hit detection)
      const rayDistX = mob.x - closestPointX;
      const rayDistY = mob.y - closestPointY;
      const rayDistZ = mob.z - closestPointZ;
      const rayDist = Math.sqrt(rayDistX * rayDistX + rayDistY * rayDistY + rayDistZ * rayDistZ);

      // Check if ray passes close enough to mob (increased hitbox for better hit detection)
      let hitboxRadius = 0.8; // Default hitbox
      switch(mob.type) {
        case 'tank': hitboxRadius = 1.2; break;
        case 'charger': hitboxRadius = 0.9; break;
        case 'jumper': hitboxRadius = 0.8; break;
        case 'swarm': hitboxRadius = 0.6; break;
        case 'sniper': hitboxRadius = 0.7; break;
        case 'shooter': hitboxRadius = 0.8; break;
      }
      
      if (rayDist <= hitboxRadius) {
        if (!closestHit || distance < closestHit.distance) {
          closestHit = { mob, distance };
        }
      }
    }

    // Check other players for hits
    let closestPlayerHit: { player: Player, distance: number, hitX: number, hitY: number, hitZ: number } | null = null;
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
      const hitboxRadius = 0.6;
      if (rayDistance <= hitboxRadius) {
        if (!closestPlayerHit || distance < closestPlayerHit.distance) {
          closestPlayerHit = {
            player: target,
            distance,
            hitX: closestX,
            hitY: closestY,
            hitZ: closestZ
          };
        }
      }
    }

    let hitSomething = false;

    if (closestPlayerHit && (!closestHit || closestPlayerHit.distance <= closestHit.distance)) {
      const targetPlayer = closestPlayerHit.player;
      const baseDamage = player.equipped.dps / player.equipped.fireRate;
      const falloff = Math.max(0.5, 1 - (closestPlayerHit.distance / player.equipped.range) * 0.5);
      const damage = Math.floor(baseDamage * falloff * (0.9 + Math.random() * 0.2));
      const isCrit = Math.random() < 0.15;
      const finalDamage = isCrit ? damage * 2 : damage;

      if (!targetPlayer.invulnerable && !targetPlayer.isDead) {
        targetPlayer.hp = Math.max(0, targetPlayer.hp - finalDamage);

        this.broadcast({
          type: "event",
          event: "hit",
          sourceId: player.id,
          targetId: targetPlayer.id,
          damage: finalDamage,
          crit: isCrit,
          x: targetPlayer.x,
          y: targetPlayer.y + 1,
          z: targetPlayer.z,
          targetType: 'player'
        });

        this.broadcast({
          type: "event",
          event: "damage",
          targetId: targetPlayer.id,
          damage: finalDamage,
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
      const { mob, distance } = closestHit;

      const baseDamage = player.equipped.dps / player.equipped.fireRate;
      const falloff = Math.max(0.5, 1 - (distance / player.equipped.range) * 0.5);
      const damage = Math.floor(baseDamage * falloff * (0.9 + Math.random() * 0.2));
      const isCrit = Math.random() < 0.15;
      const finalDamage = isCrit ? damage * 2 : damage;

      mob.hp = Math.max(0, mob.hp - finalDamage);

      this.broadcast({
        type: "event",
        event: "hit",
        sourceId: player.id,
        targetId: mob.id,
        damage: finalDamage,
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

    // Broadcast shot event for visual effects
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
    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
  }

  private stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick() {
    this.tickCounter++;

    // Spawn mobs periodically
    const difficultyConfig = this.getDifficultyConfig();
    if (this.tickCounter % difficultyConfig.spawnInterval === 0 && this.mobs.size < difficultyConfig.maxMobs) {
      this.spawnMob();
    }

    const now = Date.now();
    const dtMs = Math.min(200, now - this.lastTickTime);
    this.lastTickTime = now;
    const dtSeconds = Math.max(0.001, dtMs / 1000);
    const subSteps = Math.max(1, Math.round(dtSeconds / FIXED_TICK));
    const stepDt = dtSeconds / subSteps;

    for (let i = 0; i < subSteps; i++) {
      this.updatePlayers(stepDt);
      this.updateMobs(stepDt);
    }

    // Send snapshot to all clients
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

  private broadcast(message: any) {
    const str = JSON.stringify(message);
    for (const socket of this.sockets.values()) {
      try {
        socket.send(str);
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
};

type Mob = {
  id: string;
  type: 'charger' | 'shooter' | 'jumper' | 'sniper' | 'tank' | 'swarm';
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
  jumpCooldown?: number;
};

type LootDrop = {
  id: string;
  x: number;
  y: number;
  z: number;
  item: Gun;
};
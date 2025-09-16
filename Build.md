Love the idea: **a lightweight, cel‑shaded looter shooter in a blocky (Minecraft‑style) world**—but Cloudflare‑native so it’s snappy worldwide. Below is a complete, opinionated plan + starter scaffolding you can paste into a repo today.

---

## What we’re building (MVP scope)

**Working title:** *Borderboxes*
**Play pattern:** 2–6 players drop into a small voxel arena, fight wave‑based mobs, crack chests, and extract.
**“Borderlands‑ish” flavor (simplified):**

* Procedural guns (3 archetypes: pistol/SMG/rifle) with random stats + rarity colors.
* Big numbers, crits, and satisfying “pop” when loot drops.
* Cel‑shaded look (flat colors + outlines), but **no reused IP**; all original art/names.

---

## Cloudflare‑native stack (fast + cheap)

* **Frontend:** TypeScript + **Three.js** (simple + fast for a voxel look) + Vite.
* **Hosting:** **Cloudflare Pages** for static assets.
* **Realtime server:** **Cloudflare Workers + Durable Objects (DOs)**. One DO = one room/instance, authoritative state + WebSocket hub.
* **Storage:**

  * **D1** (SQLite‑like) for accounts, runs, leaderboards.
  * **R2** for bigger static assets (music, SFX, textures), optional at first.
* **Perf tricks:** binary WebSocket messages (migrate from JSON after MVP), client prediction + server reconciliation, instanced meshes for voxels, simple grid/AABB physics in the DO (no heavy physics engine).

---

## High‑level architecture

1. **Pages** serves `index.html` + JS bundle.
2. Client opens `wss://api.example.com/rooms/:id` → **Worker** routes to the **Room Durable Object** for that `:id`.
3. The DO runs a 20–30 Hz tick: processes inputs, updates enemies, rolls loot, broadcasts deltas.
4. Each run’s summary is written to **D1**; assets are pulled from **Pages** (or **R2** later).

---

## Minimal data model (D1)

```sql
-- d1/schema.sql
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  seed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  run_id TEXT,
  player_id TEXT,
  kills INTEGER DEFAULT 0,
  damage INTEGER DEFAULT 0,
  loot_value INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, player_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_id TEXT,
  archetype TEXT,     -- pistol | smg | rifle
  rarity TEXT,        -- common | rare | epic | legendary
  dps REAL,
  mag INTEGER,
  reload_ms INTEGER,
  seed TEXT           -- for deterministic reroll/replication
);
```

---

## Message protocol (start with JSON, migrate to binary later)

* **C→S** `join`: `{type:'join', playerId, name}`
* **C→S** `input`: `{type:'input', t, move:[x,y,z], aim:[x,y,z], firing:boolean}`
* **S→C** `snapshot`: `{type:'snapshot', t, players:{id:{pos,rot,hp}}, mobs:[...], loot:[...]}`
* **S→C** `event`: kills, loot drops, chest opened, etc.

Keep messages **tiny** (sub‑1 KB typical), and send **deltas** after the first snapshot.

---

## Procedural loot (simple, deterministic)

Use a seeded RNG per drop so clients and server can reproduce stats if needed.

```ts
// server/loot.ts
export type Gun = {
  archetype: 'pistol'|'smg'|'rifle',
  rarity: 'common'|'rare'|'epic'|'legendary',
  dps: number, mag: number, reloadMs: number, seed: string
};

export function rollGun(seed: string): Gun {
  const rnd = mulberry32(hash(seed));
  const archetypes: Gun['archetype'][] = ['pistol','smg','rifle'];
  const rarityTable = ['common','common','rare','rare','epic','legendary'] as const;

  const archetype = archetypes[Math.floor(rnd()*archetypes.length)];
  const rarity = rarityTable[Math.floor(rnd()*rarityTable.length)];
  // base stats by archetype (very rough)
  const base = { pistol:{dps:80,mag:12,reload:1100},
                 smg:{dps:140,mag:30,reload:1500},
                 rifle:{dps:200,mag:24,reload:1800} }[archetype];

  const mult = { common:1, rare:1.15, epic:1.35, legendary:1.6 }[rarity];
  const jitter = (n:number, p:number)=> n*(1 + (rnd()*2-1)*p);
  return {
    archetype, rarity, seed,
    dps: Math.round(jitter(base.dps*mult, 0.12)),
    mag: Math.max(6, Math.round(jitter(base.mag*mult, 0.15))),
    reloadMs: Math.round(jitter(base.reload, 0.12))
  };
}

function hash(s:string){ let h=2166136261>>>0; for (let i=0;i<s.length;i++) { h^=s.charCodeAt(i); h=Math.imul(h,16777619)} return h>>>0 }
function mulberry32(a:number){ return function(){ let t = a += 0x6D2B79F5; t = Math.imul(t ^ t>>>15, t | 1); t ^= t + Math.imul(t ^ t>>>7, t | 61); return ((t ^ t>>>14) >>> 0) / 4294967296; } }
```

---

## Voxel world (super‑simple)

Start with **one chunk** (e.g., 64×64×16). Render with a **THREE.InstancedMesh** of cubes (fast) and add a toon outline pass for the Borderlands vibe.

```ts
// client/world.ts
import * as THREE from 'three';

export function makeChunk(scene: THREE.Scene, size=[64,64,16], seed=1337) {
  const [W,H,D] = size; const rng = mulberry32(seed);
  const geometry = new THREE.BoxGeometry(1,1,1);
  const material  = new THREE.MeshToonMaterial();
  const maxBlocks = W*H*D; // upper bound for allocation; we’ll fill only ground
  const inst = new THREE.InstancedMesh(geometry, material, maxBlocks);
  let i=0;
  const height = (x:number,z:number)=> 3 + Math.floor(2*Math.sin(x*0.15)+2*Math.cos(z*0.1 + x*0.05));
  for (let x=0;x<W;x++) for (let z=0;z<H;z++) {
    const yTop = height(x,z);
    for (let y=0;y<yTop;y++) {
      const m = new THREE.Matrix4().makeTranslation(x, y, z);
      inst.setMatrixAt(i++, m);
    }
  }
  inst.count = i;
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

function mulberry32(a:number){ return function(){ let t = a += 0x6D2B79F5; t = Math.imul(t ^ t>>>15, t | 1); t ^= t + Math.imul(t ^ t>>>7, t | 61); return ((t ^ t>>>14) >>> 0) / 4294967296; } }
```

---

## Durable Object room (authoritative realtime)

**Files/folders**

```
/api
  /src
    index.ts        # Worker entry (routes to room DO)
    room.ts         # Durable Object (state + WebSocket)
    loot.ts         # (from above)
  wrangler.toml
  package.json
/frontend
  index.html
  src/main.ts
  src/world.ts      # (from above)
  vite.config.ts
  package.json
```

**`/api/wrangler.toml`**

```toml
name = "borderboxes-api"
main = "src/index.ts"
compatibility_date = "2025-09-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]

[[d1_databases]]
binding = "DB"
database_name = "borderboxes-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # fill after `wrangler d1 create`

# For local dev
[vars]
TICK_HZ = "20"
```

**`/api/src/index.ts`**

```ts
export interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  TICK_HZ: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/rooms/")) {
      // route by room id to DO
      const id = url.pathname.split("/")[2] || "lobby";
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      return stub.fetch(req);
    }
    return new Response("ok", { status: 200 });
  }
}
```

**`/api/src/room.ts`**

```ts
export class Room {
  private state: DurableObjectState;
  private env: Env;
  private sockets = new Map<string, WebSocket>();
  private players = new Map<string, Player>(); // authoritative
  private tickTimer: any | null = null;
  private tickMs: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state; this.env = env;
    this.tickMs = Math.max(10, Math.floor(1000 / Number(env.TICK_HZ || 20)));
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws") && req.headers.get("Upgrade") === "websocket") {
      const pid = url.searchParams.get("pid") ?? crypto.randomUUID();
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      await this.handleSocket(server, pid);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("room ok");
  }

  private async handleSocket(ws: WebSocket, playerId: string) {
    ws.accept();
    this.sockets.set(playerId, ws);
    if (!this.players.has(playerId)) {
      this.players.set(playerId, { id: playerId, x: 4, y: 6, z: 4, hp: 100, t: Date.now() });
    }
    ws.send(JSON.stringify({type:"hello", id: playerId, now: Date.now()}));

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "input") this.applyInput(playerId, msg);
      } catch {}
    });

    ws.addEventListener("close", () => {
      this.sockets.delete(playerId);
      // Keep player state for a minute; if room empties, stop ticking
      if (this.sockets.size === 0) this.stopTick();
    });

    if (!this.tickTimer) this.startTick();
  }

  private applyInput(id: string, msg: any) {
    const p = this.players.get(id); if (!p) return;
    // super simple: move on x/z plane, clamp speed
    const [mx, , mz] = msg.move || [0,0,0];
    const speed = 0.12;
    p.x += Math.max(-1, Math.min(1, mx)) * speed;
    p.z += Math.max(-1, Math.min(1, mz)) * speed;
    p.t = msg.t || Date.now();
  }

  private startTick(){ this.tickTimer = setInterval(()=>this.tick(), this.tickMs); }
  private stopTick(){ if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; } }

  private tick() {
    // TODO: spawn mobs + simple AI here
    const snapshot = {
      type: "snapshot",
      t: Date.now(),
      players: [...this.players.values()].map(({id,x,y,z,hp})=>({id,x,y,z,hp}))
    };
    const str = JSON.stringify(snapshot);
    for (const s of this.sockets.values()) try { s.send(str); } catch {}
  }
}

type Player = { id: string, x: number, y: number, z: number, hp: number, t: number };
```

> ✱ Notes
> • This DO uses a lightweight loop (`setInterval`). For larger rooms, switch to the **DO Alarm** API or batched ticks.
> • Keep rooms small (≤8 players) for consistent latency and CPU limits. Spin up many rooms by ID.

---

## Worker routing (WebSocket URL)

Clients connect to:
`wss://<your-worker-domain>/rooms/<room-id>/ws?pid=<player-id>`

---

## Frontend starter (Three.js + toon look)

**`/frontend/index.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"><title>Borderboxes</title></head>
  <body><canvas id="c"></canvas><script type="module" src="/src/main.ts"></script></body>
</html>
```

**`/frontend/src/main.ts`**

```ts
import * as THREE from 'three';
import { makeChunk } from './world';

const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
const light = new THREE.DirectionalLight(); scene.add(light);
const amb = new THREE.AmbientLight(0xffffff, 0.6); scene.add(amb);

const me = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshToonMaterial());
scene.add(me);
makeChunk(scene, [64,64,16], 1337);

const players = new Map<string, THREE.Mesh>();
let ws: WebSocket; let pid = crypto.randomUUID();

function connect() {
  ws = new WebSocket(`${location.origin.replace('http','ws')}/rooms/lobby/ws?pid=${pid}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') console.log('connected as', msg.id);
    if (msg.type === 'snapshot') {
      for (const p of msg.players) {
        if (!players.has(p.id)) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshToonMaterial());
          scene.add(m); players.set(p.id, m);
        }
        const m = players.get(p.id)!; m.position.set(p.x, p.y, p.z);
        if (p.id === pid) me.position.copy(m.position);
      }
    }
  };
  ws.onclose = ()=> setTimeout(connect, 1000);
}
connect();

const keys = new Set<string>();
addEventListener('keydown', e=>keys.add(e.code));
addEventListener('keyup', e=>keys.delete(e.code));

function sendInput() {
  const move = [
    (keys.has('KeyD')?1:0) - (keys.has('KeyA')?1:0),
    0,
    (keys.has('KeyS')?1:0) - (keys.has('KeyW')?1:0)
  ];
  ws?.readyState===1 && ws.send(JSON.stringify({type:'input', t: Date.now(), move}));
}
setInterval(sendInput, 50);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w,h, false); camera.aspect = w/h; camera.updateProjectionMatrix();
  camera.position.set(32, 20, 32); camera.lookAt(me.position);
}
addEventListener('resize', resize); resize();

function frame(){
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
```

> ✱ Visual style: later add a Sobel edge post‑process (or Babylon’s outline renderer) for thick black outlines + flat colors to nail the Borderlands vibe.

---

## Deploy steps (one‑time)

1. **Init DB**

   * `wrangler d1 create borderboxes-db`
   * `wrangler d1 execute borderboxes-db --file d1/schema.sql`
2. **Publish API**
   In `/api`: `npm i -D typescript @cloudflare/workers-types` (plus your bundler) → `wrangler deploy`
3. **Publish Frontend**
   In `/frontend`: `npm create vite@latest` (or use the files above) → `npm run build` → push to a repo → connect to **Cloudflare Pages** (build command `npm run build`, output `dist`).
   For local dev, proxy `/rooms/*` to your Worker with Vite or run the Pages dev proxy.

---

## Performance & gameplay guidelines

* **Tick rate:** 20–30 Hz is enough for casual shooter feel at the edge.
* **Authoritative DO:** All hits/loot are server‑validated; clients only *predict* movement.
* **Bandwidth:** Use JSON for day‑1; move to **MessagePack** or a tiny binary schema once stable.
* **Chunking:** Keep arenas small (e.g., 64–96 tiles across). Use instanced cubes; avoid per‑cube draw calls.
* **Enemies:** Start with “charger” + “shooter” AI (seek/strafe). No pathfinding—simple steering on a grid.
* **Cheat resistance:** Never trust client damage or loot rolls; keep the seed and outcomes in the DO.
* **Scaling:** Each room is a DO. Room ID shards naturally spread load. Spin up many small rooms, not one big room.

---

## Roadmap (two short sprints)

**Sprint 1 (MVP):** movement, basic mob spawner, one chest type, procedural pistol only, scoreboard to D1, outlines pass.
**Sprint 2:** add SMG/Rifle, rarity FX, simple abilities (dash/grenade), match browser (list rooms), extract/summary screen.

---

If you want, I can **package the above into a ready‑to‑run starter** (folders, configs, and all files), but you can already copy these snippets into a repo and deploy.

Would you like me to expand the **AI tick (enemies + projectiles)** and **edge outlines** next, or wire up the **match browser + D1 leaderboard**?

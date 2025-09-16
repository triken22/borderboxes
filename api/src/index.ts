export interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  TICK_HZ: string;
  ADMIN_PASSWORD?: string;
}

function unauthorizedResponse(message = 'Unauthorized') {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Borderboxes Analytics"'
    }
  });
}

function requireAdmin(request: Request, env: Env): Response | null {
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    return new Response('Admin password not configured', { status: 500 });
  }

  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Basic ')) {
    return unauthorizedResponse();
  }

  try {
    const encoded = header.slice(6);
    const decoded = atob(encoded);
    const suppliedPassword = decoded.split(':')[1] ?? '';
    if (suppliedPassword !== password) {
      return unauthorizedResponse('Invalid credentials');
    }
  } catch (err) {
    console.error('Failed to decode Authorization header', err);
    return unauthorizedResponse();
  }

  return null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Enable CORS for development
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/admin') {
      const auth = requireAdmin(req, env);
      if (auth) return auth;

      const totals = await env.DB.prepare(
        `SELECT
            SUM(CASE WHEN event = 'session_start' THEN 1 ELSE 0 END) AS sessions,
            SUM(CASE WHEN event = 'kill' THEN 1 ELSE 0 END) AS kills,
            SUM(CASE WHEN event = 'loot_pickup' THEN 1 ELSE 0 END) AS loot_pickups,
            SUM(CASE WHEN event = 'weapon_equip' THEN 1 ELSE 0 END) AS equips,
            SUM(CASE WHEN event = 'damage_taken' THEN 1 ELSE 0 END) AS damage_events
         FROM analytics_events`
      ).first<Record<string, number>>();

      const difficultyStats = await env.DB.prepare(
        `SELECT
            COALESCE(json_extract(payload, '$.difficulty'), 'unknown') AS difficulty,
            COUNT(*) AS count
         FROM analytics_events
         WHERE event = 'session_start'
         GROUP BY difficulty
         ORDER BY count DESC`
      ).all();

      const lootStats = await env.DB.prepare(
        `SELECT
            COALESCE(json_extract(payload, '$.rarity'), 'unknown') AS rarity,
            COUNT(*) AS count
         FROM analytics_events
         WHERE event = 'loot_pickup'
         GROUP BY rarity
         ORDER BY count DESC`
      ).all();

      const damageTotals = await env.DB.prepare(
        `SELECT
            SUM(COALESCE(json_extract(payload, '$.amount'), 0)) AS total
         FROM analytics_events
         WHERE event = 'damage_taken'`
      ).first<{ total: number }>();

      const recent = await env.DB.prepare(
        `SELECT
            event,
            player_id,
            payload,
            datetime(created_at, 'unixepoch') AS occurred_at
         FROM analytics_events
         ORDER BY created_at DESC
         LIMIT 25`
      ).all();

      const totalsRow = totals ?? { sessions: 0, kills: 0, loot_pickups: 0, equips: 0, damage_events: 0 };
      const difficultyRows = difficultyStats.results ?? [];
      const lootRows = lootStats.results ?? [];
      const recentRows = recent.results ?? [];
      const totalDamage = damageTotals?.total ?? 0;

      const difficultySection = difficultyRows.map(row => `
        <tr>
          <td>${escapeHtml(row.difficulty)}</td>
          <td>${escapeHtml(row.count)}</td>
        </tr>
      `).join('');

      const lootSection = lootRows.map(row => `
        <tr>
          <td>${escapeHtml(row.rarity)}</td>
          <td>${escapeHtml(row.count)}</td>
        </tr>
      `).join('');

      const recentSection = recentRows.map(row => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload ?? '{}');
        } catch (err) {
          parsed = row.payload ?? {};
        }
        const payloadSummary = escapeHtml(JSON.stringify(parsed, null, 2));
        return `
          <tr>
            <td>${escapeHtml(row.occurred_at)}</td>
            <td>${escapeHtml(row.event)}</td>
            <td>${escapeHtml(row.player_id ?? '—')}</td>
            <td><pre>${payloadSummary}</pre></td>
          </tr>
        `;
      }).join('');

      const html = `<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Borderboxes Analytics</title>
            <style>
              body { font-family: Inter, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 40px; }
              h1 { margin-top: 0; }
              section { margin-bottom: 32px; }
              .card { background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 12px; padding: 20px; box-shadow: 0 18px 35px rgba(15, 23, 42, 0.4); }
              .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
              .stat { text-align: center; padding: 16px; border-radius: 10px; background: linear-gradient(145deg, rgba(59,130,246,0.2), rgba(37,99,235,0.1)); }
              .stat h2 { margin: 0; font-size: 2rem; }
              table { width: 100%; border-collapse: collapse; }
              th, td { text-align: left; padding: 10px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); vertical-align: top; }
              th { color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; }
              pre { margin: 0; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word; }
              .muted { color: #94a3b8; font-size: 0.85rem; }
            </style>
          </head>
          <body>
            <h1>Borderboxes Analytics Dashboard</h1>
            <section class="grid">
              <div class="stat">
                <h2>${escapeHtml(totalsRow.sessions)}</h2>
                <div class="muted">Sessions</div>
              </div>
              <div class="stat">
                <h2>${escapeHtml(totalsRow.kills)}</h2>
                <div class="muted">Kills Logged</div>
              </div>
              <div class="stat">
                <h2>${escapeHtml(totalsRow.loot_pickups)}</h2>
                <div class="muted">Loot Pickups</div>
              </div>
              <div class="stat">
                <h2>${escapeHtml(totalsRow.equips)}</h2>
                <div class="muted">Weapon Equips</div>
              </div>
              <div class="stat">
                <h2>${escapeHtml(totalDamage.toFixed(0))}</h2>
                <div class="muted">Damage Reported</div>
              </div>
            </section>

            <section class="card">
              <h2>Sessions by Difficulty</h2>
              <table>
                <thead>
                  <tr><th>Difficulty</th><th>Sessions</th></tr>
                </thead>
                <tbody>${difficultySection}</tbody>
              </table>
            </section>

            <section class="card">
              <h2>Loot Pickups by Rarity</h2>
              <table>
                <thead>
                  <tr><th>Rarity</th><th>Pickups</th></tr>
                </thead>
                <tbody>${lootSection}</tbody>
              </table>
            </section>

            <section class="card">
              <h2>Recent Events</h2>
              <table>
                <thead>
                  <tr><th>Time (UTC)</th><th>Event</th><th>Player</th><th>Details</th></tr>
                </thead>
                <tbody>${recentSection}</tbody>
              </table>
            </section>

            <p class="muted">Dashboard access is protected. Rotate the admin password regularly.</p>
          </body>
        </html>`;

      return new Response(html, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/html; charset=utf-8'
        }
      });
    }

    if (url.pathname === '/analytics' && req.method === 'POST') {
      try {
        const data = await req.json();
        const id = crypto.randomUUID();
        const event = typeof data?.event === 'string' ? data.event : 'unknown';
        const playerId = typeof data?.playerId === 'string' ? data.playerId : null;
        const payload = JSON.stringify(data ?? {});
        await env.DB.prepare(`
          INSERT INTO analytics_events (id, event, player_id, payload)
          VALUES (?, ?, ?, ?)
        `).bind(id, event, playerId, payload).run();
      } catch (err) {
        console.error('analytics insert failed', err);
        return new Response('invalid analytics payload', { status: 400, headers: corsHeaders });
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname.startsWith("/rooms/")) {
      // route by room id to DO
      const id = url.pathname.split("/")[2] || "lobby";
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      return stub.fetch(req);
    }

    return new Response("Borderboxes API", {
      status: 200,
      headers: corsHeaders
    });
  }
}

export { Room } from './room';

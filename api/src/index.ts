export interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TICK_HZ: string;
  ADMIN_PASSWORD?: string;
  SLACK_WEBHOOK?: string;
}

const ALLOWED_ORIGINS = new Set<string>([
  'https://borderboxes.pages.dev',
  'http://localhost:3000',   // vite dev server
  'http://localhost:8787'    // local worker origin (dev)
]);

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || 'Content-Type',
    'Vary': 'Origin'
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else {
    // Fallback for non-credentialed requests
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
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
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, ''');
}

const SUMMARY_WINDOW_SECONDS = 6 * 3600;

async function sendSummaryToSlack(env: Env) {
  const webhook = env.SLACK_WEBHOOK;
  if (!webhook) {
    console.warn('SLACK_WEBHOOK not configured; summary skipped');
    return;
  }

  const since = Math.floor(Date.now() / 1000) - SUMMARY_WINDOW_SECONDS;

  const totals = await env.DB.prepare(
    `SELECT
        SUM(CASE WHEN event = 'session_start' THEN 1 ELSE 0 END) AS sessions,
        SUM(CASE WHEN event = 'kill' THEN 1 ELSE 0 END) AS kills,
        SUM(CASE WHEN event = 'loot_pickup' THEN 1 ELSE 0 END) AS loot,
        SUM(CASE WHEN event = 'weapon_equip' THEN 1 ELSE 0 END) AS equips,
        SUM(CASE WHEN event = 'damage_taken' THEN 1 ELSE 0 END) AS damage_events,
        COUNT(DISTINCT CASE WHEN event = 'session_start' THEN player_id END) AS unique_players
     FROM analytics_events
     WHERE created_at >= ?`
  ).bind(since).first<Record<string, number>>();

  const topDifficulty = await env.DB.prepare(
    `SELECT
        COALESCE(json_extract(payload, '$.difficulty'), 'unknown') AS difficulty,
        COUNT(*) AS count
     FROM analytics_events
     WHERE event = 'session_start' AND created_at >= ?
     GROUP BY difficulty
     ORDER BY count DESC
     LIMIT 1`
  ).bind(since).first<{ difficulty: string; count: number }>();

  const topLoot = await env.DB.prepare(
    `SELECT
        COALESCE(json_extract(payload, '$.rarity'), 'unknown') AS rarity,
        COUNT(*) AS count
     FROM analytics_events
     WHERE event = 'loot_pickup' AND created_at >= ?
     GROUP BY rarity
     ORDER BY count DESC
     LIMIT 1`
  ).bind(since).first<{ rarity: string; count: number }>();

  const totalsRow = totals ?? { sessions: 0, kills: 0, loot: 0, equips: 0, damage_events: 0, unique_players: 0 };

  if (!totalsRow.sessions && !totalsRow.kills && !totalsRow.loot && !totalsRow.equips) {
    console.log('No analytics data in the last window; skipping summary');
    return;
  }

  const lines = [
    '*Borderboxes – Last 6h Summary*',
    `• Sessions: ${totalsRow.sessions ?? 0} (Players: ${totalsRow.unique_players ?? 0})`,
    `• Kills: ${totalsRow.kills ?? 0}  |  Loot Pickups: ${totalsRow.loot ?? 0}`,
    `• Weapon Equips: ${totalsRow.equips ?? 0}  |  Damage Events: ${totalsRow.damage_events ?? 0}`
  ];

  if (topDifficulty?.difficulty) {
    lines.push(`• Top Difficulty: ${topDifficulty.difficulty} (${topDifficulty.count} sessions)`);
  }

  if (topLoot?.rarity) {
    lines.push(`• Top Loot Rarity: ${topLoot.rarity} (${topLoot.count} pickups)`);
  }

  const text = lines.join('\n');

  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Handle CORS preflight with dynamic headers
    if (req.method === 'OPTIONS') {
      const headers = buildCorsHeaders(req);
      // Optional: cache preflight
      headers['Access-Control-Max-Age'] = '86400';
      return new Response(null, { headers });
    }

    if (url.pathname === '/admin') {
      const auth = requireAdmin(req, env);
      if (auth) return auth;
      const corsHeaders = buildCorsHeaders(req);

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

      const maxDifficultySessions = Math.max(...difficultyRows.map(r => Number(r.count) || 0), 1);
      const difficultySection = difficultyRows.map(row => {
        const percentage = (Number(row.count) / maxDifficultySessions) * 100;
        const difficultyColors = {
          'easy': '#16a34a',
          'normal': '#ffa500',
          'hard': '#dc2626',
          'unknown': '#888888'
        };
        const color = difficultyColors[String(row.difficulty).toLowerCase()] || '#888888';
        return `
          <tr>
            <td style="text-transform: uppercase; font-weight: 700;">${escapeHtml(row.difficulty)}</td>
            <td style="position: relative;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <div style="flex: 1; height: 20px; background: rgba(0,0,0,0.5); border: 2px solid ${color}; position: relative; overflow: hidden;">
                  <div style="width: ${percentage}%; height: 100%; background: ${color}; opacity: 0.7; box-shadow: inset 0 0 10px rgba(255,255,255,0.3);"></div>
                </div>
                <span style="min-width: 40px; text-align: right; font-weight: 700;">${escapeHtml(row.count)}</span>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      const lootSection = lootRows.map(row => {
        const rarityClass = `rarity-${String(row.rarity).toLowerCase()}`;
        return `
          <tr>
            <td><span class="rarity-badge ${rarityClass}">${escapeHtml(row.rarity)}</span></td>
            <td style="font-weight: 700; font-size: 1.1rem;">${escapeHtml(row.count)}</td>
          </tr>
        `;
      }).join('');

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
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>BORDERBOXES | Analytics Command Center</title>
            <style>
              @import url('https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Orbitron:wght@400;700;900&display=swap');

              :root {
                --bg-dark: #0a0a0a;
                --bg-card: #1a1a1a;
                --border-color: #000;
                --orange: #ffa500;
                --orange-glow: #ffb347;
                --common: #888888;
                --rare: #4169e1;
                --epic: #9932cc;
                --legendary: #ff8c00;
                --text-primary: #ffffff;
                --text-secondary: #b0b0b0;
              }

              * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
              }

              body {
                font-family: 'Orbitron', monospace;
                background: var(--bg-dark);
                background-image:
                  repeating-linear-gradient(
                    0deg,
                    rgba(255, 165, 0, 0.03) 0px,
                    transparent 1px,
                    transparent 2px,
                    rgba(255, 165, 0, 0.03) 3px
                  ),
                  repeating-linear-gradient(
                    90deg,
                    rgba(255, 165, 0, 0.03) 0px,
                    transparent 1px,
                    transparent 2px,
                    rgba(255, 165, 0, 0.03) 3px
                  ),
                  linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 100%);
                background-size: 4px 4px, 4px 4px, 100% 100%;
                color: var(--text-primary);
                margin: 0;
                padding: 20px;
                min-height: 100vh;
                position: relative;
                overflow-x: hidden;
              }

              /* Scanline effect */
              body::before {
                content: "";
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: repeating-linear-gradient(
                  0deg,
                  transparent,
                  transparent 2px,
                  rgba(255, 255, 255, 0.03) 2px,
                  rgba(255, 255, 255, 0.03) 4px
                );
                pointer-events: none;
                z-index: 1;
              }

              .container {
                max-width: 1400px;
                margin: 0 auto;
                position: relative;
                z-index: 2;
              }

              /* Main title with Borderlands style */
              .title-section {
                text-align: center;
                margin-bottom: 40px;
                position: relative;
              }

              h1 {
                font-family: 'Black Ops One', cursive;
                font-size: clamp(2.5rem, 5vw, 4rem);
                text-transform: uppercase;
                letter-spacing: 3px;
                margin: 0;
                padding: 20px;
                color: var(--orange);
                text-shadow:
                  3px 3px 0px #000,
                  -1px -1px 0px #000,
                  1px -1px 0px #000,
                  -1px 1px 0px #000,
                  0 0 20px var(--orange-glow),
                  0 0 40px var(--orange-glow);
                animation: pulse-glow 2s ease-in-out infinite;
                position: relative;
                display: inline-block;
              }

              h1::before {
                content: "[ ";
                color: var(--text-secondary);
                font-size: 0.8em;
              }

              h1::after {
                content: " ]";
                color: var(--text-secondary);
                font-size: 0.8em;
              }

              @keyframes pulse-glow {
                0%, 100% {
                  text-shadow:
                    3px 3px 0px #000,
                    -1px -1px 0px #000,
                    1px -1px 0px #000,
                    -1px 1px 0px #000,
                    0 0 20px var(--orange-glow),
                    0 0 40px var(--orange-glow);
                }
                50% {
                  text-shadow:
                    3px 3px 0px #000,
                    -1px -1px 0px #000,
                    1px -1px 0px #000,
                    -1px 1px 0px #000,
                    0 0 30px var(--orange-glow),
                    0 0 60px var(--orange-glow);
                }
              }

              .subtitle {
                font-size: 0.9rem;
                color: var(--text-secondary);
                text-transform: uppercase;
                letter-spacing: 4px;
                margin-top: -10px;
                font-weight: 400;
              }

              /* Stats grid with Minecraft-style blocks */
              .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 40px;
              }

              .stat-card {
                background: var(--bg-card);
                border: 4px solid var(--border-color);
                position: relative;
                padding: 20px;
                text-align: center;
                transform: perspective(500px) rotateX(2deg);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow:
                  8px 8px 0px rgba(0, 0, 0, 0.5),
                  inset 0 0 20px rgba(255, 165, 0, 0.1);
              }

              .stat-card::before {
                content: "";
                position: absolute;
                top: -2px;
                left: -2px;
                right: -2px;
                bottom: -2px;
                background: linear-gradient(45deg, var(--orange), transparent, var(--orange));
                z-index: -1;
                opacity: 0;
                transition: opacity 0.3s;
              }

              .stat-card:hover {
                transform: perspective(500px) rotateX(0deg) scale(1.05);
                box-shadow:
                  12px 12px 0px rgba(0, 0, 0, 0.5),
                  inset 0 0 30px rgba(255, 165, 0, 0.2),
                  0 0 30px rgba(255, 165, 0, 0.3);
              }

              .stat-card:hover::before {
                opacity: 0.3;
              }

              .stat-card.legendary {
                border-color: var(--legendary);
                box-shadow:
                  8px 8px 0px rgba(0, 0, 0, 0.5),
                  inset 0 0 20px rgba(255, 140, 0, 0.2);
              }

              .stat-card.epic {
                border-color: var(--epic);
                box-shadow:
                  8px 8px 0px rgba(0, 0, 0, 0.5),
                  inset 0 0 20px rgba(153, 50, 204, 0.2);
              }

              .stat-card.rare {
                border-color: var(--rare);
                box-shadow:
                  8px 8px 0px rgba(0, 0, 0, 0.5),
                  inset 0 0 20px rgba(65, 105, 225, 0.2);
              }

              .stat-value {
                font-size: 3rem;
                font-weight: 900;
                font-family: 'Black Ops One', cursive;
                text-shadow:
                  2px 2px 0px #000,
                  -1px -1px 0px #000,
                  1px -1px 0px #000,
                  -1px 1px 0px #000;
                display: block;
                margin-bottom: 10px;
                animation: counter-flip 0.5s ease-in-out;
              }

              @keyframes counter-flip {
                0% { transform: rotateX(0deg); }
                50% { transform: rotateX(90deg); }
                100% { transform: rotateX(0deg); }
              }

              .stat-label {
                text-transform: uppercase;
                font-size: 0.8rem;
                letter-spacing: 2px;
                color: var(--text-secondary);
                font-weight: 700;
              }

              .stat-icon {
                font-size: 1.5rem;
                margin-bottom: 10px;
                filter: drop-shadow(0 0 5px currentColor);
              }

              /* Data sections with cel-shaded style */
              .data-section {
                background: var(--bg-card);
                border: 4px solid var(--border-color);
                margin-bottom: 30px;
                position: relative;
                box-shadow:
                  8px 8px 0px rgba(0, 0, 0, 0.5),
                  inset 0 0 30px rgba(0, 0, 0, 0.5);
                overflow: hidden;
              }

              .data-section::before {
                content: "";
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 4px;
                background: linear-gradient(90deg,
                  transparent 0%,
                  var(--orange) 50%,
                  transparent 100%);
                animation: scan 3s linear infinite;
              }

              @keyframes scan {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
              }

              .section-header {
                background: rgba(255, 165, 0, 0.1);
                padding: 15px 20px;
                border-bottom: 2px solid var(--border-color);
                position: relative;
              }

              .section-title {
                font-family: 'Black Ops One', cursive;
                font-size: 1.5rem;
                text-transform: uppercase;
                letter-spacing: 2px;
                color: var(--orange);
                text-shadow:
                  2px 2px 0px #000,
                  -1px -1px 0px #000,
                  1px -1px 0px #000,
                  -1px 1px 0px #000;
              }

              /* Tables with game aesthetic */
              table {
                width: 100%;
                border-collapse: separate;
                border-spacing: 0;
              }

              thead {
                background: rgba(255, 165, 0, 0.1);
              }

              th {
                padding: 12px;
                text-align: left;
                text-transform: uppercase;
                font-weight: 700;
                font-size: 0.8rem;
                letter-spacing: 1px;
                color: var(--orange);
                border-bottom: 2px solid var(--border-color);
                text-shadow: 1px 1px 0px #000;
              }

              td {
                padding: 12px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                font-weight: 400;
                transition: background 0.2s;
              }

              tbody tr {
                transition: all 0.2s;
              }

              tbody tr:hover {
                background: rgba(255, 165, 0, 0.05);
                transform: translateX(5px);
              }

              tbody tr:hover td {
                text-shadow: 0 0 5px rgba(255, 165, 0, 0.5);
              }

              /* Rarity badges */
              .rarity-badge {
                display: inline-block;
                padding: 4px 12px;
                border: 2px solid;
                text-transform: uppercase;
                font-weight: 700;
                font-size: 0.75rem;
                letter-spacing: 1px;
                border-radius: 0;
                box-shadow: 3px 3px 0px rgba(0, 0, 0, 0.5);
              }

              .rarity-common {
                border-color: var(--common);
                color: var(--common);
                background: rgba(136, 136, 136, 0.1);
              }

              .rarity-rare {
                border-color: var(--rare);
                color: var(--rare);
                background: rgba(65, 105, 225, 0.1);
              }

              .rarity-epic {
                border-color: var(--epic);
                color: var(--epic);
                background: rgba(153, 50, 204, 0.1);
              }

              .rarity-legendary {
                border-color: var(--legendary);
                color: var(--legendary);
                background: rgba(255, 140, 0, 0.1);
                animation: legendary-pulse 2s infinite;
              }

              @keyframes legendary-pulse {
                0%, 100% { box-shadow: 3px 3px 0px rgba(0, 0, 0, 0.5), 0 0 10px var(--legendary); }
                50% { box-shadow: 3px 3px 0px rgba(0, 0, 0, 0.5), 0 0 20px var(--legendary); }
              }

              /* Event details */
              pre {
                background: rgba(0, 0, 0, 0.5);
                border: 1px solid var(--border-color);
                padding: 8px;
                font-size: 0.75rem;
                color: var(--text-secondary);
                overflow-x: auto;
                max-width: 300px;
                font-family: 'Orbitron', monospace;
              }

              /* Footer */
              .footer {
                text-align: center;
                margin-top: 40px;
                padding: 20px;
                color: var(--text-secondary);
                font-size: 0.8rem;
                text-transform: uppercase;
                letter-spacing: 2px;
                opacity: 0.7;
              }

              /* Responsive design */
              @media (max-width: 768px) {
                body {
                  padding: 10px;
                }

                h1 {
                  font-size: 2rem;
                }

                .stats-grid {
                  grid-template-columns: 1fr;
                }

                .stat-value {
                  font-size: 2rem;
                }

                tbody tr:hover {
                  transform: none;
                }
              }

              /* Loading animation */
              @keyframes pixel-load {
                0% { width: 0%; }
                100% { width: 100%; }
              }

              .loading-bar {
                height: 4px;
                background: var(--orange);
                animation: pixel-load 1.5s ease-in-out;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="title-section">
                <h1>BORDERBOXES</h1>
                <div class="subtitle">Analytics Command Center</div>
              </div>
              <div class="stats-grid">
                <div class="stat-card legendary">
                  <div class="stat-icon">🎮</div>
                  <div class="stat-value">${escapeHtml(totalsRow.sessions)}</div>
                  <div class="stat-label">Sessions</div>
                </div>
                <div class="stat-card epic">
                  <div class="stat-icon">💀</div>
                  <div class="stat-value">${escapeHtml(totalsRow.kills)}</div>
                  <div class="stat-label">Total Kills</div>
                </div>
                <div class="stat-card rare">
                  <div class="stat-icon">📦</div>
                  <div class="stat-value">${escapeHtml(totalsRow.loot_pickups)}</div>
                  <div class="stat-label">Loot Pickups</div>
                </div>
                <div class="stat-card rare">
                  <div class="stat-icon">🔫</div>
                  <div class="stat-value">${escapeHtml(totalsRow.equips)}</div>
                  <div class="stat-label">Weapon Equips</div>
                </div>
                <div class="stat-card epic">
                  <div class="stat-icon">⚡</div>
                  <div class="stat-value">${escapeHtml(totalDamage.toFixed(0))}</div>
                  <div class="stat-label">Damage Dealt</div>
                </div>
              </div>

              <div class="data-section">
                <div class="section-header">
                  <h2 class="section-title">Sessions by Difficulty</h2>
                </div>
                <table>
                  <thead>
                    <tr><th>Difficulty</th><th>Sessions</th></tr>
                  </thead>
                  <tbody>${difficultySection}</tbody>
                </table>
              </div>

              <div class="data-section">
                <div class="section-header">
                  <h2 class="section-title">Loot Pickups by Rarity</h2>
                </div>
                <table>
                  <thead>
                    <tr><th>Rarity</th><th>Pickups</th></tr>
                  </thead>
                  <tbody>${lootSection}</tbody>
                </table>
              </div>

              <div class="data-section">
                <div class="section-header">
                  <h2 class="section-title">Recent Events</h2>
                </div>
                <table>
                  <thead>
                    <tr><th>Time (UTC)</th><th>Event</th><th>Player</th><th>Details</th></tr>
                  </thead>
                  <tbody>${recentSection}</tbody>
                </table>
              </div>

              <div class="footer">
                <div>[ Dashboard Access Protected ]</div>
                <div style="margin-top: 10px; font-size: 0.7rem;">System Status: Online | Rotate Admin Password Regularly</div>
              </div>
            </div>

            <script>
              // Animate stat values on page load
              document.addEventListener('DOMContentLoaded', function() {
                const statValues = document.querySelectorAll('.stat-value');
                statValues.forEach((element, index) => {
                  const finalValue = parseInt(element.textContent) || 0;
                  let currentValue = 0;
                  const increment = Math.ceil(finalValue / 30);
                  const duration = 50;

                  element.textContent = '0';
                  element.style.opacity = '0';

                  setTimeout(() => {
                    element.style.opacity = '1';
                    const counter = setInterval(() => {
                      currentValue += increment;
                      if (currentValue >= finalValue) {
                        currentValue = finalValue;
                        clearInterval(counter);
                      }
                      element.textContent = currentValue.toLocaleString();
                    }, duration);
                  }, index * 100);
                });

                // Add glitch effect to title occasionally
                const title = document.querySelector('h1');
                if (title) {
                  setInterval(() => {
                    title.style.transform = 'translateX(' + (Math.random() * 4 - 2) + 'px)';
                    setTimeout(() => {
                      title.style.transform = 'translateX(0)';
                    }, 100);
                  }, 5000);
                }

                // Add refresh functionality
                const refreshButton = document.createElement('button');
                refreshButton.innerHTML = '⟳ REFRESH';
                refreshButton.style.cssText = 'position: fixed; top: 20px; right: 20px; padding: 10px 20px; background: var(--orange); color: black; border: 3px solid black; font-family: "Black Ops One", cursive; font-size: 0.9rem; cursor: pointer; box-shadow: 5px 5px 0 rgba(0,0,0,0.5); transition: all 0.2s; z-index: 100;';
                refreshButton.addEventListener('click', () => {
                  refreshButton.style.transform = 'rotate(360deg)';
                  setTimeout(() => location.reload(), 500);
                });
                refreshButton.addEventListener('mouseenter', () => {
                  refreshButton.style.transform = 'translate(-2px, -2px)';
                  refreshButton.style.boxShadow = '7px 7px 0 rgba(0,0,0,0.5)';
                });
                refreshButton.addEventListener('mouseleave', () => {
                  refreshButton.style.transform = 'translate(0, 0)';
                  refreshButton.style.boxShadow = '5px 5px 0 rgba(0,0,0,0.5)';
                });
                document.body.appendChild(refreshButton);

                // Add timestamp
                const timestamp = document.createElement('div');
                timestamp.style.cssText = 'position: fixed; bottom: 20px; right: 20px; color: var(--text-secondary); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; z-index: 100;';
                timestamp.innerHTML = 'Last Updated: ' + new Date().toLocaleString();
                document.body.appendChild(timestamp);
              });
            </script>
          </body>
        </html>`;

      return new Response(html, {
        status: 200,
        headers: { ...buildCorsHeaders(req), 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if ((url.pathname === '/analytics' || url.pathname === '/telemetry' || url.pathname === '/events') && req.method === 'POST') {
      const headers = buildCorsHeaders(req);
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
        return new Response('invalid analytics payload', { status: 400, headers });
      }
      return new Response(null, { status: 204, headers });
    }

    // Serve audio files from R2 bucket
    if (url.pathname.startsWith("/audio/")) {
      const path = url.pathname.slice("/audio/".length);
      const object = await env.AUDIO_BUCKET.get(path);

      if (!object) {
        return new Response("Audio file not found", {
          status: 404,
          headers: buildCorsHeaders(req)
        });
      }

      const headers = new Headers({
        ...buildCorsHeaders(req),
        'Content-Type': path.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': object.size.toString()
      });

      return new Response(object.body, {
        status: 200,
        headers
      });
    }

    if (url.pathname.startsWith("/rooms/")) {
      // route by room id to DO
      const id = url.pathname.split("/")[2] || "lobby";
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      return stub.fetch(req);
    }

    return new Response("Borderboxes API", {
      status: 200,
      headers: buildCorsHeaders(req)
    });
  }
}

export const scheduled: ExportedHandler<Env>['scheduled'] = async (event, env) => {
  event.waitUntil(sendSummaryToSlack(env));
};

export { Room } from './room';

export interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  TICK_HZ: string;
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
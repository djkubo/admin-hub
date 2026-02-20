import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/* ── helpers ─────────────────────────────────────── */

async function isAdmin(supabase: any): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin');
  return !error && data === true;
}

function envOr(key: string, fallback: string): string {
  return Deno.env.get(key) || fallback;
}

function bridgeUrl(path: string): string {
  const base = Deno.env.get('WHATSAPP_BRIDGE_BASE_URL');
  if (!base) throw new Error('WHATSAPP_BRIDGE_BASE_URL secret is not set');
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function bridgeFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<Response> {
  const timeoutMs = Number(envOr('WHATSAPP_BRIDGE_TIMEOUT_MS', '15000'));
  const apiKey = Deno.env.get('WHATSAPP_BRIDGE_API_KEY');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(bridgeUrl(path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── main handler ────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth — require admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsErr } = await supabase.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims) {
      return json({ ok: false, error: 'Invalid token' }, 401);
    }

    const admin = await isAdmin(supabase);
    if (!admin) {
      return json({ ok: false, error: 'Forbidden – admin only' }, 403);
    }

    // Parse body
    const body = await req.json().catch(() => ({}));
    const action: string = body.action || 'status';

    /* ─── STATUS ─── */
    if (action === 'status') {
      try {
        const path = envOr('WHATSAPP_BRIDGE_STATUS_PATH', '/whatsapp/status');
        const resp = await bridgeFetch(path);
        const data = await resp.json();
        return json({ ok: true, ...data });
      } catch (err) {
        // Graceful degradation: bridge is down
        return json({ ok: true, connected: false, degraded: true, reason: 'Bridge unreachable' });
      }
    }

    /* ─── CONNECT ─── */
    if (action === 'connect') {
      try {
        const path = envOr('WHATSAPP_BRIDGE_CONNECT_PATH', '/whatsapp/connect');
        const resp = await bridgeFetch(path, 'POST');
        const data = await resp.json();
        return json({ ok: true, ...data });
      } catch (err) {
        return json({ ok: false, error: 'Bridge server unreachable. Check that the WhatsApp bridge is running.' }, 503);
      }
    }

    /* ─── DISCONNECT ─── */
    if (action === 'disconnect') {
      try {
        const path = envOr('WHATSAPP_BRIDGE_DISCONNECT_PATH', '/whatsapp/disconnect');
        const resp = await bridgeFetch(path, 'POST');
        const data = await resp.json();
        return json({ ok: true, ...data });
      } catch (err) {
        return json({ ok: false, error: 'Bridge server unreachable.' }, 503);
      }
    }

    /* ─── SEND ─── */
    if (action === 'send') {
      const { to, message, media_url, media_type, media_filename, client_id } = body;
      if (!to || !message) {
        return json({ ok: false, error: 'Missing "to" or "message"' }, 400);
      }

      const path = envOr('WHATSAPP_BRIDGE_SEND_PATH', '/whatsapp/send');
      const sendPayload: Record<string, unknown> = { to, message };
      if (media_url) {
        sendPayload.media_url = media_url;
        sendPayload.media_type = media_type;
        sendPayload.media_filename = media_filename;
      }

      const resp = await bridgeFetch(path, 'POST', sendPayload);
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        return json({ ok: false, error: data.error || `Bridge returned ${resp.status}` }, resp.status);
      }

      // Persist outbound message in chat_events for unified inbox
      const dbClient = createClient(
        supabaseUrl,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );

      const contactId = client_id || to.replace(/[^0-9]/g, '');

      await dbClient.from('chat_events').insert({
        contact_id: contactId,
        platform: 'whatsapp',
        sender: 'agent',
        message,
        media_url: media_url || null,
        media_type: media_type || null,
        media_filename: media_filename || null,
        meta: { sent_via: 'whatsapp-bridge', to },
      } as any);

      return json({ ok: true, ...data });
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[whatsapp-bridge]', message);
    // If the bridge URL is not configured, return 503 instead of 500
    if (message.includes('WHATSAPP_BRIDGE_BASE_URL')) {
      return json({ ok: false, error: 'WhatsApp bridge not configured', degraded: true }, 503);
    }
    return json({ ok: false, error: message }, 500);
  }
});

/* util */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

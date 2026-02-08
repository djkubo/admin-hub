import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============= SECURITY =============

function decodeJwtPayload(token: string): { sub?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

async function verifyAdminOrServiceRole(req: Request): Promise<{ valid: boolean; isServiceRole: boolean; error?: string }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { valid: false, isServiceRole: false, error: "Missing Authorization header" };
  }

  const token = authHeader.replace("Bearer ", "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (serviceRoleKey && token === serviceRoleKey) {
    return { valid: true, isServiceRole: true };
  }

  const claims = decodeJwtPayload(token);
  if (!claims?.sub) {
    return { valid: false, isServiceRole: false, error: "Invalid token format" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now >= claims.exp) {
    return { valid: false, isServiceRole: false, error: "Token expired" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: isAdmin, error } = await supabase.rpc("is_admin");
  if (error) {
    return { valid: false, isServiceRole: false, error: `Auth check failed: ${error.message}` };
  }
  if (!isAdmin) {
    return { valid: false, isServiceRole: false, error: "Not an admin" };
  }

  return { valid: true, isServiceRole: false };
}

// ============= MAIN =============

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = await verifyAdminOrServiceRole(req);
  if (!auth.valid) {
    return new Response(
      JSON.stringify({ ok: false, success: false, error: "Forbidden", message: auth.error }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const phoneNumber = Deno.env.get("TWILIO_PHONE_NUMBER");

  if (!accountSid || !authToken) {
    return new Response(
      JSON.stringify({
        ok: false,
        success: false,
        status: "error",
        error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN secrets required",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!phoneNumber) {
    return new Response(
      JSON.stringify({
        ok: false,
        success: false,
        status: "error",
        error: "TWILIO_PHONE_NUMBER secret required",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Safe health check: fetch account info (does not send messages).
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`;
  const credentials = btoa(`${accountSid}:${authToken}`);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
      },
    });

    const text = await res.text();
    const ok = res.ok;

    return new Response(
      JSON.stringify({
        ok,
        success: ok,
        status: ok ? "connected" : "error",
        apiStatus: res.status,
        // Keep payload small; just return top-level message if available.
        error: ok ? null : text.slice(0, 300),
        testOnly: true,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        success: false,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        testOnly: true,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});


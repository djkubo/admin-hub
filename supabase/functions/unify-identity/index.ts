import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * UNIFY-IDENTITY ENDPOINT
 * ========================
 * Cross-Platform Identity Unification for ManyChat & GoHighLevel
 * 
 * Security: JWT + is_admin() for panel calls, X-ADMIN-KEY for external webhooks
 * Matching: Email as master key, then platform IDs, then phone
 * Priority: Existing core data preserved, NEW tracking data overwrites
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key, x-source, x-webhook-signature',
};

// ============ TYPES ============
interface UnifyPayload {
  email?: string;
  phone?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  ghl_contact_id?: string;
  manychat_subscriber_id?: string;
  manychat_user_id?: string;
  subscriber_id?: string;
  stripe_customer_id?: string;
  paypal_customer_id?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  gclid?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  wa_opt_in?: boolean;
  sms_opt_in?: boolean;
  email_opt_in?: boolean;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: string;
}

interface BatchPayload {
  contacts: UnifyPayload[];
}

// ============ VERIFY ADMIN (JWT) ============
async function verifyAdminJWT(req: Request): Promise<{ valid: boolean; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { valid: false, error: 'Invalid token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true };
}

// ============ VERIFY ADMIN KEY (for webhooks) ============
function verifyAdminKey(req: Request): boolean {
  const adminKey = Deno.env.get('ADMIN_API_KEY');
  const providedKey = req.headers.get('x-admin-key');
  return !!(adminKey && providedKey && providedKey === adminKey);
}

// ============ UTILITIES ============
function sanitizeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return String(value).trim() || null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('{{') || trimmed === 'null' || trimmed === 'undefined') {
    return null;
  }
  return trimmed;
}

function isValidEmail(email: string | null): boolean {
  if (!email) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

function buildTrackingData(payload: UnifyPayload): Record<string, unknown> {
  const tracking: Record<string, unknown> = {};
  
  if (payload.fbp) tracking.fbp = sanitizeString(payload.fbp);
  if (payload.fbc || payload.fbclid) {
    tracking.fbc = sanitizeString(payload.fbc) || sanitizeString(payload.fbclid);
  }
  if (payload.gclid) tracking.gclid = sanitizeString(payload.gclid);
  
  const utmSource = sanitizeString(payload.utm_source);
  const utmMedium = sanitizeString(payload.utm_medium);
  const utmCampaign = sanitizeString(payload.utm_campaign);
  const utmContent = sanitizeString(payload.utm_content);
  const utmTerm = sanitizeString(payload.utm_term);
  
  if (utmSource) tracking.utm_source = utmSource;
  if (utmMedium) tracking.utm_medium = utmMedium;
  if (utmCampaign) tracking.utm_campaign = utmCampaign;
  if (utmContent) tracking.utm_content = utmContent;
  if (utmTerm) tracking.utm_term = utmTerm;
  
  if (payload.custom_fields && typeof payload.custom_fields === 'object') {
    tracking.custom_fields = payload.custom_fields;
  }
  if (payload.metadata && typeof payload.metadata === 'object') {
    tracking.metadata = payload.metadata;
  }
  
  if (Object.keys(tracking).length > 0) {
    tracking.captured_at = new Date().toISOString();
  }
  
  return tracking;
}

function buildOptIn(payload: UnifyPayload): Record<string, boolean | null> {
  return {
    wa: payload.wa_opt_in ?? null,
    sms: payload.sms_opt_in ?? null,
    email: payload.email_opt_in ?? null,
  };
}

function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(t => sanitizeString(t))
    .filter((t): t is string => t !== null && t.length > 0);
}

// ============ PROCESS SINGLE CONTACT ============
async function processContact(
  supabase: any,
  payload: UnifyPayload,
  sourceHeader: string,
  requestId: string
): Promise<{ success: boolean; action: string; client_id?: string; error?: string }> {
  try {
    const source = sanitizeString(payload.source) || sourceHeader;
    
    const rawEmail = sanitizeString(payload.email);
    const rawPhone = sanitizeString(payload.phone);
    const firstName = sanitizeString(payload.first_name);
    const lastName = sanitizeString(payload.last_name);
    const rawName = sanitizeString(payload.full_name);
    
    const fullName = rawName || 
      (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || null);
    
    const email = rawEmail && isValidEmail(rawEmail) ? rawEmail.toLowerCase() : null;
    
    const ghlContactId = sanitizeString(payload.ghl_contact_id);
    const manychatId = sanitizeString(payload.manychat_subscriber_id) || 
                       sanitizeString(payload.manychat_user_id) ||
                       sanitizeString(payload.subscriber_id);
    const stripeCustomerId = sanitizeString(payload.stripe_customer_id);
    const paypalCustomerId = sanitizeString(payload.paypal_customer_id);
    
    const trackingData = buildTrackingData(payload);
    const optIn = buildOptIn(payload);
    const tags = sanitizeTags(payload.tags);
    
    const { data, error } = await supabase.rpc('unify_identity', {
      p_source: source,
      p_email: email,
      p_phone: rawPhone,
      p_full_name: fullName,
      p_ghl_contact_id: ghlContactId,
      p_manychat_subscriber_id: manychatId,
      p_stripe_customer_id: stripeCustomerId,
      p_paypal_customer_id: paypalCustomerId,
      p_tracking_data: Object.keys(trackingData).length > 0 ? trackingData : {},
      p_tags: tags.length > 0 ? tags : [],
      p_opt_in: optIn,
    });
    
    if (error) {
      console.error(`[${requestId}] RPC error:`, error);
      return { success: false, action: 'error', error: error.message };
    }
    
    const result = data as { success: boolean; action: string; client_id: string; error?: string };
    
    if (!result.success) {
      return { success: false, action: 'error', error: result.error };
    }
    
    return {
      success: true,
      action: result.action,
      client_id: result.client_id,
    };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${requestId}] Processing error:`, msg);
    return { success: false, action: 'error', error: msg };
  }
}

// ============ BATCH PROCESSOR ============
async function processBatch(
  supabase: any,
  contacts: UnifyPayload[],
  sourceHeader: string,
  requestId: string
): Promise<{ 
  processed: number; 
  created: number; 
  updated: number;
  errors: number; 
  error_details: string[] 
}> {
  let processed = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;
  const errorDetails: string[] = [];
  
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(contact => processContact(supabase, contact, sourceHeader, requestId))
    );
    
    for (const result of results) {
      processed++;
      if (!result.success) {
        errors++;
        if (errorDetails.length < 10) {
          errorDetails.push(result.error || 'Unknown error');
        }
      } else if (result.action === 'created') {
        created++;
      } else if (result.action === 'updated') {
        updated++;
      }
    }
    
    if (processed % 50 === 0) {
      console.log(`[${requestId}] Progress: ${processed}/${contacts.length}`);
    }
  }
  
  console.log(`[${requestId}] BATCH COMPLETE: ${processed} processed, ${created} created, ${updated} updated, ${errors} errors`);
  
  return { processed, created, updated, errors, error_details: errorDetails };
}

// ============ MAIN HANDLER ============
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  
  console.log(`[${requestId}] unify-identity: Start`);
  
  try {
    // ==========================================
    // SECURITY: Try JWT first, then X-ADMIN-KEY
    // ==========================================
    const jwtAuth = await verifyAdminJWT(req);
    const keyAuth = verifyAdminKey(req);
    
    if (!jwtAuth.valid && !keyAuth) {
      console.warn(`[${requestId}] Unauthorized request`);
      return new Response(
        JSON.stringify({ 
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Valid JWT or X-ADMIN-KEY required'
        }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ==========================================
    // PARSE REQUEST
    // ==========================================
    const sourceHeader = req.headers.get('x-source') || 'webhook';
    
    let body: UnifyPayload | BatchPayload;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ 
          ok: false,
          error: 'INVALID_JSON',
          message: 'Request body must be valid JSON'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    
    // ==========================================
    // BATCH MODE
    // ==========================================
    if ('contacts' in body && Array.isArray(body.contacts)) {
      const contacts = body.contacts;
      
      if (contacts.length === 0) {
        return new Response(
          JSON.stringify({ 
            ok: true,
            status: 'completed',
            processed: 0,
            hasMore: false,
            duration_ms: Date.now() - startTime
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      console.log(`[${requestId}] BATCH MODE: Processing ${contacts.length} contacts`);
      
      const result = await processBatch(supabase, contacts, sourceHeader, requestId);
      const duration = Date.now() - startTime;
      
      console.log(`[${requestId}] Completed in ${duration}ms`);
      
      return new Response(
        JSON.stringify({ 
          ok: true,
          status: 'completed',
          processed: result.processed,
          hasMore: false,
          duration_ms: duration,
          created: result.created,
          updated: result.updated,
          errors: result.errors,
          error_details: result.error_details
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // ==========================================
    // SINGLE CONTACT MODE
    // ==========================================
    const result = await processContact(supabase, body as UnifyPayload, sourceHeader, requestId);
    const duration = Date.now() - startTime;
    
    console.log(`[${requestId}] Completed in ${duration}ms - Action: ${result.action}`);
    
    return new Response(
      JSON.stringify({ 
        ok: result.success,
        status: result.success ? 'completed' : 'error',
        action: result.action,
        client_id: result.client_id,
        source: (body as UnifyPayload).source || sourceHeader,
        error: result.error,
        processed: 1,
        hasMore: false,
        duration_ms: duration
      }),
      { 
        status: result.success ? 200 : 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error(`[${requestId}] Fatal error:`, error);
    
    return new Response(
      JSON.stringify({ 
        ok: false,
        status: 'error',
        error: errorMessage,
        duration_ms: Date.now() - startTime
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * UNIFY-IDENTITY WEBHOOK ENDPOINT
 * ================================
 * Cross-Platform Identity Unification for ManyChat & GoHighLevel
 * 
 * Security: Validates X-ADMIN-KEY header
 * Matching: Email as master key, then platform IDs, then phone
 * Priority: Existing core data preserved, NEW tracking data overwrites
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key, x-source, x-webhook-signature',
};

// ============ TYPES ============
interface UnifyPayload {
  // Core identity
  email?: string;
  phone?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  
  // Platform IDs
  ghl_contact_id?: string;
  manychat_subscriber_id?: string;
  manychat_user_id?: string;  // Alias
  subscriber_id?: string;     // Alias
  stripe_customer_id?: string;
  paypal_customer_id?: string;
  
  // Marketing tracking
  fbp?: string;               // Facebook Browser ID
  fbc?: string;               // Facebook Click ID
  fbclid?: string;            // Facebook Click ID (URL param)
  gclid?: string;             // Google Click ID
  
  // UTM parameters
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  
  // Opt-ins
  wa_opt_in?: boolean;
  sms_opt_in?: boolean;
  email_opt_in?: boolean;
  
  // Tags
  tags?: string[];
  
  // Custom data
  custom_fields?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  
  // Source identifier
  source?: string;
}

interface BatchPayload {
  contacts: UnifyPayload[];
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
  
  // Facebook tracking
  if (payload.fbp) tracking.fbp = sanitizeString(payload.fbp);
  if (payload.fbc || payload.fbclid) {
    tracking.fbc = sanitizeString(payload.fbc) || sanitizeString(payload.fbclid);
  }
  
  // Google tracking
  if (payload.gclid) tracking.gclid = sanitizeString(payload.gclid);
  
  // UTM parameters
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
  
  // Custom fields
  if (payload.custom_fields && typeof payload.custom_fields === 'object') {
    tracking.custom_fields = payload.custom_fields;
  }
  if (payload.metadata && typeof payload.metadata === 'object') {
    tracking.metadata = payload.metadata;
  }
  
  // Capture timestamp
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processContact(
  supabase: any,
  payload: UnifyPayload,
  sourceHeader: string,
  requestId: string
): Promise<{ success: boolean; action: string; client_id?: string; error?: string }> {
  try {
    const source = sanitizeString(payload.source) || sourceHeader;
    
    // Sanitize core fields
    const rawEmail = sanitizeString(payload.email);
    const rawPhone = sanitizeString(payload.phone);
    const firstName = sanitizeString(payload.first_name);
    const lastName = sanitizeString(payload.last_name);
    const rawName = sanitizeString(payload.full_name);
    
    // Build full name
    const fullName = rawName || 
      (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || null);
    
    // Validate email
    const email = rawEmail && isValidEmail(rawEmail) ? rawEmail.toLowerCase() : null;
    
    // Get platform IDs (handle aliases)
    const ghlContactId = sanitizeString(payload.ghl_contact_id);
    const manychatId = sanitizeString(payload.manychat_subscriber_id) || 
                       sanitizeString(payload.manychat_user_id) ||
                       sanitizeString(payload.subscriber_id);
    const stripeCustomerId = sanitizeString(payload.stripe_customer_id);
    const paypalCustomerId = sanitizeString(payload.paypal_customer_id);
    
    // Build tracking data
    const trackingData = buildTrackingData(payload);
    
    // Build opt-in object
    const optIn = buildOptIn(payload);
    
    // Sanitize tags
    const tags = sanitizeTags(payload.tags);
    
    // Call the unify_identity database function
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // SECURITY VALIDATION
    // ==========================================
    const adminKey = Deno.env.get('ADMIN_API_KEY');
    const providedKey = req.headers.get('x-admin-key');
    
    if (!adminKey) {
      console.error(`[${requestId}] ADMIN_API_KEY not configured`);
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'SERVICE_NOT_CONFIGURED',
          message: 'Service is not properly configured'
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!providedKey || providedKey !== adminKey) {
      console.warn(`[${requestId}] Unauthorized request - invalid X-ADMIN-KEY`);
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Invalid or missing X-ADMIN-KEY header'
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
          success: false,
          error: 'INVALID_JSON',
          message: 'Request body must be valid JSON'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Initialize Supabase client
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
            success: true,
            message: 'No contacts to process',
            processed: 0
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
          success: true,
          mode: 'batch',
          duration_ms: duration,
          ...result
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
        success: result.success,
        action: result.action,
        client_id: result.client_id,
        source: (body as UnifyPayload).source || sourceHeader,
        error: result.error,
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
        success: false,
        error: 'INTERNAL_ERROR',
        message: errorMessage
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from "../_shared/logger.ts";

const logger = createLogger("ghl-webhook", LogLevel.INFO);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-wh-signature",
};

// ============================================================================
// CIRCUIT BREAKER - Protección contra saturación de base de datos
// ============================================================================
// Si la base de datos está saturada, respondemos 200 OK inmediatamente
// sin intentar ninguna operación. Esto rompe el ciclo de retries de GHL.
// ============================================================================

const DB_HEALTH_TIMEOUT_MS = 2000; // 2 segundos max para health check

async function checkDatabaseHealth(supabase: SupabaseClient): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DB_HEALTH_TIMEOUT_MS);
    
    // Simple ping: SELECT 1 es la query más rápida posible
    const { error } = await supabase
      .from('clients')
      .select('id')
      .limit(1)
      .abortSignal(controller.signal);
    
    clearTimeout(timeoutId);
    
    if (error) {
      logger.warn("DB health check failed", { error: error.message });
      return false;
    }
    
    return true;
  } catch (e) {
    const err = e as Error;
    // AbortError significa timeout
    if (err.name === 'AbortError') {
      logger.warn("DB health check timed out", { timeoutMs: DB_HEALTH_TIMEOUT_MS });
    } else {
      logger.warn("DB health check exception", { error: err.message });
    }
    return false;
  }
}

// GHL Event types we handle
type GHLEventType = "ContactCreate" | "ContactUpdate" | "ContactDelete" | "ContactDndUpdate";

interface GHLDndSettings {
  sms?: { status: string };
  email?: { status: string };
  whatsApp?: { status: string };
}

interface GHLAttributionSource {
  sessionSource?: string;
  medium?: string;
  campaign?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

interface GHLCustomField {
  id: string;
  key?: string;
  value: string;
}

interface GHLWebhookPayload {
  type: GHLEventType;
  locationId?: string;
  id: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  tags?: string[];
  source?: string;
  dnd?: boolean;
  dndSettings?: GHLDndSettings;
  attributionSource?: GHLAttributionSource;
  customFields?: GHLCustomField[];
  dateAdded?: string;
  dateUpdated?: string;
  country?: string;
  city?: string;
  state?: string;
  address1?: string;
  postalCode?: string;
  website?: string;
  timezone?: string;
  companyName?: string;
  assignedTo?: string;
}

// Transform GHL payload to unify-identity format
function transformGHLPayload(payload: GHLWebhookPayload) {
  // Build full name
  let fullName = "";
  if (payload.firstName || payload.lastName) {
    fullName = [payload.firstName, payload.lastName].filter(Boolean).join(" ").trim();
  } else if (payload.name) {
    fullName = payload.name;
  }

  // Parse DND settings for opt-ins
  // In GHL: dnd=true means DO NOT DISTURB (opted out)
  // dndSettings.X.status = "active" means DO NOT DISTURB is active (opted out)
  const isDndActive = payload.dnd === true;
  const smsOptIn = !isDndActive && payload.dndSettings?.sms?.status !== "active";
  const waOptIn = !isDndActive && payload.dndSettings?.whatsApp?.status !== "active";
  const emailOptIn = !isDndActive && payload.dndSettings?.email?.status !== "active";

  // Transform custom fields to object
  const customFieldsObj: Record<string, string> = {};
  if (payload.customFields && Array.isArray(payload.customFields)) {
    for (const field of payload.customFields) {
      const key = field.key || field.id;
      if (key && field.value) {
        customFieldsObj[key] = field.value;
      }
    }
  }

  // Build tracking data with UTMs and metadata
  const trackingData: Record<string, unknown> = {
    ghl_source: payload.source || null,
    ghl_date_added: payload.dateAdded || null,
    ghl_date_updated: payload.dateUpdated || null,
    ghl_location_id: payload.locationId || null,
    ghl_assigned_to: payload.assignedTo || null,
  };

  // Add address info if present
  if (payload.country || payload.city || payload.state || payload.address1 || payload.postalCode) {
    trackingData.address = {
      country: payload.country,
      city: payload.city,
      state: payload.state,
      address1: payload.address1,
      postalCode: payload.postalCode,
    };
  }

  // Add company info
  if (payload.companyName) {
    trackingData.company_name = payload.companyName;
  }

  // Add custom fields
  if (Object.keys(customFieldsObj).length > 0) {
    trackingData.custom_fields = customFieldsObj;
  }

  // Extract UTM parameters from attributionSource
  const attribution = payload.attributionSource;
  
  return {
    p_source: "ghl",
    p_ghl_contact_id: payload.id,
    p_email: payload.email || null,
    p_phone: payload.phone || null,
    p_full_name: fullName || null,
    p_tags: payload.tags || [],
    p_opt_in: {
      sms: smsOptIn,
      wa: waOptIn,
      email: emailOptIn,
    },
    p_tracking_data: {
      utm_source: attribution?.utmSource || attribution?.sessionSource || null,
      utm_medium: attribution?.utmMedium || attribution?.medium || null,
      utm_campaign: attribution?.utmCampaign || attribution?.campaign || null,
      utm_content: attribution?.utmContent || null,
      utm_term: attribution?.utmTerm || null,
      ...trackingData,
    },
  };
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  logger.info("Webhook received", { requestId, method: req.method });

  // =========================================================================
  // CIRCUIT BREAKER CHECK - Ejecutar ANTES de cualquier procesamiento
  // =========================================================================
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    logger.error("Missing Supabase configuration", undefined, { requestId });
    // Responder 200 OK para evitar retries infinitos
    return new Response(JSON.stringify({ 
      success: false, 
      error: "Server configuration error",
      mode: "circuit_breaker" 
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Health check rápido
  const isDbHealthy = await checkDatabaseHealth(supabase);
  
  if (!isDbHealthy) {
    logger.warn("🛡️ CIRCUIT BREAKER ACTIVATED - DB unavailable, returning 200 OK without processing", { 
      requestId,
      timeoutMs: DB_HEALTH_TIMEOUT_MS,
    });
    
    // Responder 200 OK inmediatamente - NO intentar nada más
    // Esto rompe el ciclo de retries de GHL
    return new Response(JSON.stringify({ 
      success: true, // Decimos "success" para que GHL no reintente
      action: "circuit_breaker",
      message: "Database temporarily unavailable, webhook acknowledged but not processed",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  logger.info("DB health check passed", { requestId });
  // =========================================================================
  // FIN CIRCUIT BREAKER - Continuar procesamiento normal
  // =========================================================================

  try {
    // Only accept POST
    if (req.method !== "POST") {
      logger.warn("Invalid method", { requestId, method: req.method });
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse payload
    let payload: GHLWebhookPayload;
    try {
      payload = await req.json();
    } catch {
      logger.error("Invalid JSON payload", undefined, { requestId });
      // Always return 200 to prevent GHL retries
      return new Response(JSON.stringify({ success: false, error: "Invalid JSON" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Payload parsed", { 
      requestId, 
      type: payload.type, 
      contactId: payload.id,
      email: payload.email?.substring(0, 5) + "***",
      hasPhone: !!payload.phone,
    });

    // Validate required fields
    if (!payload.id) {
      logger.warn("Missing contact ID", { requestId });
      return new Response(JSON.stringify({ success: false, error: "Missing contact ID" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Handle different event types
    const eventType = payload.type;
    
    // Skip delete events (log only)
    if (eventType === "ContactDelete") {
      logger.info("Contact delete event - logging only", { 
        requestId, 
        contactId: payload.id,
      });
      return new Response(JSON.stringify({ 
        success: true, 
        action: "logged",
        message: "Delete events are logged but not processed" 
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Transform payload
    const unifyParams = transformGHLPayload(payload);
    logger.info("Transformed payload", { 
      requestId, 
      ghlContactId: unifyParams.p_ghl_contact_id,
      hasEmail: !!unifyParams.p_email,
      hasPhone: !!unifyParams.p_phone,
      tagsCount: unifyParams.p_tags?.length || 0,
    });

    // OPTIMIZACIÓN: Insertar en tabla de staging en lugar de llamar RPC bloqueante
    // Esto evita timeouts de 60-120 segundos
    const stagingRecord = {
      external_id: unifyParams.p_ghl_contact_id,
      payload: {
        email: unifyParams.p_email,
        phone: unifyParams.p_phone,
        full_name: unifyParams.p_full_name,
        tags: unifyParams.p_tags,
        opt_in: unifyParams.p_opt_in,
        tracking_data: unifyParams.p_tracking_data,
        source: 'ghl',
        event_type: eventType,
      },
      fetched_at: new Date().toISOString(),
      processed_at: null,
    };

    // Intentar insertar en staging (rápido, no bloquea)
    const { error: stagingError } = await supabase
      .from('ghl_contacts_raw')
      .upsert(stagingRecord, { 
        onConflict: 'external_id',
        ignoreDuplicates: false 
      });

    if (stagingError) {
      // NO usar EdgeRuntime.waitUntil - estaba causando más carga
      // Simplemente logear el error y responder OK
      logger.warn("Staging insert failed - acknowledging webhook without processing", { 
        requestId, 
        error: stagingError.message 
      });
      
      // Responder OK de todas formas para evitar retries
      return new Response(JSON.stringify({ 
        success: true, 
        action: "acknowledged",
        message: "Webhook received but could not be staged, will retry on next sync",
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Staged for batch processing", { requestId, ghlContactId: unifyParams.p_ghl_contact_id });

    // Responder inmediatamente (< 1 segundo)
    return new Response(JSON.stringify({ 
      success: true, 
      action: "queued",
      ghl_contact_id: unifyParams.p_ghl_contact_id,
      event_type: eventType,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    logger.error("Unexpected error", error as Error, { requestId });
    // Always return 200 to prevent infinite retries from GHL
    return new Response(JSON.stringify({ 
      success: false, 
      error: "Internal server error",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

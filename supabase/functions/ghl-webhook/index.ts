import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from "../_shared/logger.ts";

const logger = createLogger("ghl-webhook", LogLevel.INFO);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-wh-signature",
};

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

    // Create Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      logger.error("Missing Supabase configuration", undefined, { requestId });
      return new Response(JSON.stringify({ success: false, error: "Server configuration error" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Call unify_identity RPC
    const timer = logger.timer("unify_identity RPC");
    const { data, error } = await supabase.rpc("unify_identity", unifyParams);
    timer();

    if (error) {
      logger.error("RPC error", error as Error, { 
        requestId, 
        code: error.code,
        details: error.details,
      });
      // Still return 200 to prevent retries
      return new Response(JSON.stringify({ 
        success: false, 
        error: error.message,
        code: error.code,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Contact unified successfully", { 
      requestId, 
      result: data,
      eventType,
    });

    return new Response(JSON.stringify({ 
      success: true, 
      action: data?.action || "processed",
      client_id: data?.client_id,
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

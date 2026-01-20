import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key, x-source',
};

interface LeadPayload {
  // Idempotency
  event_id?: string;
  
  // Source identification
  source?: string; // e.g., 'manychat_instagram', 'ghl_whatsapp', 'tiktok_ads', 'facebook_ads'
  
  // Contact info
  email?: string;
  phone?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  
  // UTM Attribution
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  
  // Legacy attribution field (mapped to utm_campaign)
  campaign?: string;
  
  // External IDs
  external_manychat_id?: string;
  external_ghl_id?: string;
  manychat_subscriber_id?: string;
  ghl_contact_id?: string;
  
  // Timestamp for recency comparison
  timestamp?: string;
  
  // Tags
  tags?: string[];
  
  // Extra metadata
  metadata?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  
  console.log(`[${requestId}] receive-lead: Start`);

  try {
    // ============ SECURITY: Validate X-ADMIN-KEY ============
    const adminKey = Deno.env.get('ADMIN_API_KEY');
    const providedKey = req.headers.get('x-admin-key');
    
    if (!adminKey) {
      console.error(`[${requestId}] ADMIN_API_KEY not configured`);
      return new Response(
        JSON.stringify({ 
          error: 'Service not configured', 
          code: 'MISSING_SECRET',
          message: 'ADMIN_API_KEY secret is not set. Please configure it in Supabase secrets.'
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!providedKey) {
      console.warn(`[${requestId}] Missing X-ADMIN-KEY header`);
      return new Response(
        JSON.stringify({ error: 'Unauthorized', message: 'Missing X-ADMIN-KEY header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (providedKey !== adminKey) {
      console.warn(`[${requestId}] Invalid X-ADMIN-KEY`);
      return new Response(
        JSON.stringify({ error: 'Unauthorized', message: 'Invalid X-ADMIN-KEY' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ PARSE & VALIDATE ============
    const sourceHeader = req.headers.get('x-source') || 'api';
    const body: LeadPayload = await req.json();
    const source = body.source || sourceHeader;
    
    console.log(`[${requestId}] Source: ${source}, Email: ${body.email || 'N/A'}, Phone: ${body.phone || 'N/A'}`);

    // Validate: need at least email or phone
    if (!body.email && !body.phone) {
      return new Response(
        JSON.stringify({ error: 'Validation failed', message: 'Either email or phone is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ NORMALIZE ============
    const emailNormalized = body.email ? body.email.toLowerCase().trim() : null;
    const phoneNormalized = normalizePhone(body.phone);
    const fullName = body.full_name || 
      (body.first_name && body.last_name ? `${body.first_name} ${body.last_name}` : 
       body.first_name || body.last_name || null);

    // Generate event_id for idempotency if not provided
    const eventId = body.event_id || 
      body.external_manychat_id || 
      body.manychat_subscriber_id ||
      body.external_ghl_id ||
      body.ghl_contact_id ||
      `${source}_${emailNormalized || phoneNormalized}_${Date.now()}`;

    // External IDs (support both naming conventions)
    const manychatId = body.external_manychat_id || body.manychat_subscriber_id || null;
    const ghlId = body.external_ghl_id || body.ghl_contact_id || null;

    // UTM fields (campaign is legacy alias for utm_campaign)
    const utmSource = body.utm_source || null;
    const utmMedium = body.utm_medium || null;
    const utmCampaign = body.utm_campaign || body.campaign || null;
    const utmContent = body.utm_content || null;
    const utmTerm = body.utm_term || null;

    // ============ SUPABASE CLIENT ============
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ============ IDEMPOTENCY CHECK ============
    const { data: existingEvent } = await supabase
      .from('lead_events')
      .select('id')
      .eq('source', source)
      .eq('event_id', eventId)
      .maybeSingle();

    if (existingEvent) {
      console.log(`[${requestId}] Duplicate event - already processed: ${eventId}`);
      return new Response(
        JSON.stringify({ 
          success: true, 
          action: 'skipped', 
          reason: 'duplicate_event',
          event_id: eventId 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ FIND EXISTING CLIENT ============
    let existingClient = null;
    
    // Priority 1: Find by email (most reliable)
    if (emailNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .ilike('email', emailNormalized)
        .maybeSingle();
      existingClient = data;
    }
    
    // Priority 2: Find by phone if no email match
    if (!existingClient && phoneNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('phone', phoneNormalized)
        .maybeSingle();
      existingClient = data;
    }

    // Priority 3: Find by external ID
    if (!existingClient && manychatId) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('manychat_subscriber_id', manychatId)
        .maybeSingle();
      existingClient = data;
    }
    
    if (!existingClient && ghlId) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('ghl_contact_id', ghlId)
        .maybeSingle();
      existingClient = data;
    }

    let clientId: string;
    let action: 'created' | 'updated';
    const eventTimestamp = body.timestamp ? new Date(body.timestamp) : new Date();

    if (existingClient) {
      // ============ UPDATE EXISTING CLIENT ============
      // Rule: Only fill nulls or update if incoming data is more recent
      const updates: Record<string, unknown> = {};
      
      // Fill empty contact info
      if (!existingClient.email && emailNormalized) updates.email = emailNormalized;
      if (!existingClient.phone && phoneNormalized) updates.phone = phoneNormalized;
      if (!existingClient.full_name && fullName) updates.full_name = fullName;
      
      // Fill empty external IDs
      if (!existingClient.manychat_subscriber_id && manychatId) {
        updates.manychat_subscriber_id = manychatId;
      }
      if (!existingClient.ghl_contact_id && ghlId) {
        updates.ghl_contact_id = ghlId;
      }
      
      // Attribution - ONLY set if not already set (first touch wins)
      if (!existingClient.acquisition_source && source) updates.acquisition_source = source;
      if (!existingClient.utm_source && utmSource) updates.utm_source = utmSource;
      if (!existingClient.utm_medium && utmMedium) updates.utm_medium = utmMedium;
      if (!existingClient.utm_campaign && utmCampaign) updates.utm_campaign = utmCampaign;
      if (!existingClient.utm_content && utmContent) updates.utm_content = utmContent;
      if (!existingClient.utm_term && utmTerm) updates.utm_term = utmTerm;
      
      // Merge tags
      if (body.tags && body.tags.length > 0) {
        const existingTags = existingClient.tags || [];
        const mergedTags = [...new Set([...existingTags, ...body.tags])];
        updates.tags = mergedTags;
      }

      // Always update last_lead_at
      updates.last_lead_at = new Date().toISOString();
      updates.last_sync = new Date().toISOString();

      if (Object.keys(updates).length > 0) {
        await supabase
          .from('clients')
          .update(updates)
          .eq('id', existingClient.id);
      }

      clientId = existingClient.id;
      action = 'updated';
      console.log(`[${requestId}] Updated existing client: ${clientId}`);
      
    } else {
      // ============ CREATE NEW CLIENT ============
      const newClient = {
        email: emailNormalized,
        phone: phoneNormalized,
        full_name: fullName,
        lifecycle_stage: 'LEAD',
        lead_status: 'lead',
        status: 'active',
        acquisition_source: source,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        utm_content: utmContent,
        utm_term: utmTerm,
        first_seen_at: new Date().toISOString(),
        last_lead_at: new Date().toISOString(),
        manychat_subscriber_id: manychatId,
        ghl_contact_id: ghlId,
        tags: body.tags || [],
        customer_metadata: body.metadata || {},
      };

      const { data: created, error } = await supabase
        .from('clients')
        .insert(newClient)
        .select('id')
        .single();

      if (error) {
        console.error(`[${requestId}] Error creating client:`, error);
        throw error;
      }

      clientId = created.id;
      action = 'created';
      console.log(`[${requestId}] Created new lead: ${clientId}`);
    }

    // ============ RECORD LEAD EVENT (idempotency) ============
    await supabase.from('lead_events').insert({
      source,
      event_id: eventId,
      event_type: action === 'created' ? 'lead_created' : 'lead_updated',
      client_id: clientId,
      email: emailNormalized,
      phone: phoneNormalized,
      full_name: fullName,
      payload: body,
    });

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Completed in ${duration}ms - Action: ${action}, ClientId: ${clientId}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        action, 
        client_id: clientId,
        source,
        event_id: eventId 
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error(`[${requestId}] Error:`, error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  
  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  // If starts with +, keep it
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, '');
  
  // Handle Mexican numbers (10 digits)
  if (cleaned.length === 10) {
    return '+52' + cleaned;
  }
  
  // Handle US numbers (10 digits starting with area code, or 11 starting with 1)
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+' + cleaned;
  }
  
  // If already has country code (12+ digits for Mexico, 11 for US)
  if (cleaned.length >= 11) {
    return '+' + cleaned;
  }
  
  // Return with + prefix if valid length
  if (cleaned.length >= 10) {
    return '+' + cleaned;
  }
  
  return null; // Invalid phone
}

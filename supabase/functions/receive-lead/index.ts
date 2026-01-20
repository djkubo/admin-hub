import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key, x-source',
};

interface LeadPayload {
  // Common fields
  email?: string;
  phone?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  
  // Attribution
  source?: string;
  campaign?: string;
  medium?: string;
  content?: string;
  
  // Source-specific IDs
  manychat_subscriber_id?: string;
  ghl_contact_id?: string;
  
  // Event info for idempotency
  event_id?: string;
  
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
    // Security: Validate X-ADMIN-KEY header
    const adminKey = Deno.env.get('ADMIN_API_KEY');
    const providedKey = req.headers.get('x-admin-key');
    
    if (!adminKey) {
      console.error(`[${requestId}] ADMIN_API_KEY not configured`);
      return new Response(
        JSON.stringify({ error: 'Service not configured', code: 'MISSING_SECRET' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!providedKey || providedKey !== adminKey) {
      console.warn(`[${requestId}] Unauthorized request - invalid X-ADMIN-KEY`);
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse source from header or body
    const sourceHeader = req.headers.get('x-source') || 'api';
    const body: LeadPayload = await req.json();
    const source = body.source || sourceHeader;
    
    console.log(`[${requestId}] Source: ${source}, Email: ${body.email || 'N/A'}, Phone: ${body.phone || 'N/A'}`);

    // Validate required fields - need at least email or phone
    if (!body.email && !body.phone) {
      return new Response(
        JSON.stringify({ error: 'Either email or phone is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate event_id if not provided
    const eventId = body.event_id || `${source}_${body.email || body.phone}_${Date.now()}`;

    // Create Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Idempotency check
    const { data: existingEvent } = await supabase
      .from('lead_events')
      .select('id')
      .eq('source', source)
      .eq('event_id', eventId)
      .maybeSingle();

    if (existingEvent) {
      console.log(`[${requestId}] Duplicate event - already processed: ${eventId}`);
      return new Response(
        JSON.stringify({ success: true, action: 'skipped', reason: 'duplicate_event' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Normalize email and phone
    const emailNormalized = body.email?.toLowerCase().trim();
    const phoneNormalized = normalizePhone(body.phone);

    // Build full name
    const fullName = body.full_name || 
      (body.first_name && body.last_name ? `${body.first_name} ${body.last_name}` : 
       body.first_name || body.last_name || null);

    // Look for existing client by email or phone
    let existingClient = null;
    
    if (emailNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .ilike('email', emailNormalized)
        .maybeSingle();
      existingClient = data;
    }
    
    if (!existingClient && phoneNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('phone', phoneNormalized)
        .maybeSingle();
      existingClient = data;
    }

    let clientId: string;
    let action: 'created' | 'updated';

    if (existingClient) {
      // Update existing client - only fill nulls, don't overwrite
      const updates: Record<string, unknown> = {};
      
      if (!existingClient.email && emailNormalized) updates.email = emailNormalized;
      if (!existingClient.phone && phoneNormalized) updates.phone = phoneNormalized;
      if (!existingClient.full_name && fullName) updates.full_name = fullName;
      
      // Attribution - only set if not already set
      if (!existingClient.acquisition_source && body.campaign) updates.acquisition_source = source;
      if (!existingClient.acquisition_campaign && body.campaign) updates.acquisition_campaign = body.campaign;
      if (!existingClient.acquisition_medium && body.medium) updates.acquisition_medium = body.medium;
      if (!existingClient.acquisition_content && body.content) updates.acquisition_content = body.content;
      
      // Source IDs
      if (!existingClient.manychat_subscriber_id && body.manychat_subscriber_id) {
        updates.manychat_subscriber_id = body.manychat_subscriber_id;
      }
      if (!existingClient.ghl_contact_id && body.ghl_contact_id) {
        updates.ghl_contact_id = body.ghl_contact_id;
      }
      
      // Merge tags
      if (body.tags && body.tags.length > 0) {
        const existingTags = existingClient.tags || [];
        const newTags = [...new Set([...existingTags, ...body.tags])];
        updates.tags = newTags;
      }

      if (Object.keys(updates).length > 0) {
        updates.last_sync = new Date().toISOString();
        await supabase
          .from('clients')
          .update(updates)
          .eq('id', existingClient.id);
      }

      clientId = existingClient.id;
      action = 'updated';
      console.log(`[${requestId}] Updated existing client: ${clientId}`);
    } else {
      // Create new client as Lead
      const newClient = {
        email: emailNormalized,
        phone: phoneNormalized,
        full_name: fullName,
        lifecycle_stage: 'LEAD',
        status: 'active',
        acquisition_source: source,
        acquisition_campaign: body.campaign || null,
        acquisition_medium: body.medium || null,
        acquisition_content: body.content || null,
        first_seen_at: new Date().toISOString(),
        manychat_subscriber_id: body.manychat_subscriber_id || null,
        ghl_contact_id: body.ghl_contact_id || null,
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

    // Record event for idempotency
    await supabase.from('lead_events').insert({
      source,
      event_id: eventId,
      event_type: action === 'created' ? 'lead_created' : 'lead_updated',
      client_id: clientId,
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
  
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');
  
  // Handle Mexican numbers
  if (digits.length === 10) {
    digits = '52' + digits;
  } else if (digits.startsWith('1') && digits.length === 11) {
    // US number
  } else if (!digits.startsWith('52') && !digits.startsWith('1')) {
    // Assume Mexican if 10+ digits without country code
    if (digits.length >= 10) {
      digits = '52' + digits.slice(-10);
    }
  }
  
  return '+' + digits;
}

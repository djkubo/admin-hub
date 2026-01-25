import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key, x-source',
};

// ============ PAYLOAD INTERFACES ============
interface MarketingContext {
  lead_status?: string;
  tags?: string | string[];
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  [key: string]: unknown;
}

interface LeadPayload {
  event_id?: string;
  source?: string;
  email?: string;
  phone?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  manychat_subscriber_id?: string | number;
  subscriber_id?: string | number;
  external_manychat_id?: string | number;
  ghl_contact_id?: string;
  external_ghl_id?: string;
  // Nested structures from ManyChat
  identities?: Record<string, unknown>;
  demographics?: Record<string, unknown>;
  marketing_context?: MarketingContext;
  engagement?: Record<string, unknown>;
  commercial_data?: Record<string, unknown>;
  // Legacy flat fields
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  campaign?: string;
  tags?: string[] | string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

interface ClientRecord {
  id: string;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  full_name: string | null;
  manychat_subscriber_id: string | null;
  ghl_contact_id: string | null;
  acquisition_source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  tags: string[] | null;
  status: string | null;
  customer_metadata: Record<string, unknown> | null;
  [key: string]: unknown;
}

// ============ HELPER: SANITIZE STRING ============
function sanitizeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  // Handle empty strings, ManyChat placeholders, and null-like values
  if (
    trimmed === '' || 
    trimmed === 'null' || 
    trimmed === 'undefined' ||
    trimmed.startsWith('{{') ||
    trimmed === 'None'
  ) {
    return null;
  }
  return trimmed;
}

// ============ HELPER: NORMALIZE PHONE ============
function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  cleaned = cleaned.replace(/^0+/, '');
  if (cleaned.length === 10) return '+52' + cleaned; // México default
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  if (cleaned.length >= 11) return '+' + cleaned;
  if (cleaned.length >= 10) return '+' + cleaned;
  return null;
}

// ============ HELPER: VALIDATE EMAIL ============
function isValidEmail(email: string | null): boolean {
  if (!email) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

// ============ HELPER: NORMALIZE MANYCHAT ID ============
function normalizeManychatId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '' || str === 'null' || str === 'undefined' || str === '0') return null;
  return str;
}

// ============ HELPER: PARSE TAGS ============
function parseTags(tags: unknown): string[] {
  if (!tags) return [];
  
  // If it's a CSV string, split it
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0 && t !== 'null' && !t.startsWith('{{'));
  }
  
  // If it's an array, sanitize each element
  if (Array.isArray(tags)) {
    return tags
      .map(t => sanitizeString(t))
      .filter((t): t is string => t !== null && t.length > 0);
  }
  
  return [];
}

// ============ HELPER: DEEP MERGE OBJECTS ============
function deepMerge(
  existing: Record<string, unknown> | null | undefined, 
  incoming: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const base = existing || {};
  const updates = incoming || {};
  const result: Record<string, unknown> = { ...base };
  
  for (const key of Object.keys(updates)) {
    const existingVal = base[key];
    const incomingVal = updates[key];
    
    // Skip if incoming is null/undefined/empty
    if (incomingVal === null || incomingVal === undefined || incomingVal === '') {
      continue;
    }
    
    // If both are objects, recurse
    if (
      typeof existingVal === 'object' && existingVal !== null && !Array.isArray(existingVal) &&
      typeof incomingVal === 'object' && incomingVal !== null && !Array.isArray(incomingVal)
    ) {
      result[key] = deepMerge(
        existingVal as Record<string, unknown>, 
        incomingVal as Record<string, unknown>
      );
    } else {
      // Otherwise, take incoming value
      result[key] = incomingVal;
    }
  }
  
  return result;
}

// ============ HELPER: BUILD METADATA FROM PAYLOAD ============
function buildMetadata(payload: LeadPayload): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  
  // Merge nested structures if present
  if (payload.identities && typeof payload.identities === 'object') {
    metadata.identities = payload.identities;
  }
  if (payload.demographics && typeof payload.demographics === 'object') {
    metadata.demographics = payload.demographics;
  }
  if (payload.marketing_context && typeof payload.marketing_context === 'object') {
    metadata.marketing_context = payload.marketing_context;
  }
  if (payload.engagement && typeof payload.engagement === 'object') {
    metadata.engagement = payload.engagement;
  }
  if (payload.commercial_data && typeof payload.commercial_data === 'object') {
    metadata.commercial_data = payload.commercial_data;
  }
  
  // Add import timestamp
  metadata.raw_import = new Date().toISOString();
  
  return metadata;
}

// ============ HELPER: SHOULD UPDATE FIELD ============
function shouldUpdate(existingValue: unknown, newValue: unknown): boolean {
  // Don't update if new value is empty/null
  if (newValue === null || newValue === undefined || newValue === '') return false;
  // Update if existing is empty
  if (existingValue === null || existingValue === undefined || existingValue === '') return true;
  // Update if values are different and new value is meaningful
  return existingValue !== newValue;
}

// ============ PROCESS SINGLE LEAD (SMART DEDUP) ============
async function processLead(
  supabase: SupabaseClient,
  payload: LeadPayload,
  sourceHeader: string,
  requestId: string
): Promise<{ 
  success: boolean; 
  db_id?: string; 
  message: string; 
  action?: string;
  error?: string;
  status_code?: number;
}> {
  
  try {
    console.log(`[${requestId}] Payload received:`, JSON.stringify(payload));
    
    const source = sanitizeString(payload.source) || sourceHeader;
    
    // ===== NORMALIZE INPUTS =====
    const rawEmail = sanitizeString(payload.email);
    const emailNormalized = rawEmail && isValidEmail(rawEmail) ? rawEmail.toLowerCase() : null;
    
    const rawPhone = sanitizeString(payload.phone);
    const phoneNormalized = normalizePhone(rawPhone || undefined);
    
    // ManyChat ID - support multiple field names and coerce to string
    const manychatId = normalizeManychatId(payload.manychat_subscriber_id) ||
                       normalizeManychatId(payload.subscriber_id) ||
                       normalizeManychatId(payload.external_manychat_id);
    
    const ghlId = sanitizeString(payload.ghl_contact_id) || 
                  sanitizeString(payload.external_ghl_id);
    
    // Name handling
    const firstName = sanitizeString(payload.first_name);
    const lastName = sanitizeString(payload.last_name);
    const fullName = sanitizeString(payload.full_name) || 
      (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName);
    
    // Tags - handle CSV or array
    const marketingTags = parseTags(payload.marketing_context?.tags);
    const payloadTags = parseTags(payload.tags);
    const allTags = [...new Set([...marketingTags, ...payloadTags])];
    
    // Status from marketing context or default
    const status = sanitizeString(payload.marketing_context?.lead_status) || 'new';
    
    // UTM fields (from marketing_context or flat)
    const utmSource = sanitizeString(payload.marketing_context?.utm_source) || sanitizeString(payload.utm_source);
    const utmMedium = sanitizeString(payload.marketing_context?.utm_medium) || sanitizeString(payload.utm_medium);
    const utmCampaign = sanitizeString(payload.marketing_context?.utm_campaign) || sanitizeString(payload.utm_campaign) || sanitizeString(payload.campaign);
    const utmContent = sanitizeString(payload.marketing_context?.utm_content) || sanitizeString(payload.utm_content);
    const utmTerm = sanitizeString(payload.marketing_context?.utm_term) || sanitizeString(payload.utm_term);
    
    // Build metadata from nested structures
    const incomingMetadata = buildMetadata(payload);
    
    // ===== DEDUPLICATION LOGIC =====
    let clientByManychat: ClientRecord | null = null;
    let clientByEmail: ClientRecord | null = null;
    
    // Step 1: Search by manychat_subscriber_id if provided
    if (manychatId) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('manychat_subscriber_id', manychatId)
        .maybeSingle();
      clientByManychat = data as ClientRecord | null;
    }
    
    // Step 2: Search by email if provided and valid
    if (emailNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .ilike('email', emailNormalized)
        .maybeSingle();
      clientByEmail = data as ClientRecord | null;
    }
    
    // ===== CONFLICT DETECTION =====
    // If we found DIFFERENT records by manychat_id and email, that's a conflict
    if (clientByManychat && clientByEmail && clientByManychat.id !== clientByEmail.id) {
      const conflictMessage = `CONFLICT: Found different records - ManyChat ID '${manychatId}' matches client ${clientByManychat.id} (${clientByManychat.email}), but email '${emailNormalized}' matches client ${clientByEmail.id}. Manual review required.`;
      console.error(`[${requestId}] ${conflictMessage}`);
      
      return {
        success: false,
        message: conflictMessage,
        error: 'duplicate_conflict',
        status_code: 409
      };
    }
    
    // ===== DETERMINE TARGET CLIENT =====
    // Priority: manychat_id match > email match > create new
    let existingClient = clientByManychat || clientByEmail || null;
    
    // Additional fallback: search by phone if no match yet
    if (!existingClient && phoneNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('phone_e164', phoneNormalized)
        .maybeSingle();
      existingClient = data as ClientRecord | null;
    }
    
    // Fallback to GHL ID
    if (!existingClient && ghlId) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('ghl_contact_id', ghlId)
        .maybeSingle();
      existingClient = data as ClientRecord | null;
    }
    
    let clientId: string;
    let action: 'created' | 'updated';
    
    if (existingClient) {
      // ===== UPDATE EXISTING CLIENT =====
      const updates: Record<string, unknown> = {};
      
      // Only update fields if new value is meaningful and existing is empty/different
      if (shouldUpdate(existingClient.email, emailNormalized)) {
        updates.email = emailNormalized;
      }
      if (shouldUpdate(existingClient.phone, rawPhone)) {
        updates.phone = rawPhone;
      }
      if (shouldUpdate(existingClient.phone_e164, phoneNormalized)) {
        updates.phone_e164 = phoneNormalized;
      }
      if (shouldUpdate(existingClient.full_name, fullName)) {
        updates.full_name = fullName;
      }
      if (shouldUpdate(existingClient.manychat_subscriber_id, manychatId)) {
        updates.manychat_subscriber_id = manychatId;
      }
      if (shouldUpdate(existingClient.ghl_contact_id, ghlId)) {
        updates.ghl_contact_id = ghlId;
      }
      if (shouldUpdate(existingClient.acquisition_source, source)) {
        updates.acquisition_source = source;
      }
      if (shouldUpdate(existingClient.utm_source, utmSource)) {
        updates.utm_source = utmSource;
      }
      if (shouldUpdate(existingClient.utm_medium, utmMedium)) {
        updates.utm_medium = utmMedium;
      }
      if (shouldUpdate(existingClient.utm_campaign, utmCampaign)) {
        updates.utm_campaign = utmCampaign;
      }
      if (shouldUpdate(existingClient.utm_content, utmContent)) {
        updates.utm_content = utmContent;
      }
      if (shouldUpdate(existingClient.utm_term, utmTerm)) {
        updates.utm_term = utmTerm;
      }
      
      // Merge tags (union without duplicates)
      if (allTags.length > 0) {
        const existingTags = existingClient.tags || [];
        const mergedTags = [...new Set([...existingTags, ...allTags])];
        if (mergedTags.length !== existingTags.length || 
            !mergedTags.every((t, i) => existingTags[i] === t)) {
          updates.tags = mergedTags;
        }
      }
      
      // Merge metadata (deep merge with existing)
      const existingMetadata = existingClient.customer_metadata || {};
      const mergedMetadata = deepMerge(existingMetadata, incomingMetadata);
      updates.customer_metadata = mergedMetadata;
      
      // Always update timestamps
      updates.last_lead_at = new Date().toISOString();
      updates.last_sync = new Date().toISOString();
      
      // Update status only if currently empty
      if (!existingClient.status && status) {
        updates.status = status;
      }
      
      const { error } = await supabase
        .from('clients')
        .update(updates)
        .eq('id', existingClient.id);
      
      if (error) {
        console.error(`[${requestId}] DB update error:`, error);
        throw new Error(`Database update failed: ${error.message}`);
      }
      
      clientId = existingClient.id;
      action = 'updated';
      console.log(`[${requestId}] Updated client ${clientId}, fields: ${Object.keys(updates).join(', ')}`);
      
    } else {
      // ===== CREATE NEW CLIENT =====
      const newClient = {
        email: emailNormalized,
        phone: rawPhone,
        phone_e164: phoneNormalized,
        full_name: fullName,
        lifecycle_stage: 'LEAD',
        lead_status: 'lead',
        status: status || 'new',
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
        tags: allTags.length > 0 ? allTags : null,
        customer_metadata: incomingMetadata,
      };
      
      const { data: created, error } = await supabase
        .from('clients')
        .insert(newClient)
        .select('id')
        .single();
      
      if (error) {
        console.error(`[${requestId}] DB insert error:`, error);
        throw new Error(`Database insert failed: ${error.message}`);
      }
      
      clientId = (created as { id: string }).id;
      action = 'created';
      console.log(`[${requestId}] Created new client ${clientId}`);
    }
    
    // ===== RECORD LEAD EVENT (for audit trail) =====
    const eventId = sanitizeString(payload.event_id) || 
      manychatId || 
      ghlId || 
      `${source}_${emailNormalized || phoneNormalized}_${Date.now()}`;
    
    await supabase.from('lead_events').insert({
      source,
      event_id: eventId,
      event_type: action === 'created' ? 'lead_created' : 'lead_updated',
      client_id: clientId,
      email: emailNormalized,
      phone: phoneNormalized,
      full_name: fullName,
      payload: payload,
    });
    
    return {
      success: true,
      db_id: clientId,
      message: action === 'created' ? 'Lead created successfully' : 'Lead updated successfully',
      action
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${requestId}] Lead processing error:`, errorMessage);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage,
      status_code: 400
    };
  }
}

// ============ BATCH PROCESSOR ============
async function processBatch(
  supabase: SupabaseClient,
  leads: LeadPayload[],
  sourceHeader: string,
  requestId: string
): Promise<{ 
  processed: number; 
  created: number; 
  updated: number; 
  skipped: number; 
  conflicts: number;
  errors: number; 
  errorDetails: string[];
}> {
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;
  let errors = 0;
  const errorDetails: string[] = [];

  // Process in parallel batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(lead => processLead(supabase, lead, sourceHeader, requestId))
    );
    
    for (const result of results) {
      processed++;
      if (!result.success) {
        if (result.status_code === 409) {
          conflicts++;
        } else {
          errors++;
        }
        if (errorDetails.length < 20) {
          errorDetails.push(result.message || 'Unknown error');
        }
      } else if (result.action === 'created') {
        created++;
      } else if (result.action === 'updated') {
        updated++;
      } else {
        skipped++;
      }
    }
    
    if (processed % 100 === 0) {
      console.log(`[${requestId}] Progress: ${processed}/${leads.length} (${created} created, ${updated} updated, ${skipped} skipped, ${conflicts} conflicts, ${errors} errors)`);
    }
  }

  console.log(`[${requestId}] BATCH COMPLETE: ${processed} processed, ${created} created, ${updated} updated, ${skipped} skipped, ${conflicts} conflicts, ${errors} errors`);
  return { processed, created, updated, skipped, conflicts, errors, errorDetails };
}

// ============ MAIN HANDLER ============
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  
  console.log(`[${requestId}] receive-lead: Start`);

  try {
    // Security check
    const adminKey = Deno.env.get('ADMIN_API_KEY');
    const providedKey = req.headers.get('x-admin-key');
    
    if (!adminKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Service not configured', code: 'MISSING_SECRET' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!providedKey || providedKey !== adminKey) {
      console.warn(`[${requestId}] Invalid/missing X-ADMIN-KEY`);
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const sourceHeader = req.headers.get('x-source') || 'manychat';
    
    let body: LeadPayload | { leads: LeadPayload[] };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ============ BATCH MODE ============
    if ('leads' in body && Array.isArray(body.leads)) {
      const leads: LeadPayload[] = body.leads;
      const totalLeads = leads.length;
      
      if (totalLeads === 0) {
        return new Response(
          JSON.stringify({ success: true, message: 'No leads to process' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      console.log(`[${requestId}] BATCH MODE: Processing ${totalLeads} leads`);

      // Process batch synchronously (no background continuation)
      const result = await processBatch(supabase, leads, sourceHeader, requestId);
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Completed in ${duration}ms`);

      return new Response(
        JSON.stringify({ success: true, mode: 'sync', duration_ms: duration, ...result }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============ SINGLE LEAD MODE ============
    const result = await processLead(supabase, body as LeadPayload, sourceHeader, requestId);
    
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Completed in ${duration}ms - Action: ${result.action || 'none'}`);

    // Return the response format ManyChat expects
    const statusCode = result.status_code || (result.success ? 200 : 400);
    
    return new Response(
      JSON.stringify({ 
        success: result.success, 
        db_id: result.db_id,
        message: result.message,
        action: result.action,
        error: result.error,
        duration_ms: duration
      }),
      { status: statusCode, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error(`[${requestId}] Error:`, error);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

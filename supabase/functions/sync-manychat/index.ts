import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Declare EdgeRuntime global for Supabase Edge Functions
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// deno-lint-ignore no-explicit-any
type SupabaseClient = ReturnType<typeof createClient<any>>;

// ============= SECURITY =============
// This function reads/writes sensitive contact data. Require:
// - an authenticated admin user (JWT + is_admin())
// - OR service_role (for internal background chaining).
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

interface ManyChatSubscriber {
  id: string;
  email?: string;
  phone?: string;
  whatsapp_phone?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  tags?: Array<{ name: string; id?: number } | string>;
  optin_email?: boolean;
  optin_sms?: boolean;
  optin_whatsapp?: boolean;
  custom_fields?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  subscribed?: string;
  last_interaction?: string;
}

interface ManyChatTag {
  id: number;
  name: string;
}

const logger = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : ''),
};

// Rate limiter: 10 requests per second, with pause between bursts
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_PAUSE_MS = 1100;
const TAGS_PER_CHUNK = 5; // Process 5 tags per function invocation

// Fetch all tags from ManyChat page
async function fetchAllTags(apiKey: string): Promise<ManyChatTag[]> {
  logger.info('Fetching all tags from ManyChat');
  
  const response = await fetch('https://api.manychat.com/fb/page/getTags', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Failed to fetch tags', { status: response.status, error: errorText });
    throw new Error(`Failed to fetch tags: ${response.status}`);
  }
  
  const data = await response.json();
  const tags = data?.data || [];
  logger.info(`Found ${tags.length} tags in ManyChat`);
  
  return tags;
}

// Fetch subscribers by tag ID
async function fetchSubscribersByTag(apiKey: string, tagId: number, tagName: string): Promise<ManyChatSubscriber[]> {
  logger.info(`Fetching subscribers for tag: ${tagName} (ID: ${tagId})`);
  
  try {
    const response = await fetch(
      `https://api.manychat.com/fb/subscriber/findByCustomField`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          field_name: 'tag',
          field_value: tagName,
        }),
      }
    );
    
    if (!response.ok) {
      // Try alternative endpoint
      const altResponse = await fetch(
        `https://api.manychat.com/fb/subscriber/findBySystemField?field_name=tag&field_value=${encodeURIComponent(tagName)}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      
      if (!altResponse.ok) {
        logger.warn(`Could not fetch subscribers for tag ${tagName}`, { status: altResponse.status });
        return [];
      }
      
      const altData = await altResponse.json();
      return altData?.data ? [altData.data] : [];
    }
    
    const data = await response.json();
    const subscribers = Array.isArray(data?.data) ? data.data : (data?.data ? [data.data] : []);
    logger.info(`Found ${subscribers.length} subscribers for tag ${tagName}`);
    
    return subscribers;
  } catch (error) {
    logger.warn(`Error fetching subscribers for tag ${tagName}`, { error: String(error) });
    return [];
  }
}

// Process a chunk of tags and store subscribers
async function processTagChunk(
  apiKey: string,
  supabase: SupabaseClient,
  tags: ManyChatTag[],
  syncRunId: string
): Promise<{ total: number; stored: number }> {
  const allSubscribers = new Map<string, ManyChatSubscriber>();
  
  for (const tag of tags) {
    const subscribers = await fetchSubscribersByTag(apiKey, tag.id, tag.name);
    
    for (const sub of subscribers) {
      if (sub.id && !allSubscribers.has(sub.id)) {
        allSubscribers.set(sub.id, sub);
      }
    }
    
    // Rate limit pause between tag fetches
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  logger.info(`Total unique subscribers found in chunk: ${allSubscribers.size}`);
  
  // Store in manychat_contacts_raw
  const subscribersArray = Array.from(allSubscribers.values());
  let storedCount = 0;
  
  const BATCH_SIZE = 50;
  for (let i = 0; i < subscribersArray.length; i += BATCH_SIZE) {
    const batch = subscribersArray.slice(i, i + BATCH_SIZE);
    
    const records = batch.map(sub => ({
      subscriber_id: sub.id,
      payload: sub,
      fetched_at: new Date().toISOString(),
      sync_run_id: syncRunId,
      processed_at: null
    }));
    
    // Use delete/insert pattern to avoid constraint conflicts
    const subscriberIds = records.map(r => r.subscriber_id);
    
    await supabase
      .from('manychat_contacts_raw')
      .delete()
      .in('subscriber_id', subscriberIds);
    
    const { error } = await supabase
      .from('manychat_contacts_raw')
      .insert(records);
    
    if (error) {
      logger.error('Error inserting batch', { error: error.message, batch: i });
    } else {
      storedCount += records.length;
    }
  }
  
  return { total: allSubscribers.size, stored: storedCount };
}

// Check if paused
async function checkIfPaused(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'manychat_paused')
    .maybeSingle();
  
  return data?.value === true || data?.value === 'true';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const auth = await verifyAdminOrServiceRole(req);
  if (!auth.valid) {
    return new Response(
      JSON.stringify({ ok: false, success: false, error: auth.error || "Forbidden" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const manychatApiKey = Deno.env.get('MANYCHAT_API_KEY');
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  try {
    const body = await req.json().catch(() => ({}));
    
    // Test-only mode: quick API verification
    if (body.testOnly === true) {
      logger.info('Test-only mode: Verifying ManyChat API connection');
      
      if (!manychatApiKey) {
        return new Response(JSON.stringify({
          ok: false,
          success: false,
          error: 'MANYCHAT_API_KEY not configured',
          testOnly: true
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // Quick test: fetch page info
      const testResponse = await fetch('https://api.manychat.com/fb/page/getInfo', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${manychatApiKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      const isOk = testResponse.ok;
      
      return new Response(JSON.stringify({
        ok: isOk,
        success: isOk,
        status: isOk ? 'connected' : 'error',
        apiStatus: testResponse.status,
        testOnly: true
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Check kill switch
    const isPaused = await checkIfPaused(supabase);
    if (isPaused) {
      logger.info('ManyChat sync is paused via kill switch');
      return new Response(JSON.stringify({
        ok: false,
        error: 'ManyChat sincronización está pausada. Actívala en Configuración del Sistema.',
        paused: true
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    if (!manychatApiKey) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'MANYCHAT_API_KEY not configured'
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Parse continuation parameters
    const syncRunId = body.syncRunId || null;
    const tagOffset = body.tagOffset || 0;
    const allTags: ManyChatTag[] = body.allTags || [];
    const accumulatedTotal = body.accumulatedTotal || 0;
    const accumulatedStored = body.accumulatedStored || 0;
    
    let currentSyncRunId = syncRunId;
    let tags = allTags;
    
    // If no syncRunId, this is a fresh start - fetch all tags and create sync run
    if (!currentSyncRunId) {
      logger.info('Starting fresh ManyChat sync');
      
      // Fetch all tags first
      tags = await fetchAllTags(manychatApiKey);
      
      if (tags.length === 0) {
        return new Response(JSON.stringify({
          ok: true,
          success: true,
          status: 'completed',
          message: 'No tags found in ManyChat',
          total: 0,
          stored: 0
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // Create sync run
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .insert({
          source: 'manychat',
          status: 'running',
          checkpoint: { tagOffset: 0, totalTags: tags.length },
          metadata: { totalTags: tags.length }
        })
        .select('id')
        .single();
      
      currentSyncRunId = syncRun?.id;
    }
    
    // Check if cancelled
    const { data: syncCheck } = await supabase
      .from('sync_runs')
      .select('status')
      .eq('id', currentSyncRunId!)
      .single();
    
    if (syncCheck?.status === 'canceled' || syncCheck?.status === 'cancelled') {
      logger.info('Sync was cancelled', { syncRunId: currentSyncRunId });
      return new Response(JSON.stringify({
        ok: false,
        status: 'canceled',
        error: 'Sync was cancelled by user'
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Process current chunk of tags
    const tagsToProcess = tags.slice(tagOffset, tagOffset + TAGS_PER_CHUNK);
    const result = await processTagChunk(manychatApiKey, supabase, tagsToProcess, currentSyncRunId!);
    
    const newAccumulatedTotal = accumulatedTotal + result.total;
    const newAccumulatedStored = accumulatedStored + result.stored;
    const nextOffset = tagOffset + TAGS_PER_CHUNK;
    const hasMore = nextOffset < tags.length;
    
    if (hasMore) {
      // Update sync run with progress
      const { data: progressRows } = await supabase
        .from('sync_runs')
        .update({
          status: 'continuing',
          total_fetched: newAccumulatedTotal,
          total_inserted: newAccumulatedStored,
          checkpoint: {
            tagOffset: nextOffset,
            totalTags: tags.length,
            lastActivity: new Date().toISOString()
          }
        })
        .eq('id', currentSyncRunId)
        // Don't override user cancellation
        .in('status', ['running', 'continuing'])
        .select('id');

      if (!progressRows || progressRows.length === 0) {
        logger.info('Sync not active (likely cancelled); stopping before scheduling next chunk', { syncRunId: currentSyncRunId });
        return new Response(JSON.stringify({
          ok: false,
          status: 'cancelled',
          error: 'Sync was cancelled by user',
          syncRunId: currentSyncRunId
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // CRITICAL: Use EdgeRuntime.waitUntil for background processing
      const nextChunkUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/sync-manychat`;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const invokeNextChunk = async () => {
        try {
          await fetch(nextChunkUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify({
              syncRunId: currentSyncRunId,
              tagOffset: nextOffset,
              allTags: tags,
              accumulatedTotal: newAccumulatedTotal,
              accumulatedStored: newAccumulatedStored
            })
          });
        } catch (err) {
          logger.error('Failed to invoke next ManyChat chunk', { error: String(err) });
        }
      };
      
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(invokeNextChunk());
      } else {
        invokeNextChunk();
      }
      
      return new Response(JSON.stringify({
        ok: true,
        success: true,
        status: 'continuing',
        syncRunId: currentSyncRunId,
        processed: newAccumulatedTotal,
        stored: newAccumulatedStored,
        progress: `${nextOffset}/${tags.length} tags`,
        hasMore: true,
        backgroundProcessing: true,
        message: 'ManyChat sync continues in background.'
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Sync complete
    const { data: completedRows } = await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: newAccumulatedTotal,
        total_inserted: newAccumulatedStored
      })
      .eq('id', currentSyncRunId)
      // Don't override user cancellation
      .in('status', ['running', 'continuing'])
      .select('id');

    if (!completedRows || completedRows.length === 0) {
      logger.info('Sync not marked completed (likely cancelled); stopping', { syncRunId: currentSyncRunId });
      return new Response(JSON.stringify({
        ok: false,
        status: 'cancelled',
        error: 'Sync was cancelled by user',
        syncRunId: currentSyncRunId
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    logger.info(`=== ManyChat Sync Complete: ${newAccumulatedStored} stored ===`);
    
    // AUTO-UNIFY: Trigger identity unification in background after sync completes
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const triggerUnification = async () => {
      try {
        logger.info('Triggering automatic identity unification after ManyChat sync');
        await fetch(`${supabaseUrl}/functions/v1/bulk-unify-contacts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`
          },
          body: JSON.stringify({
            source: 'manychat',
            autoTriggered: true
          })
        });
        logger.info('Auto-unification triggered successfully');
      } catch (err) {
        logger.warn('Failed to trigger auto-unification', { error: String(err) });
      }
    };
    
    // Fire-and-forget unification trigger
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(triggerUnification());
    } else {
      triggerUnification();
    }
    
    return new Response(JSON.stringify({
      ok: true,
      success: true,
      status: 'completed',
      syncRunId: currentSyncRunId,
      total: newAccumulatedTotal,
      stored: newAccumulatedStored,
      autoUnifyTriggered: true,
      message: `Fetched ${newAccumulatedTotal} subscribers, stored ${newAccumulatedStored} in staging. Auto-unification triggered.`
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Fatal error in sync-manychat', { error: errorMessage });
    
    return new Response(JSON.stringify({
      ok: false,
      success: false,
      error: errorMessage
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SyncRequest {
  dry_run?: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const manychatApiKey = Deno.env.get('MANYCHAT_API_KEY');

    if (!manychatApiKey) {
      return new Response(
        JSON.stringify({ 
          success: false,
          error: 'MANYCHAT_API_KEY required',
          help: 'Add your ManyChat API key in Settings → Secrets'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: SyncRequest = await req.json().catch(() => ({}));
    const dryRun = body.dry_run ?? false;

    console.log(`[sync-manychat] Starting sync, dry_run=${dryRun}`);

    // Create sync run
    const { data: syncRun, error: syncError } = await supabase
      .from('sync_runs')
      .insert({
        source: 'manychat',
        status: 'running',
        dry_run: dryRun,
        metadata: { method: 'subscriber_search_get' }
      })
      .select()
      .single();

    if (syncError) {
      console.error('[sync-manychat] Failed to create sync run:', syncError);
      throw syncError;
    }

    const syncRunId = syncRun.id;
    let totalFetched = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalConflicts = 0;

    // Get all clients with emails that might be in ManyChat
    const { data: existingClients, error: clientsError } = await supabase
      .from('clients')
      .select('email, phone, manychat_subscriber_id')
      .not('email', 'is', null)
      .is('manychat_subscriber_id', null)
      .limit(200);

    if (clientsError) {
      console.error('[sync-manychat] Error fetching clients:', clientsError);
    }

    const emailsToSearch = existingClients?.filter(c => c.email).map(c => c.email!) || [];
    
    console.log(`[sync-manychat] Found ${emailsToSearch.length} clients to search in ManyChat`);

    // Search ManyChat for each email using GET with query params
    for (const email of emailsToSearch.slice(0, 100)) {
      try {
        // Use GET request with query parameters - correct ManyChat API format
        const encodedEmail = encodeURIComponent(email);
        const searchResponse = await fetch(
          `https://api.manychat.com/fb/subscriber/findBySystemField?field_name=email&field_value=${encodedEmail}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${manychatApiKey}`,
              'Accept': 'application/json'
            }
          }
        );

        if (!searchResponse.ok) {
          const status = searchResponse.status;
          if (status === 404 || status === 400) {
            // Not found in ManyChat or invalid email
            totalSkipped++;
            continue;
          }
          console.error(`[sync-manychat] Search error for ${email}: ${status}`);
          totalSkipped++;
          continue;
        }

        const searchData = await searchResponse.json();
        
        if (searchData.status !== 'success' || !searchData.data) {
          totalSkipped++;
          continue;
        }

        const subscriber = searchData.data;
        totalFetched++;
        console.log(`[sync-manychat] Found subscriber ${subscriber.id} for ${email}`);

        // Store raw data for audit
        if (!dryRun) {
          await supabase
            .from('manychat_contacts_raw')
            .upsert({
              subscriber_id: subscriber.id,
              payload: subscriber,
              sync_run_id: syncRunId,
              fetched_at: new Date().toISOString()
            }, { onConflict: 'subscriber_id' });
        }

        // Extract fields
        const subEmail = subscriber.email || email;
        const phone = subscriber.phone || subscriber.whatsapp_phone || null;
        const fullName = [subscriber.first_name, subscriber.last_name].filter(Boolean).join(' ') || subscriber.name || null;
        const tags = (subscriber.tags || []).map((t: any) => t.name || t);
        const waOptIn = subscriber.optin_whatsapp === true;
        const smsOptIn = subscriber.optin_sms === true;
        const emailOptIn = subscriber.optin_email !== false;

        // Call merge function
        const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_contact', {
          p_source: 'manychat',
          p_external_id: subscriber.id,
          p_email: subEmail,
          p_phone: phone,
          p_full_name: fullName,
          p_tags: tags,
          p_wa_opt_in: waOptIn,
          p_sms_opt_in: smsOptIn,
          p_email_opt_in: emailOptIn,
          p_extra_data: subscriber,
          p_dry_run: dryRun,
          p_sync_run_id: syncRunId
        });

        if (mergeError) {
          console.error(`[sync-manychat] Merge error for ${subscriber.id}:`, mergeError);
          totalSkipped++;
          continue;
        }

        const action = mergeResult?.action || 'none';
        if (action === 'inserted') totalInserted++;
        else if (action === 'updated') totalUpdated++;
        else if (action === 'conflict') totalConflicts++;
        else totalSkipped++;

        // Rate limit: ManyChat allows ~10 requests/second
        await new Promise(resolve => setTimeout(resolve, 150));

      } catch (subError) {
        console.error(`[sync-manychat] Error for ${email}:`, subError);
        totalSkipped++;
      }
    }

    // Mark sync as complete
    await supabase
      .from('sync_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        metadata: { 
          method: 'subscriber_search_get',
          emails_searched: Math.min(emailsToSearch.length, 100)
        }
      })
      .eq('id', syncRunId);

    console.log(`[sync-manychat] Completed: ${totalFetched} found, ${totalInserted} inserted, ${totalUpdated} updated`);

    return new Response(
      JSON.stringify({
        success: true,
        sync_run_id: syncRunId,
        dry_run: dryRun,
        stats: {
          emails_searched: Math.min(emailsToSearch.length, 100),
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts
        },
        note: totalFetched === 0 
          ? 'No matches found. Make sure your ManyChat subscribers have the same emails as your clients, or use the receive-lead webhook for real-time sync.'
          : `Found ${totalFetched} subscribers matching your client emails.`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[sync-manychat] Error:', error);
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error.message || 'Unknown error',
        help: 'For real-time sync, configure ManyChat to send webhooks to your receive-lead endpoint.'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

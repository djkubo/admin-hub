// Edge Function: merge-staged-imports
// Background processing of staged CSV data
// Runs identity unification and merges into clients table
// Called AFTER all chunks are staged

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { createLogger, LogLevel } from '../_shared/logger.ts';

// Declare EdgeRuntime for TypeScript
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('merge-staged-imports', LogLevel.INFO);

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// Parse JWT claims without external call - JWT is base64 encoded
function parseJwtClaims(token: string): { sub?: string; email?: string; exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  
  if (!authHeader) {
    logger.warn('No Authorization header present');
    return { valid: false, error: 'Missing Authorization header' };
  }
  
  if (!authHeader.startsWith('Bearer ')) {
    logger.warn('Invalid Authorization format');
    return { valid: false, error: 'Invalid Authorization format' };
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token || token.length < 10) {
    logger.warn('Token appears invalid', { tokenLength: token?.length });
    return { valid: false, error: 'Invalid token format' };
  }

  // Parse JWT claims locally first
  const claims = parseJwtClaims(token);
  if (!claims || !claims.sub) {
    logger.warn('Failed to parse JWT claims');
    return { valid: false, error: 'Invalid token structure' };
  }

  if (claims.exp && claims.exp * 1000 < Date.now()) {
    logger.warn('Token has expired', { exp: new Date(claims.exp * 1000).toISOString() });
    return { valid: false, error: 'Token expired' };
  }

  logger.info('JWT claims parsed', { userId: claims.sub, email: claims.email });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  // deno-lint-ignore no-explicit-any
  const { data: isAdmin, error: adminError } = await (supabase as any).rpc('is_admin');
  
  if (adminError) {
    logger.warn('Admin check failed', { error: adminError.message, code: adminError.code });
    return { valid: false, error: `Admin verification failed: ${adminError.message}` };
  }
  
  if (!isAdmin) {
    logger.warn('User is not admin', { userId: claims.sub });
    return { valid: false, error: 'Not authorized as admin' };
  }

  logger.info('Admin verified successfully', { userId: claims.sub });
  return { valid: true, userId: claims.sub };
}

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 10) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function normalizeAmount(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100);
}

// Background merge processing
async function processMergeInBackground(
  importId: string,
  supabase: AnySupabaseClient
): Promise<void> {
  logger.info('Starting background merge', { importId });
  
  try {
    // Update status to processing
    await supabase.from('csv_import_runs').update({
      status: 'processing'
    }).eq('id', importId);

    // Get import run details
    const { data: importRun } = await supabase
      .from('csv_import_runs')
      .select('source_type, total_rows')
      .eq('id', importId)
      .single();

    const sourceType = importRun?.source_type || 'auto';

    // Process in batches to avoid memory issues
    const BATCH_SIZE = 500;
    let offset = 0;
    let mergedCount = 0;
    let conflictCount = 0;
    let errorCount = 0;
    let hasMore = true;

    while (hasMore) {
      // Fetch batch of pending rows
      const { data: pendingRows, error: fetchError } = await supabase
        .from('csv_imports_raw')
        .select('*')
        .eq('import_id', importId)
        .eq('processing_status', 'pending')
        .order('row_number', { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1);

      if (fetchError) {
        throw new Error(`Failed to fetch staged rows: ${fetchError.message}`);
      }

      if (!pendingRows || pendingRows.length === 0) {
        hasMore = false;
        break;
      }

      logger.info('Processing batch', { 
        importId, 
        offset, 
        batchSize: pendingRows.length,
        totalProcessed: mergedCount + conflictCount + errorCount
      });

      // Group by email for deduplication
      const emailGroups = new Map<string, typeof pendingRows>();
      const phoneOnlyRows: typeof pendingRows = [];

      for (const row of pendingRows) {
        if (row.email) {
          const existing = emailGroups.get(row.email) || [];
          existing.push(row);
          emailGroups.set(row.email, existing);
        } else if (row.phone) {
          phoneOnlyRows.push(row);
        } else {
          // Skip rows without email or phone
          await supabase.from('csv_imports_raw').update({
            processing_status: 'skipped',
            error_message: 'No email or phone',
            processed_at: new Date().toISOString()
          }).eq('id', row.id);
          errorCount++;
        }
      }

      // Batch lookup existing clients by email
      const emails = [...emailGroups.keys()];
      const { data: existingClients } = await supabase
        .from('clients')
        .select('id, email, ghl_contact_id, stripe_customer_id, phone_e164, total_spend, tags')
        .in('email', emails.length > 0 ? emails : ['__none__']);

      const existingByEmail = new Map(
        (existingClients || []).map(c => [c.email, c])
      );

      // Process each email group
      const clientsToUpsert: Record<string, unknown>[] = [];
      const rowUpdates: { id: string; status: string; clientId?: string; error?: string }[] = [];

      for (const [email, rows] of emailGroups) {
        // Merge all rows for this email
        const mergedData: Record<string, unknown> = { email };
        let ghlContactId: string | null = null;
        let stripeCustomerId: string | null = null;
        let paypalCustomerId: string | null = null;
        let manychatSubscriberId: string | null = null;
        let totalSpend = 0;
        const tags: string[] = [];
        let phone: string | null = null;
        let fullName: string | null = null;

        for (const row of rows) {
          const rawData = row.raw_data as Record<string, string>;
          
          // Extract common fields
          if (!fullName && row.full_name) {
            fullName = row.full_name;
          }
          if (!phone && row.phone) {
            phone = normalizePhone(row.phone);
          }

          // GHL fields
          const ghlId = rawData['cnt_contact id'] || rawData['Contact Id'] || rawData['ghl_contact_id'];
          if (ghlId) ghlContactId = ghlId;
          
          // Stripe fields
          const stripeId = rawData['st_customer id'] || rawData['Customer'] || rawData['stripe_customer_id'];
          if (stripeId) stripeCustomerId = stripeId;

          // PayPal fields
          const paypalId = rawData['pp_payer_id'] || rawData['Payer Id'];
          if (paypalId) paypalCustomerId = paypalId;

          // ManyChat fields
          const manychatId = rawData['subscriber_id'] || rawData['manychat_subscriber_id'];
          if (manychatId) manychatSubscriberId = manychatId;

          // Accumulate spend
          const spend = normalizeAmount(
            rawData['auto_total_spend'] || rawData['total_spend'] || rawData['Total Spend'] || '0'
          );
          if (spend > totalSpend) totalSpend = spend;

          // Merge tags
          const rowTags = (rawData['cnt_tags'] || rawData['Tags'] || rawData['tags'] || '')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);
          tags.push(...rowTags);
        }

        // Build upsert record
        const existing = existingByEmail.get(email);
        
        if (fullName) mergedData.full_name = fullName;
        if (phone) mergedData.phone_e164 = phone;
        if (ghlContactId) mergedData.ghl_contact_id = ghlContactId;
        if (stripeCustomerId) mergedData.stripe_customer_id = stripeCustomerId;
        if (paypalCustomerId) mergedData.paypal_customer_id = paypalCustomerId;
        if (manychatSubscriberId) mergedData.manychat_subscriber_id = manychatSubscriberId;
        
        // Preserve existing spend if higher
        const existingSpend = existing?.total_spend || 0;
        if (totalSpend > existingSpend) {
          mergedData.total_spend = totalSpend;
        }
        
        // Merge tags with existing
        const existingTags = existing?.tags || [];
        const allTags = [...new Set([...existingTags, ...tags])];
        if (allTags.length > 0) {
          mergedData.tags = allTags;
        }
        
        mergedData.lifecycle_stage = (totalSpend > 0 || existingSpend > 0) ? 'CUSTOMER' : 'LEAD';
        mergedData.last_sync = new Date().toISOString();

        clientsToUpsert.push(mergedData);

        // Mark rows as processed
        for (const row of rows) {
          rowUpdates.push({
            id: row.id,
            status: 'merged',
            clientId: existing?.id
          });
        }
      }

      // Handle phone-only rows (try to match by phone)
      for (const row of phoneOnlyRows) {
        const normalizedPhone = normalizePhone(row.phone || '');
        if (!normalizedPhone) {
          rowUpdates.push({ id: row.id, status: 'skipped', error: 'Invalid phone' });
          errorCount++;
          continue;
        }

        // Check if client exists with this phone
        const { data: phoneMatch } = await supabase
          .from('clients')
          .select('id, email')
          .eq('phone_e164', normalizedPhone)
          .limit(1)
          .single();

        if (phoneMatch) {
          // Update existing client
          const rawData = row.raw_data as Record<string, string>;
          const updateData: Record<string, unknown> = {
            last_sync: new Date().toISOString()
          };

          const ghlId = rawData['cnt_contact id'] || rawData['Contact Id'];
          if (ghlId) updateData.ghl_contact_id = ghlId;

          await supabase.from('clients').update(updateData).eq('id', phoneMatch.id);
          rowUpdates.push({ id: row.id, status: 'merged', clientId: phoneMatch.id });
          mergedCount++;
        } else {
          // Create new client with phone only
          const rawData = row.raw_data as Record<string, string>;
          const newClient = {
            phone_e164: normalizedPhone,
            full_name: row.full_name,
            ghl_contact_id: rawData['cnt_contact id'] || rawData['Contact Id'],
            lifecycle_stage: 'LEAD',
            last_sync: new Date().toISOString()
          };

          const { error: insertError } = await supabase.from('clients').insert(newClient);
          if (insertError) {
            rowUpdates.push({ id: row.id, status: 'error', error: insertError.message });
            errorCount++;
          } else {
            rowUpdates.push({ id: row.id, status: 'merged' });
            mergedCount++;
          }
        }
      }

      // Upsert clients
      if (clientsToUpsert.length > 0) {
        const { error: upsertError } = await supabase
          .from('clients')
          .upsert(clientsToUpsert, { onConflict: 'email' });

        if (upsertError) {
          logger.error('Client upsert failed', upsertError);
          for (const update of rowUpdates) {
            if (update.status === 'merged') {
              update.status = 'error';
              update.error = upsertError.message;
              errorCount++;
            }
          }
        } else {
          mergedCount += clientsToUpsert.length;
        }
      }

      // Update staging rows status
      for (const update of rowUpdates) {
        await supabase.from('csv_imports_raw').update({
          processing_status: update.status,
          merged_client_id: update.clientId,
          error_message: update.error,
          processed_at: new Date().toISOString()
        }).eq('id', update.id);
      }

      offset += BATCH_SIZE;

      // Log progress
      logger.info('Merge progress', {
        importId,
        processed: offset,
        merged: mergedCount,
        conflicts: conflictCount,
        errors: errorCount
      });
    }

    // Update import run with final stats
    await supabase.from('csv_import_runs').update({
      rows_merged: mergedCount,
      rows_conflict: conflictCount,
      rows_error: errorCount,
      status: 'completed',
      completed_at: new Date().toISOString()
    }).eq('id', importId);

    logger.info('Background merge complete', {
      importId,
      merged: mergedCount,
      conflicts: conflictCount,
      errors: errorCount
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Background merge failed', error instanceof Error ? error : new Error(errMsg));
    await supabase.from('csv_import_runs').update({
      status: 'failed',
      error_message: errMsg,
      completed_at: new Date().toISOString()
    }).eq('id', importId);
  }
}

// ============= MAIN HANDLER =============
Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify admin
    const auth = await verifyAdmin(req);
    if (!auth.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request
    const body = await req.json();
    const { importId } = body;

    if (!importId) {
      return new Response(
        JSON.stringify({ ok: false, error: 'No import ID provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Merge requested', { importId });

    // Create service role client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify import exists and is in staged status
    const { data: importRun, error: runError } = await supabase
      .from('csv_import_runs')
      .select('*')
      .eq('id', importId)
      .single();

    if (runError || !importRun) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Import not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (importRun.status === 'processing') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Import is already being processed' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (importRun.status === 'completed') {
      return new Response(
        JSON.stringify({ ok: true, message: 'Import already completed', ...importRun }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Start background merge
    EdgeRuntime.waitUntil(processMergeInBackground(importId, supabase));

    // Return immediately
    return new Response(
      JSON.stringify({
        ok: true,
        message: 'Merge started in background',
        importId,
        status: 'processing',
        totalRows: importRun.rows_staged
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Merge request failed', error instanceof Error ? error : new Error(errMsg));
    
    return new Response(
      JSON.stringify({ ok: false, error: errMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

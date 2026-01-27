// Edge Function: process-csv-bulk
// ULTRA-FAST Staging: Only INSERT, no merge, no validation
// Designed to complete in <10 seconds for 500-row chunks
// Phase 2 (merge) is handled by separate merge-staged-imports function

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('process-csv-bulk', LogLevel.INFO);

type CSVType = 'ghl' | 'stripe_payments' | 'stripe_customers' | 'paypal' | 'subscriptions' | 'master' | 'auto';

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// Parse JWT claims without external call - JWT is base64 encoded
function parseJwtClaims(token: string): { sub?: string; email?: string; exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    // Base64 decode the payload
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
    logger.warn('Invalid Authorization format', { prefix: authHeader.substring(0, 20) });
    return { valid: false, error: 'Invalid Authorization format' };
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token || token.length < 10) {
    logger.warn('Token appears invalid', { tokenLength: token?.length });
    return { valid: false, error: 'Invalid token format' };
  }

  // Parse JWT claims locally first to validate structure
  const claims = parseJwtClaims(token);
  if (!claims || !claims.sub) {
    logger.warn('Failed to parse JWT claims');
    return { valid: false, error: 'Invalid token structure' };
  }

  // Check if token is expired
  if (claims.exp && claims.exp * 1000 < Date.now()) {
    logger.warn('Token has expired', { exp: new Date(claims.exp * 1000).toISOString() });
    return { valid: false, error: 'Token expired' };
  }

  logger.info('JWT claims parsed', { userId: claims.sub, email: claims.email });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  // Create client with the auth header for RLS
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  // Verify admin status using RPC (this validates the token server-side)
  // deno-lint-ignore no-explicit-any
  const { data: isAdmin, error: adminError } = await (supabase as any).rpc('is_admin');
  
  if (adminError) {
    logger.warn('Admin check failed', { error: adminError.message, code: adminError.code });
    // If admin check fails, it means the token is invalid
    return { valid: false, error: `Admin verification failed: ${adminError.message}` };
  }
  
  if (!isAdmin) {
    logger.warn('User is not admin', { userId: claims.sub });
    return { valid: false, error: 'Not authorized as admin' };
  }

  logger.info('Admin verified successfully', { userId: claims.sub });
  return { valid: true, userId: claims.sub };
}

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findColumnIndex(headers: string[], patterns: string[]): number {
  const normalizedHeaders = headers.map(normalizeHeader);
  
  for (const pattern of patterns) {
    const normalizedPattern = normalizeHeader(pattern);
    const exactIdx = normalizedHeaders.findIndex(h => h === normalizedPattern);
    if (exactIdx !== -1) return exactIdx;
    const containsIdx = normalizedHeaders.findIndex(h => h.includes(normalizedPattern));
    if (containsIdx !== -1) return containsIdx;
  }
  
  return -1;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function detectCSVType(headers: string[]): CSVType {
  const normalized = headers.map(h => h.toLowerCase().trim());
  
  const hasCNT = normalized.some(h => h.startsWith('cnt_'));
  const hasPP = normalized.some(h => h.startsWith('pp_'));
  const hasST = normalized.some(h => h.startsWith('st_'));
  const hasSUB = normalized.some(h => h.startsWith('sub_'));
  const hasUSR = normalized.some(h => h.startsWith('usr_'));
  const hasAutoMaster = normalized.some(h => h.startsWith('auto_'));
  
  const prefixCount = [hasCNT, hasPP, hasST, hasSUB, hasUSR].filter(Boolean).length;
  if (prefixCount >= 2 || hasAutoMaster) {
    return 'master';
  }
  
  if (normalized.some(h => h.includes('contact id') || h === 'ghl_contact_id')) {
    return 'ghl';
  }
  
  if (normalized.includes('id') && normalized.includes('amount') && 
      (normalized.includes('payment_intent') || normalized.includes('customer') || normalized.includes('status'))) {
    return 'stripe_payments';
  }
  
  if (normalized.some(h => h.includes('customer_id') || h === 'customer') && 
      normalized.includes('email') && !normalized.includes('amount')) {
    return 'stripe_customers';
  }
  
  if (normalized.some(h => h === 'nombre' || h === 'transaction id' || h.includes('correo electrónico'))) {
    return 'paypal';
  }
  
  if (normalized.some(h => h.includes('subscription')) && normalized.some(h => h.includes('plan'))) {
    return 'subscriptions';
  }
  
  return 'auto';
}

// ============= ULTRA-FAST STAGING =============
// Minimal processing: just parse and INSERT
// No validation, no normalization, no merge
async function stageCSVDataUltraFast(
  lines: string[],
  headers: string[],
  sourceType: string,
  importId: string,
  supabase: AnySupabaseClient
): Promise<{ staged: number; errors: number }> {
  const startTime = Date.now();
  
  // Find email/phone columns for basic indexing
  const emailIdx = findColumnIndex(headers, ['email', 'correo electronico', 'correo', 'customer_email', 'auto_master_email']);
  const phoneIdx = findColumnIndex(headers, ['phone', 'telefono', 'tel', 'auto_phone']);
  const nameIdx = findColumnIndex(headers, ['auto_master_name', 'full_name', 'name', 'nombre', 'cnt_first name', 'cnt_firstname']);

  // Prepare staging records - minimal processing
  const stagingRows: {
    import_id: string;
    row_number: number;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    source_type: string;
    raw_data: Record<string, string>;
    processing_status: string;
  }[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const values = parseCSVLine(line);
      
      // Build raw_data object - store everything
      const rawData: Record<string, string> = {};
      for (let j = 0; j < headers.length && j < values.length; j++) {
        const val = values[j]?.replace(/"/g, '').trim();
        if (val) rawData[headers[j]] = val;
      }

      // Extract email for basic lookup (minimal validation)
      let email = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim().toLowerCase() : null;
      if (email && !email.includes('@')) email = null;
      
      // Extract phone (no normalization - do it in merge phase)
      let phone = phoneIdx >= 0 ? values[phoneIdx]?.replace(/"/g, '').trim() : null;
      if (phone && phone.length < 7) phone = null;
      
      const fullName = nameIdx >= 0 ? values[nameIdx]?.replace(/"/g, '').trim() || null : null;

      stagingRows.push({
        import_id: importId,
        row_number: i,
        email,
        phone,
        full_name: fullName,
        source_type: sourceType,
        raw_data: rawData,
        processing_status: 'pending'
      });
    } catch (_err) {
      // Skip failed rows silently for speed
    }
  }

  // Single batch insert - larger batch for speed
  const BATCH_SIZE = 1000;
  let stagedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < stagingRows.length; i += BATCH_SIZE) {
    const batch = stagingRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('csv_imports_raw').insert(batch);
    
    if (error) {
      logger.error(`Staging batch failed`, error);
      errorCount += batch.length;
    } else {
      stagedCount += batch.length;
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Staging complete`, { staged: stagedCount, errors: errorCount, durationMs: duration });

  return { staged: stagedCount, errors: errorCount };
}

// ============= MAIN HANDLER =============
Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

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
    const { csvText, csvType: requestedType, filename, isChunk, chunkIndex, totalChunks } = body;

    if (!csvText) {
      return new Response(
        JSON.stringify({ ok: false, error: 'No CSV text provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Processing CSV', { 
      filename, 
      requestedType, 
      isChunk, 
      chunkIndex, 
      totalChunks,
      textLength: csvText.length 
    });

    // Parse CSV - handle different line endings and empty lines
    const rawLines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const lines = rawLines.filter((l: string) => l.trim().length > 0);
    
    logger.info('CSV lines parsed', { rawLineCount: rawLines.length, filteredLineCount: lines.length, firstLinePreview: lines[0]?.substring(0, 100) });
    
    if (lines.length < 2) {
      // Check if it might be semicolon-delimited
      const firstLine = lines[0] || '';
      const semicolonCount = (firstLine.match(/;/g) || []).length;
      const commaCount = (firstLine.match(/,/g) || []).length;
      
      logger.warn('CSV validation failed', { 
        lineCount: lines.length, 
        semicolonCount, 
        commaCount,
        firstLineLength: firstLine.length,
        csvTextLength: csvText.length
      });
      
      return new Response(
        JSON.stringify({ 
          ok: false, 
          error: `CSV debe tener encabezado y al menos una fila de datos. Recibido: ${lines.length} líneas. ¿El archivo usa punto y coma (;) como delimitador?` 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const headers = parseCSVLine(lines[0]);
    const detectedType = detectCSVType(headers);
    const csvType = requestedType || detectedType;

    logger.info('CSV parsed', { 
      rows: lines.length - 1, 
      headers: headers.length, 
      detectedType, 
      usingType: csvType 
    });

    // Create service role client for direct inserts
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Generate or use existing import ID
    // The frontend sends import_id for all chunks after the first one
    let importId: string;
    const providedImportId = body.importId;
    
    if (providedImportId) {
      // Use the import_id from frontend (for chunks after the first)
      importId = providedImportId;
      logger.info('Using provided importId', { importId, chunkIndex });
    } else if (isChunk && chunkIndex > 0) {
      // Fallback: For subsequent chunks without importId, find existing import run
      const baseFilename = filename?.replace(/_chunk_\d+$/, '') || '';
      const { data: existingRun, error: findError } = await supabase
        .from('csv_import_runs')
        .select('id')
        .eq('filename', baseFilename)
        .in('status', ['staging', 'staged'])
        .order('started_at', { ascending: false })
        .limit(1)
        .single();
      
      if (findError || !existingRun) {
        logger.error('Could not find existing import run for chunk', new Error(`baseFilename=${baseFilename}, chunkIndex=${chunkIndex}, findError=${findError?.message}`));
        return new Response(
          JSON.stringify({ ok: false, error: `No se encontró el import para el chunk ${chunkIndex}. Intenta subir el archivo nuevamente.` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      importId = existingRun.id;
      logger.info('Found existing importId', { importId, chunkIndex });
    } else {
      // First chunk or non-chunked: Create new import run
      importId = crypto.randomUUID();
      const baseFilename = filename?.replace(/_chunk_\d+$/, '') || `import_${Date.now()}`;
      
      const { error: insertError } = await supabase.from('csv_import_runs').insert({
        id: importId,
        filename: baseFilename,
        source_type: csvType,
        total_rows: lines.length - 1,
        rows_staged: 0,
        rows_merged: 0,
        rows_conflict: 0,
        rows_error: 0,
        status: 'staging',
        started_at: new Date().toISOString()
      });

      if (insertError) {
        logger.error('Failed to create import run', new Error(insertError.message));
        return new Response(
          JSON.stringify({ ok: false, error: `Error creando import: ${insertError.message}` }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      logger.info('Created new import run', { importId, baseFilename });
    }

    // Stage data - ULTRA FAST
    const result = await stageCSVDataUltraFast(lines, headers, csvType, importId, supabase);

    // Update import run with staged count
    const { data: currentRun } = await supabase
      .from('csv_import_runs')
      .select('rows_staged, total_rows')
      .eq('id', importId)
      .single();

    const newStagedCount = (currentRun?.rows_staged || 0) + result.staged;
    const newTotalRows = (currentRun?.total_rows || 0) + (lines.length - 1);

    await supabase.from('csv_import_runs').update({
      rows_staged: newStagedCount,
      total_rows: isChunk ? newTotalRows : lines.length - 1,
      staged_at: new Date().toISOString(),
      status: 'staged'
    }).eq('id', importId);

    const duration = Date.now() - startTime;
    
    logger.info('Chunk processed', {
      importId,
      staged: result.staged,
      errors: result.errors,
      durationMs: duration,
      chunkIndex,
      totalChunks
    });

    return new Response(
      JSON.stringify({
        ok: true,
        importId,
        staged: result.staged,
        errors: result.errors,
        csvType,
        durationMs: duration,
        isChunk,
        chunkIndex,
        totalChunks
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Processing failed', error instanceof Error ? error : new Error(errMsg));
    
    return new Response(
      JSON.stringify({ ok: false, error: errMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Edge Function: process-ghl-csv
// Processes large GHL CSV files server-side to avoid browser timeouts

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('process-ghl-csv', LogLevel.INFO);

interface GHLContact {
  ghlContactId: string;
  email: string | null;
  phone: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  tags: string[];
  source: string | null;
  dateCreated: string | null;
  dndEmail: boolean;
  dndSms: boolean;
  dndWhatsApp: boolean;
  customFields: Record<string, string>;
}

interface ProcessingResult {
  clientsCreated: number;
  clientsUpdated: number;
  totalContacts: number;
  withEmail: number;
  withPhone: number;
  withTags: number;
  errors: string[];
}

async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { valid: false, error: 'Invalid token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true, userId: user.id };
}

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  // Remove all non-digit characters except +
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 10) return null;
  // Ensure E.164 format (starts with +)
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote state
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ ok: false, error: authCheck.error }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { csvText } = await req.json();
    
    if (!csvText || typeof csvText !== 'string') {
      return new Response(
        JSON.stringify({ ok: false, error: 'csvText is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Starting GHL CSV processing', { csvLength: csvText.length });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse CSV
    const lines = csvText.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return new Response(
        JSON.stringify({ ok: false, error: 'CSV must have at least a header and one data row' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse header (normalize to lowercase)
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().replace(/"/g, '').trim());
    
    logger.info('CSV headers parsed', { headerCount: headers.length, sampleHeaders: headers.slice(0, 5) });

    // Find column indices
    const contactIdIdx = headers.findIndex(h => h.includes('contact id') || h === 'id');
    const emailIdx = headers.findIndex(h => h === 'email');
    const phoneIdx = headers.findIndex(h => h === 'phone');
    const firstNameIdx = headers.findIndex(h => h.includes('first name') || h === 'firstname');
    const lastNameIdx = headers.findIndex(h => h.includes('last name') || h === 'lastname');
    const tagsIdx = headers.findIndex(h => h === 'tags' || h === 'tag');
    const sourceIdx = headers.findIndex(h => h === 'source');
    const createdIdx = headers.findIndex(h => h.includes('created') || h === 'datecreated');

    if (contactIdIdx === -1) {
      return new Response(
        JSON.stringify({ ok: false, error: 'CSV must have a Contact Id or id column' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse contacts
    const contacts: GHLContact[] = [];
    const result: ProcessingResult = {
      clientsCreated: 0,
      clientsUpdated: 0,
      totalContacts: 0,
      withEmail: 0,
      withPhone: 0,
      withTags: 0,
      errors: []
    };

    logger.info('Parsing CSV rows', { totalRows: lines.length - 1 });

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      try {
        const values = parseCSVLine(line);
        const ghlContactId = values[contactIdIdx]?.replace(/"/g, '').trim() || '';
        
        if (!ghlContactId) continue;

        // Email
        let email = emailIdx >= 0 ? values[emailIdx]?.replace(/"/g, '').trim() || '' : '';
        if (email) {
          email = email.toLowerCase().trim();
          if (!email.includes('@')) {
            email = '';
          }
        }

        // Phone
        const rawPhone = phoneIdx >= 0 ? values[phoneIdx]?.replace(/"/g, '').trim() || '' : '';
        const phone = normalizePhone(rawPhone);

        // Skip if no email AND no phone
        if (!email && !phone) {
          result.errors.push(`Contact ${ghlContactId}: No email or phone`);
          continue;
        }

        // Name
        const firstName = firstNameIdx >= 0 ? values[firstNameIdx]?.replace(/"/g, '').trim() || '' : '';
        const lastName = lastNameIdx >= 0 ? values[lastNameIdx]?.replace(/"/g, '').trim() || '' : '';
        let fullName = '';
        if (firstName || lastName) {
          fullName = `${firstName} ${lastName}`.trim();
        }

        // Tags
        let tags: string[] = [];
        const rawTags = tagsIdx >= 0 ? values[tagsIdx]?.replace(/"/g, '').trim() || '' : '';
        if (rawTags) {
          tags = rawTags.split(',').map(t => t.trim()).filter(t => t);
        }

        // Source
        const source = sourceIdx >= 0 ? values[sourceIdx]?.replace(/"/g, '').trim() || '' : '';

        // Date created
        const dateCreated = createdIdx >= 0 ? values[createdIdx]?.replace(/"/g, '').trim() || '' : '';

        contacts.push({
          ghlContactId,
          email: email || null,
          phone,
          fullName: fullName || null,
          firstName: firstName || null,
          lastName: lastName || null,
          tags,
          source: source || null,
          dateCreated: dateCreated || null,
          dndEmail: false,
          dndSms: false,
          dndWhatsApp: false,
          customFields: {}
        });

        result.totalContacts++;
        if (email) result.withEmail++;
        if (phone) result.withPhone++;
        if (tags.length > 0) result.withTags++;

        // Progress logging every 10k contacts
        if (contacts.length % 10000 === 0) {
          logger.info('Parsing progress', { parsed: contacts.length, total: lines.length - 1 });
        }
      } catch (error) {
        result.errors.push(`Row ${i + 1}: ${error instanceof Error ? error.message : 'Parse error'}`);
      }
    }

    logger.info('CSV parsing complete', {
      totalContacts: contacts.length,
      withEmail: result.withEmail,
      withPhone: result.withPhone
    });

    // Group contacts by email
    const emailContacts = contacts.filter(c => c.email);
    const phoneOnlyContacts = contacts.filter(c => !c.email && c.phone);

    // Load existing clients by email (in batches)
    const uniqueEmails = [...new Set(emailContacts.map(c => c.email!))];
    const existingByEmail = new Map<string, any>();
    const BATCH_SIZE = 1000;

    logger.info('Loading existing clients by email', { uniqueEmails: uniqueEmails.length });

    for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
      const batch = uniqueEmails.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .in('email', batch);

      if (error) {
        logger.warn(`Error loading existing clients: ${error.message} (batch ${i / BATCH_SIZE + 1})`);
        result.errors.push(`Batch ${i / BATCH_SIZE + 1}: ${error.message}`);
      } else {
        data?.forEach(c => existingByEmail.set(c.email, c));
      }

      if (i % 50000 === 0 && i > 0) {
        logger.info('Loading progress', { loaded: i, total: uniqueEmails.length });
      }
    }

    // Load existing clients by phone
    const uniquePhones = [...new Set(phoneOnlyContacts.map(c => c.phone!))];
    const existingByPhone = new Map<string, any>();

    if (uniquePhones.length > 0) {
      logger.info('Loading existing clients by phone', { uniquePhones: uniquePhones.length });

      for (let i = 0; i < uniquePhones.length; i += BATCH_SIZE) {
        const batch = uniquePhones.slice(i, i + BATCH_SIZE);
        const { data, error } = await supabase
          .from('clients')
          .select('*')
          .in('phone', batch);

        if (error) {
          logger.warn(`Error loading existing clients by phone: ${error.message}`);
          result.errors.push(`Phone batch ${i / BATCH_SIZE + 1}: ${error.message}`);
        } else {
          data?.forEach(c => {
            if (c.phone) existingByPhone.set(c.phone, c);
          });
        }
      }
    }

    logger.info('Existing clients loaded', {
      byEmail: existingByEmail.size,
      byPhone: existingByPhone.size
    });

    // Prepare upsert records
    interface ClientUpsert {
      email?: string;
      phone?: string;
      full_name?: string;
      ghl_contact_id: string;
      tags?: string[];
      acquisition_source?: string;
      first_seen_at?: string;
      email_opt_in?: boolean;
      sms_opt_in?: boolean;
      wa_opt_in?: boolean;
      lifecycle_stage?: string;
      last_sync?: string;
    }

    const toUpsert: ClientUpsert[] = [];
    const toInsertPhoneOnly: ClientUpsert[] = [];

    // Process email contacts
    for (const contact of emailContacts) {
      const existing = existingByEmail.get(contact.email!);
      
      const record: ClientUpsert = {
        email: contact.email!,
        ghl_contact_id: contact.ghlContactId,
        last_sync: new Date().toISOString()
      };

      if (!existing?.full_name && contact.fullName) {
        record.full_name = contact.fullName;
      }
      if (!existing?.phone && contact.phone) {
        record.phone = contact.phone;
      }
      if (contact.tags.length > 0) {
        const existingTags = existing?.tags || [];
        record.tags = [...new Set([...existingTags, ...contact.tags])];
      }
      if (!existing?.acquisition_source) {
        record.acquisition_source = 'ghl';
      }
      if (!existing?.first_seen_at && contact.dateCreated) {
        try {
          record.first_seen_at = new Date(contact.dateCreated).toISOString();
        } catch {
          // Invalid date
        }
      }

      record.email_opt_in = !contact.dndEmail;
      record.sms_opt_in = !contact.dndSms;
      record.wa_opt_in = !contact.dndWhatsApp;

      if (!existing?.lifecycle_stage || existing.lifecycle_stage === 'LEAD') {
        record.lifecycle_stage = 'LEAD';
      }

      toUpsert.push(record);

      if (existing) {
        result.clientsUpdated++;
      } else {
        result.clientsCreated++;
      }
    }

    // Process phone-only contacts
    for (const contact of phoneOnlyContacts) {
      const existing = existingByPhone.get(contact.phone!);

      if (existing) {
        const record: ClientUpsert = {
          email: existing.email,
          ghl_contact_id: contact.ghlContactId,
          last_sync: new Date().toISOString()
        };

        if (!existing.full_name && contact.fullName) {
          record.full_name = contact.fullName;
        }
        if (contact.tags.length > 0) {
          record.tags = [...new Set([...(existing.tags || []), ...contact.tags])];
        }

        if (existing.email) {
          toUpsert.push(record);
        }
        result.clientsUpdated++;
      } else {
        toInsertPhoneOnly.push({
          phone: contact.phone!,
          full_name: contact.fullName || undefined,
          ghl_contact_id: contact.ghlContactId,
          tags: contact.tags.length > 0 ? contact.tags : undefined,
          acquisition_source: 'ghl',
          first_seen_at: contact.dateCreated ? new Date(contact.dateCreated).toISOString() : undefined,
          sms_opt_in: !contact.dndSms,
          wa_opt_in: !contact.dndWhatsApp,
          lifecycle_stage: 'LEAD',
          last_sync: new Date().toISOString()
        });
        result.clientsCreated++;
      }
    }

    // Execute upserts in batches
    logger.info('Starting upserts', {
      emailBased: toUpsert.length,
      phoneOnly: toInsertPhoneOnly.length
    });

    // Email-based upserts
    for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
      const batch = toUpsert.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      const { error } = await supabase
        .from('clients')
        .upsert(batch, { onConflict: 'email' });

      if (error) {
        logger.warn(`Upsert batch error: batch ${batchNum}, ${error.message}`);
        result.errors.push(`Batch ${batchNum}: ${error.message}`);
      }

      if (batchNum % 10 === 0) {
        logger.info('Upsert progress', { batch: batchNum, total: Math.ceil(toUpsert.length / BATCH_SIZE) });
      }

      // Small delay for very large imports
      if (toUpsert.length > 50000 && i + BATCH_SIZE < toUpsert.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Phone-only inserts
    for (let i = 0; i < toInsertPhoneOnly.length; i += BATCH_SIZE) {
      const batch = toInsertPhoneOnly.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      const { error } = await supabase
        .from('clients')
        .insert(batch);

      if (error) {
        logger.warn(`Insert phone-only batch error: batch ${batchNum}, ${error.message}`);
        result.errors.push(`Phone-only batch ${batchNum}: ${error.message}`);
      }

      if (batchNum % 10 === 0) {
        logger.info('Phone-only insert progress', { batch: batchNum, total: Math.ceil(toInsertPhoneOnly.length / BATCH_SIZE) });
      }

      if (toInsertPhoneOnly.length > 50000 && i + BATCH_SIZE < toInsertPhoneOnly.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    logger.info('Processing complete', {
      created: result.clientsCreated,
      updated: result.clientsUpdated,
      errors: result.errors.length
    });

    return new Response(
      JSON.stringify({ ok: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    logger.error('Fatal error', error instanceof Error ? error : new Error(String(error)));
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

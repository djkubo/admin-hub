import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger, LogLevel } from '../_shared/logger.ts';
import { RATE_LIMITERS } from '../_shared/rate-limiter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logger = createLogger('export-ghl-csv', LogLevel.INFO);
const rateLimiter = RATE_LIMITERS.GHL;

const CONTACTS_PER_PAGE = 100;

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

    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ ok: false, error: 'GHL_API_KEY and GHL_LOCATION_ID secrets required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Starting GHL CSV export', { locationId: ghlLocationId });

    const ghlUrl = 'https://services.leadconnectorhq.com/contacts/search';
    const allContacts: any[] = [];
    let startAfterId: string | null = null;
    let hasMore = true;
    let pageCount = 0;
    const MAX_PAGES = 1000; // Safety limit

    // Fetch all contacts
    while (hasMore && pageCount < MAX_PAGES) {
      pageCount++;
      
      const bodyParams: Record<string, unknown> = {
        locationId: ghlLocationId,
        pageLimit: CONTACTS_PER_PAGE
      };

      if (startAfterId) {
        bodyParams.startAfterId = startAfterId;
      }

      logger.info(`Fetching page ${pageCount}`, { startAfterId });

      const ghlResponse = await rateLimiter.execute(() =>
        fetch(ghlUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghlApiKey}`,
            'Version': '2021-07-28',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(bodyParams)
        })
      );

      if (!ghlResponse.ok) {
        const errorText = await ghlResponse.text();
        throw new Error(`GHL API error: ${ghlResponse.status} - ${errorText}`);
      }

      const data = await ghlResponse.json();
      const contacts = data.contacts || [];
      
      if (contacts.length === 0) {
        hasMore = false;
        break;
      }

      allContacts.push(...contacts);
      hasMore = contacts.length >= CONTACTS_PER_PAGE;

      // Get next cursor
      const lastContact = contacts[contacts.length - 1];
      const searchAfter = lastContact.searchAfter as [number, string] | undefined;
      
      if (searchAfter && Array.isArray(searchAfter) && searchAfter.length >= 2) {
        startAfterId = searchAfter[1] as string;
      } else {
        startAfterId = lastContact.id as string;
      }

      logger.info(`Fetched ${contacts.length} contacts, total: ${allContacts.length}`);
    }

    if (pageCount >= MAX_PAGES) {
      logger.warn(`Reached max pages limit (${MAX_PAGES}), stopping`);
    }

    logger.info(`Total contacts fetched: ${allContacts.length}`);

    // Convert to CSV
    if (allContacts.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: 'No contacts found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // CSV Headers
    const headers = [
      'id',
      'email',
      'phone',
      'firstName',
      'lastName',
      'contactName',
      'source',
      'type',
      'tags',
      'dateAdded',
      'dateUpdated',
      'country',
      'city',
      'state',
      'postalCode',
      'timezone',
      'dnd',
      'businessName',
      'companyName',
      'website'
    ];

    // CSV Rows
    const csvRows = [
      headers.join(',')
    ];

    for (const contact of allContacts) {
      const row = [
        contact.id || '',
        contact.email || '',
        contact.phone || '',
        contact.firstName || '',
        contact.lastName || '',
        contact.contactName || '',
        contact.source || '',
        contact.type || '',
        Array.isArray(contact.tags) ? contact.tags.join(';') : '',
        contact.dateAdded || '',
        contact.dateUpdated || '',
        contact.country || '',
        contact.city || '',
        contact.state || '',
        contact.postalCode || '',
        contact.timezone || '',
        contact.dnd ? 'true' : 'false',
        contact.businessName || '',
        contact.companyName || '',
        contact.website || ''
      ].map(field => {
        // Escape commas and quotes in CSV
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
      
      csvRows.push(row.join(','));
    }

    const csvContent = csvRows.join('\n');

    // Return CSV file
    return new Response(csvContent, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="ghl-contacts-${new Date().toISOString().split('T')[0]}.csv"`
      }
    });

  } catch (error) {
    logger.error('Export error', error instanceof Error ? error : new Error(String(error)));
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

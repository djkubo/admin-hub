import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

function verifyAdminKey(req: Request): boolean {
  const adminKey = req.headers.get('x-admin-key');
  const expectedKey = Deno.env.get('ADMIN_API_KEY');
  return adminKey === expectedKey;
}

interface GHLTemplate {
  id: string;
  name: string;
  type?: string;
  body?: string;
  attachments?: unknown[];
  dateAdded?: string;
  [key: string]: unknown;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify admin key
    if (!verifyAdminKey(req)) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ error: 'Missing GHL_API_KEY or GHL_LOCATION_ID' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body for optional filters
    let filterType: string | null = null;
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        filterType = body.type || null; // 'whatsapp', 'sms', 'email', or null for all
      } catch {
        // No body or invalid JSON - continue with no filter
      }
    }

    console.log(`[ghl-templates] Fetching templates from GHL location: ${ghlLocationId}`);

    // Fetch all templates from GHL
    const templatesUrl = `https://services.leadconnectorhq.com/locations/${ghlLocationId}/templates`;
    
    const response = await fetch(templatesUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ghlApiKey}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ghl-templates] GHL API error: ${response.status} - ${errorText}`);
      return new Response(
        JSON.stringify({ 
          error: `GHL API error: ${response.status}`,
          details: errorText 
        }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    console.log(`[ghl-templates] Raw response keys:`, Object.keys(data));

    // The API might return templates in different structures
    let allTemplates: GHLTemplate[] = [];
    
    if (Array.isArray(data)) {
      allTemplates = data;
    } else if (data.templates && Array.isArray(data.templates)) {
      allTemplates = data.templates;
    } else if (data.data && Array.isArray(data.data)) {
      allTemplates = data.data;
    } else {
      // Log the structure for debugging
      console.log(`[ghl-templates] Unexpected response structure:`, JSON.stringify(data).slice(0, 500));
      allTemplates = [];
    }

    console.log(`[ghl-templates] Found ${allTemplates.length} total templates`);

    // Filter by type if requested
    let filteredTemplates = allTemplates;
    if (filterType) {
      filteredTemplates = allTemplates.filter((t: GHLTemplate) => {
        const templateType = (t.type || '').toLowerCase();
        return templateType.includes(filterType.toLowerCase());
      });
      console.log(`[ghl-templates] Filtered to ${filteredTemplates.length} ${filterType} templates`);
    }

    // Categorize templates
    const whatsappTemplates = allTemplates.filter((t: GHLTemplate) => 
      (t.type || '').toLowerCase().includes('whatsapp') ||
      (t.name || '').toLowerCase().includes('whatsapp')
    );
    
    const smsTemplates = allTemplates.filter((t: GHLTemplate) => 
      (t.type || '').toLowerCase() === 'sms'
    );
    
    const emailTemplates = allTemplates.filter((t: GHLTemplate) => 
      (t.type || '').toLowerCase() === 'email'
    );

    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          total: allTemplates.length,
          whatsapp: whatsappTemplates.length,
          sms: smsTemplates.length,
          email: emailTemplates.length,
          other: allTemplates.length - whatsappTemplates.length - smsTemplates.length - emailTemplates.length
        },
        templates: filterType ? filteredTemplates : allTemplates,
        whatsapp_templates: whatsappTemplates,
        raw_response_keys: Object.keys(data)
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('[ghl-templates] Error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error)
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

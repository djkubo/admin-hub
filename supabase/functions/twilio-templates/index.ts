import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

// SECURITY: Simple admin key guard
function verifyAdminKey(req: Request): { valid: boolean; error?: string } {
  const adminKey = Deno.env.get("ADMIN_API_KEY");
  if (!adminKey) {
    return { valid: false, error: "ADMIN_API_KEY not configured" };
  }
  const providedKey = req.headers.get("x-admin-key");
  if (!providedKey || providedKey !== adminKey) {
    return { valid: false, error: "Invalid or missing x-admin-key" };
  }
  return { valid: true };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify x-admin-key
    const authCheck = verifyAdminKey(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log("✅ Admin key verified");

    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.error('Missing Twilio credentials');
      return new Response(
        JSON.stringify({ error: 'Twilio credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch Content Templates from Twilio
    console.log("📋 Fetching Twilio Content Templates...");
    
    const contentUrl = 'https://content.twilio.com/v1/Content';
    
    const response = await fetch(contentUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/json',
      },
    });

    const result = await response.json();
    console.log('Twilio Content API response status:', response.status);
    
    if (!response.ok) {
      console.error('Twilio Content API error:', result);
      return new Response(
        JSON.stringify({ 
          error: 'Failed to fetch templates', 
          details: result 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Format templates for easier reading
    const templates = result.contents?.map((template: any) => ({
      sid: template.sid,
      friendly_name: template.friendly_name,
      language: template.language,
      types: Object.keys(template.types || {}),
      variables: template.variables,
      date_created: template.date_created,
      date_updated: template.date_updated,
      approval_status: template.approval_requests?.[0]?.status || 'unknown',
      content_type: template.types?.['twilio/text']?.body ? 'text' : 
                   template.types?.['twilio/media']?.body ? 'media' :
                   template.types?.['twilio/quick-reply']?.body ? 'quick-reply' : 'other',
      body: template.types?.['twilio/text']?.body || 
            template.types?.['twilio/media']?.body ||
            template.types?.['twilio/quick-reply']?.body || null,
    })) || [];

    console.log(`📋 Found ${templates.length} templates`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        count: templates.length,
        templates 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching templates:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

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

    const authHeader = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

    // 1. Fetch ALL Content Templates (with pagination)
    console.log("📋 Fetching ALL Twilio Content Templates...");
    
    let allTemplates: any[] = [];
    let nextPageUri: string | null = '/v1/Content?PageSize=100';
    
    while (nextPageUri) {
      const currentUrl: string = `https://content.twilio.com${nextPageUri}`;
      console.log(`Fetching: ${currentUrl}`);
      
      const contentResponse: Response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      });

      const contentResult: any = await contentResponse.json();
      
      if (!contentResponse.ok) {
        console.error('Twilio Content API error:', contentResult);
        break;
      }
      
      if (contentResult.contents) {
        allTemplates = [...allTemplates, ...contentResult.contents];
      }
      
      // Check for next page
      nextPageUri = contentResult.meta?.next_page_uri || null;
    }

    console.log(`📋 Total Content Templates: ${allTemplates.length}`);

    // 2. Fetch Messaging Services
    console.log("📱 Fetching Messaging Services...");
    const messagingServicesUrl = `https://messaging.twilio.com/v1/Services`;
    
    const msResponse = await fetch(messagingServicesUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    });
    
    const msResult = await msResponse.json();
    const messagingServices = msResult.services || [];
    console.log(`📱 Found ${messagingServices.length} Messaging Services`);

    // 3. Fetch Verify Services  
    console.log("🔐 Fetching Verify Services...");
    const verifyUrl = `https://verify.twilio.com/v2/Services`;
    
    const verifyResponse = await fetch(verifyUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    });
    
    const verifyResult = await verifyResponse.json();
    const verifyServices = verifyResult.services || [];
    console.log(`🔐 Found ${verifyServices.length} Verify Services`);

    // Format templates for easier reading
    const templates = allTemplates.map((template: any) => ({
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
                   template.types?.['twilio/quick-reply']?.body ? 'quick-reply' :
                   template.types?.['whatsapp/authentication'] ? 'whatsapp-auth' : 'other',
      body: template.types?.['twilio/text']?.body || 
            template.types?.['twilio/media']?.body ||
            template.types?.['twilio/quick-reply']?.body || null,
    }));

    // Filter out verify_auto_created templates for cleaner view (they're auto-generated)
    const customTemplates = templates.filter((t: any) => 
      t.friendly_name !== 'verify_auto_created'
    );
    
    const verifyTemplates = templates.filter((t: any) => 
      t.friendly_name === 'verify_auto_created'
    );

    return new Response(
      JSON.stringify({ 
        success: true, 
        summary: {
          total_templates: templates.length,
          custom_templates: customTemplates.length,
          verify_auto_templates: verifyTemplates.length,
          messaging_services: messagingServices.length,
          verify_services: verifyServices.length,
        },
        custom_templates: customTemplates,
        verify_templates_languages: verifyTemplates.map((t: any) => t.language),
        messaging_services: messagingServices.map((s: any) => ({
          sid: s.sid,
          friendly_name: s.friendly_name,
          inbound_request_url: s.inbound_request_url,
          use_inbound_webhook_on_number: s.use_inbound_webhook_on_number,
        })),
        verify_services: verifyServices.map((s: any) => ({
          sid: s.sid,
          friendly_name: s.friendly_name,
          code_length: s.code_length,
          default_template_sid: s.default_template_sid,
        })),
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

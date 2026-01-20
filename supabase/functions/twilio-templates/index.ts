import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

function verifyAdminKey(req: Request): { valid: boolean; error?: string } {
  const adminKey = Deno.env.get("ADMIN_API_KEY");
  if (!adminKey) return { valid: false, error: "ADMIN_API_KEY not configured" };
  const providedKey = req.headers.get("x-admin-key");
  if (!providedKey || providedKey !== adminKey) return { valid: false, error: "Invalid or missing x-admin-key" };
  return { valid: true };
}

async function fetchAllPages(baseUrl: string, authHeader: string, itemsKey: string): Promise<any[]> {
  let allItems: any[] = [];
  let url: string | null = baseUrl;
  
  while (url) {
    console.log(`Fetching: ${url}`);
    const response: Response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    });
    
    if (!response.ok) {
      console.error(`Error fetching ${url}:`, await response.text());
      break;
    }
    
    const result: any = await response.json();
    const items = result[itemsKey] || [];
    allItems = [...allItems, ...items];
    
    // Check for next page (different APIs use different pagination)
    url = result.meta?.next_page_uri 
      ? (baseUrl.includes('content.twilio.com') ? `https://content.twilio.com${result.meta.next_page_uri}` : result.meta.next_page_uri)
      : result.next_page_uri || null;
  }
  
  return allItems;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authCheck = verifyAdminKey(req);
    if (!authCheck.valid) {
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({ error: 'Twilio credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authHeader = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const results: any = {};

    // 1. Content Templates (WhatsApp templates)
    console.log("📋 1. Fetching Content Templates...");
    const contentTemplates = await fetchAllPages(
      'https://content.twilio.com/v1/Content?PageSize=100',
      authHeader,
      'contents'
    );
    results.content_templates = contentTemplates.map((t: any) => ({
      sid: t.sid,
      friendly_name: t.friendly_name,
      language: t.language,
      types: Object.keys(t.types || {}),
      approval_status: t.approval_requests?.[0]?.status || 'unknown',
      body: t.types?.['twilio/text']?.body || 
            t.types?.['twilio/media']?.body ||
            t.types?.['twilio/quick-reply']?.body ||
            t.types?.['twilio/call-to-action']?.body || null,
      variables: t.variables,
    }));

    // 2. Messaging Services
    console.log("📱 2. Fetching Messaging Services...");
    const messagingServices = await fetchAllPages(
      'https://messaging.twilio.com/v1/Services?PageSize=100',
      authHeader,
      'services'
    );
    results.messaging_services = messagingServices.map((s: any) => ({
      sid: s.sid,
      friendly_name: s.friendly_name,
      inbound_request_url: s.inbound_request_url,
      status_callback: s.status_callback,
      use_inbound_webhook_on_number: s.use_inbound_webhook_on_number,
    }));

    // 3. Verify Services
    console.log("🔐 3. Fetching Verify Services...");
    const verifyServices = await fetchAllPages(
      'https://verify.twilio.com/v2/Services?PageSize=100',
      authHeader,
      'services'
    );
    results.verify_services = verifyServices.map((s: any) => ({
      sid: s.sid,
      friendly_name: s.friendly_name,
      code_length: s.code_length,
      custom_code_enabled: s.custom_code_enabled,
      default_template_sid: s.default_template_sid,
      push_enabled: s.push_enabled,
      totp_enabled: s.totp_enabled,
    }));

    // 4. Phone Numbers
    console.log("📞 4. Fetching Phone Numbers...");
    const phoneNumbers = await fetchAllPages(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=100`,
      authHeader,
      'incoming_phone_numbers'
    );
    results.phone_numbers = phoneNumbers.map((p: any) => ({
      sid: p.sid,
      phone_number: p.phone_number,
      friendly_name: p.friendly_name,
      capabilities: p.capabilities,
      sms_url: p.sms_url,
      voice_url: p.voice_url,
    }));

    // 5. WhatsApp Senders (Business Profiles)
    console.log("💬 5. Fetching WhatsApp Senders...");
    let whatsappSenders: any[] = [];
    try {
      const waResponse = await fetch(
        'https://messaging.twilio.com/v1/Senders?PageSize=100',
        { headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } }
      );
      if (waResponse.ok) {
        const waResult = await waResponse.json();
        whatsappSenders = waResult.senders || [];
      }
    } catch (e) {
      console.log("WhatsApp Senders API not available");
    }
    results.whatsapp_senders = whatsappSenders;

    // 6. A2P Campaigns (10DLC)
    console.log("📢 6. Fetching A2P Campaigns...");
    let a2pCampaigns: any[] = [];
    try {
      const a2pResponse = await fetch(
        'https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=100',
        { headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } }
      );
      if (a2pResponse.ok) {
        const a2pResult = await a2pResponse.json();
        a2pCampaigns = a2pResult.data || [];
      }
    } catch (e) {
      console.log("A2P API not available");
    }
    results.a2p_brand_registrations = a2pCampaigns;

    // 7. Toll-Free Verifications
    console.log("📞 7. Fetching Toll-Free Verifications...");
    let tollFreeVerifications: any[] = [];
    try {
      const tfResponse = await fetch(
        'https://messaging.twilio.com/v1/Tollfree/Verifications?PageSize=100',
        { headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } }
      );
      if (tfResponse.ok) {
        const tfResult = await tfResponse.json();
        tollFreeVerifications = tfResult.data || [];
      }
    } catch (e) {
      console.log("Toll-Free API not available");
    }
    results.toll_free_verifications = tollFreeVerifications;

    // 8. Conversations Services
    console.log("💬 8. Fetching Conversations Services...");
    let conversationsServices: any[] = [];
    try {
      const convResponse = await fetch(
        'https://conversations.twilio.com/v1/Services?PageSize=100',
        { headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } }
      );
      if (convResponse.ok) {
        const convResult = await convResponse.json();
        conversationsServices = convResult.services || [];
      }
    } catch (e) {
      console.log("Conversations API not available");
    }
    results.conversations_services = conversationsServices.map((s: any) => ({
      sid: s.sid,
      friendly_name: s.friendly_name,
    }));

    // Create summary
    const customTemplates = results.content_templates.filter((t: any) => 
      t.friendly_name !== 'verify_auto_created'
    );
    const verifyTemplates = results.content_templates.filter((t: any) => 
      t.friendly_name === 'verify_auto_created'
    );

    const summary = {
      content_templates_total: results.content_templates.length,
      content_templates_custom: customTemplates.length,
      content_templates_verify_auto: verifyTemplates.length,
      messaging_services: results.messaging_services.length,
      verify_services: results.verify_services.length,
      phone_numbers: results.phone_numbers.length,
      whatsapp_senders: results.whatsapp_senders.length,
      a2p_brand_registrations: results.a2p_brand_registrations.length,
      toll_free_verifications: results.toll_free_verifications.length,
      conversations_services: results.conversations_services.length,
    };

    return new Response(
      JSON.stringify({ 
        success: true,
        summary,
        custom_content_templates: customTemplates,
        verify_auto_templates_count: verifyTemplates.length,
        verify_auto_templates_languages: verifyTemplates.map((t: any) => t.language),
        messaging_services: results.messaging_services,
        verify_services: results.verify_services,
        phone_numbers: results.phone_numbers,
        whatsapp_senders: results.whatsapp_senders,
        a2p_brand_registrations: results.a2p_brand_registrations,
        toll_free_verifications: results.toll_free_verifications,
        conversations_services: results.conversations_services,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

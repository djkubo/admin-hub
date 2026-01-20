import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TwilioInboundMessage {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  Body: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Parse form data from Twilio webhook
    const formData = await req.formData();
    const payload: Record<string, string> = {};
    formData.forEach((value, key) => {
      payload[key] = value.toString();
    });

    console.log("📨 Twilio inbound message received:", JSON.stringify(payload, null, 2));

    const { MessageSid, AccountSid, From, To, Body } = payload as unknown as TwilioInboundMessage;

    // Basic validation
    if (!MessageSid || !From || !Body) {
      console.error("❌ Missing required fields");
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    }

    // Verify AccountSid matches (basic security)
    if (TWILIO_ACCOUNT_SID && AccountSid !== TWILIO_ACCOUNT_SID) {
      console.error("❌ AccountSid mismatch - possible spoofing attempt");
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { status: 403, headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    }

    // Determine channel (WhatsApp or SMS)
    const isWhatsApp = From.startsWith("whatsapp:");
    const channel = isWhatsApp ? "whatsapp" : "sms";
    
    // Clean phone number
    const cleanPhone = From.replace("whatsapp:", "").replace(/[^\d+]/g, "");
    const normalizedPhone = cleanPhone.startsWith("+") ? cleanPhone : `+${cleanPhone}`;

    console.log(`📱 ${channel.toUpperCase()} from ${normalizedPhone}: "${Body.substring(0, 50)}..."`);

    // Find client by phone
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, full_name, email, phone")
      .or(`phone.ilike.%${cleanPhone.slice(-10)}%`)
      .limit(1)
      .single();

    if (clientError && clientError.code !== "PGRST116") {
      console.error("Error finding client:", clientError);
    }

    const clientId = client?.id || null;
    console.log(clientId ? `👤 Matched to client: ${client?.full_name}` : "👤 No matching client found");

    // Store message in messages table
    const { data: message, error: msgError } = await supabase
      .from("messages")
      .insert({
        client_id: clientId,
        direction: "inbound",
        channel,
        from_address: normalizedPhone,
        to_address: To.replace("whatsapp:", ""),
        body: Body,
        external_message_id: MessageSid,
        status: "received",
        metadata: {
          account_sid: AccountSid,
          num_media: payload.NumMedia || "0",
          media_url: payload.MediaUrl0 || null,
          media_type: payload.MediaContentType0 || null,
          raw_from: From,
        },
      })
      .select()
      .single();

    if (msgError) {
      console.error("❌ Error storing message:", msgError);
    } else {
      console.log("✅ Message stored:", message.id);
    }

    // Log as client event if we have a client
    if (clientId) {
      await supabase.from("client_events").insert({
        client_id: clientId,
        event_type: "custom",
        metadata: {
          type: `${channel}_received`,
          message_id: message?.id,
          preview: Body.substring(0, 100),
        },
      });
    }

    // If no client found, optionally create a lead
    if (!clientId && normalizedPhone) {
      console.log("💡 Consider creating lead for unknown sender:", normalizedPhone);
      // Could auto-create client here if desired
    }

    // Return empty TwiML response (no auto-reply)
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
    );

  } catch (error) {
    console.error("❌ Error processing inbound message:", error);
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { status: 500, headers: { ...corsHeaders, "Content-Type": "text/xml" } }
    );
  }
});

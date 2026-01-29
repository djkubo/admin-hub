import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface BroadcastRequest {
  list_id: string;
  message_content: string;
  media_url?: string;
  media_type?: string;
  scheduled_at?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: BroadcastRequest = await req.json();
    const { list_id, message_content, media_url, media_type, scheduled_at } = body;

    if (!list_id || !message_content) {
      return new Response(
        JSON.stringify({ error: "list_id and message_content are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get list members
    const { data: members, error: membersError } = await supabase
      .from("broadcast_list_members")
      .select(`
        client_id,
        client:clients(id, full_name, email, phone, phone_e164)
      `)
      .eq("list_id", list_id);

    if (membersError) {
      throw new Error(`Failed to fetch members: ${membersError.message}`);
    }

    if (!members || members.length === 0) {
      return new Response(
        JSON.stringify({ error: "No members in this list" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create broadcast message record
    const { data: broadcast, error: broadcastError } = await supabase
      .from("broadcast_messages")
      .insert({
        list_id,
        message_content,
        media_url: media_url || null,
        media_type: media_type || null,
        status: scheduled_at ? "pending" : "sending",
        total_recipients: members.length,
        sent_count: 0,
        failed_count: 0,
        scheduled_at: scheduled_at || null,
        started_at: scheduled_at ? null : new Date().toISOString(),
      })
      .select()
      .single();

    if (broadcastError) {
      throw new Error(`Failed to create broadcast: ${broadcastError.message}`);
    }

    // If scheduled, return early
    if (scheduled_at) {
      return new Response(
        JSON.stringify({
          success: true,
          broadcast_id: broadcast.id,
          status: "scheduled",
          scheduled_at,
          total_recipients: members.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Process messages (with rate limiting - 1 per second)
    let sentCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    for (const member of members) {
      try {
        const client = member.client as any;
        if (!client?.phone_e164 && !client?.phone) {
          failedCount++;
          errors.push(`No phone for client ${client?.id}`);
          continue;
        }

        // Personalize message
        const personalizedMessage = message_content
          .replace(/\{\{name\}\}/g, client.full_name || "Cliente")
          .replace(/\{\{phone\}\}/g, client.phone_e164 || client.phone || "")
          .replace(/\{\{email\}\}/g, client.email || "");

        // Try GHL first, fallback to Twilio
        const phone = client.phone_e164 || client.phone;
        
        try {
          // Call notify-ghl
          const ghlResponse = await supabase.functions.invoke("notify-ghl", {
            body: {
              contactId: client.id,
              phone,
              message: personalizedMessage,
              mediaUrl: media_url,
            },
          });

          if (ghlResponse.error) {
            throw new Error(ghlResponse.error.message);
          }
          sentCount++;
        } catch (ghlError) {
          // Fallback to send-sms
          try {
            const smsResponse = await supabase.functions.invoke("send-sms", {
              body: {
                to: phone,
                message: personalizedMessage,
                mediaUrl: media_url,
              },
            });

            if (smsResponse.error) {
              throw new Error(smsResponse.error.message);
            }
            sentCount++;
          } catch (smsError: any) {
            failedCount++;
            errors.push(`Failed to send to ${phone}: ${smsError.message}`);
          }
        }

        // Update progress every 5 messages
        if ((sentCount + failedCount) % 5 === 0) {
          await supabase
            .from("broadcast_messages")
            .update({
              sent_count: sentCount,
              failed_count: failedCount,
            })
            .eq("id", broadcast.id);
        }

        // Rate limiting: 1 message per second
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err: any) {
        failedCount++;
        errors.push(`Error processing member: ${err.message}`);
      }
    }

    // Update final status
    await supabase
      .from("broadcast_messages")
      .update({
        status: failedCount === members.length ? "failed" : "completed",
        sent_count: sentCount,
        failed_count: failedCount,
        completed_at: new Date().toISOString(),
      })
      .eq("id", broadcast.id);

    // Update list last_broadcast_at
    await supabase
      .from("broadcast_lists")
      .update({ last_broadcast_at: new Date().toISOString() })
      .eq("id", list_id);

    return new Response(
      JSON.stringify({
        success: true,
        broadcast_id: broadcast.id,
        status: "completed",
        total_recipients: members.length,
        sent_count: sentCount,
        failed_count: failedCount,
        errors: errors.slice(0, 10), // Return first 10 errors
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error in send-broadcast:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

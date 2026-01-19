import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Amazon SNS message types
interface SNSMessage {
  Type: string;
  MessageId: string;
  TopicArn?: string;
  Message: string;
  Timestamp: string;
  SubscribeURL?: string;
  Token?: string;
}

interface SESBounceRecipient {
  emailAddress: string;
  action?: string;
  status?: string;
  diagnosticCode?: string;
}

interface SESComplaintRecipient {
  emailAddress: string;
}

interface SESEventRecord {
  eventType: string;
  mail: {
    messageId: string;
    destination: string[];
    source: string;
    timestamp: string;
    commonHeaders?: {
      subject?: string;
    };
  };
  bounce?: {
    bounceType: string;
    bounceSubType: string;
    bouncedRecipients: SESBounceRecipient[];
    timestamp: string;
  };
  complaint?: {
    complainedRecipients: SESComplaintRecipient[];
    complaintFeedbackType?: string;
    timestamp: string;
  };
  delivery?: {
    timestamp: string;
    recipients: string[];
  };
  open?: {
    timestamp: string;
    ipAddress: string;
    userAgent: string;
  };
  click?: {
    timestamp: string;
    ipAddress: string;
    userAgent: string;
    link: string;
  };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.text();
    console.log("📨 SES Webhook received:", body.substring(0, 500));

    let payload: SNSMessage;
    try {
      payload = JSON.parse(body);
    } catch {
      console.error("❌ Invalid JSON payload");
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Handle SNS subscription confirmation
    if (payload.Type === "SubscriptionConfirmation") {
      console.log("🔗 SNS Subscription confirmation received");
      console.log("📎 SubscribeURL:", payload.SubscribeURL);
      
      // Auto-confirm subscription by fetching the URL
      if (payload.SubscribeURL) {
        try {
          await fetch(payload.SubscribeURL);
          console.log("✅ SNS Subscription confirmed automatically");
        } catch (error) {
          console.error("❌ Failed to confirm subscription:", error);
        }
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: "Subscription confirmation received",
        subscribeUrl: payload.SubscribeURL 
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Handle actual notifications
    if (payload.Type === "Notification") {
      let sesEvent: SESEventRecord;
      try {
        sesEvent = JSON.parse(payload.Message);
      } catch {
        console.error("❌ Invalid SES event in Message");
        return new Response(JSON.stringify({ error: "Invalid SES event" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const eventType = sesEvent.eventType?.toLowerCase();
      console.log(`📧 SES Event Type: ${eventType}`);

      // Process based on event type
      switch (eventType) {
        case "bounce": {
          await handleBounce(supabase, sesEvent);
          break;
        }
        case "complaint": {
          await handleComplaint(supabase, sesEvent);
          break;
        }
        case "open": {
          await handleOpen(supabase, sesEvent);
          break;
        }
        case "click": {
          await handleClick(supabase, sesEvent);
          break;
        }
        case "delivery": {
          await handleDelivery(supabase, sesEvent);
          break;
        }
        case "send": {
          await handleSend(supabase, sesEvent);
          break;
        }
        default:
          console.log(`⚠️ Unhandled event type: ${eventType}`);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        eventType,
        processed: true 
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, message: "Unhandled message type" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ SES Webhook error:", error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Handle bounce events - update client status and log event
async function handleBounce(supabase: any, event: SESEventRecord) {
  const bouncedEmails = event.bounce?.bouncedRecipients?.map(r => r.emailAddress) || [];
  console.log(`🔴 Bounce detected for: ${bouncedEmails.join(", ")}`);

  for (const email of bouncedEmails) {
    // Find client by email
    const { data: client, error: findError } = await supabase
      .from("clients")
      .select("id, email, status")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (findError) {
      console.error(`❌ Error finding client ${email}:`, findError);
      continue;
    }

    if (client) {
      // Update client status to indicate email bounce
      const { error: updateError } = await supabase
        .from("clients")
        .update({ status: "email_bounce" })
        .eq("id", client.id);

      if (updateError) {
        console.error(`❌ Error updating client ${email}:`, updateError);
      } else {
        console.log(`✅ Client ${email} status updated to email_bounce`);
      }

      // Log the event
      const { error: eventError } = await supabase
        .from("client_events")
        .insert({
          client_id: client.id,
          event_type: "email_bounce",
          metadata: {
            bounce_type: event.bounce?.bounceType,
            bounce_subtype: event.bounce?.bounceSubType,
            diagnostic: event.bounce?.bouncedRecipients?.find(r => r.emailAddress === email)?.diagnosticCode,
            message_id: event.mail.messageId,
            subject: event.mail.commonHeaders?.subject,
            timestamp: event.bounce?.timestamp,
          },
        });

      if (eventError) {
        console.error(`❌ Error logging bounce event:`, eventError);
      } else {
        console.log(`✅ Bounce event logged for client ${client.id}`);
      }
    } else {
      console.log(`⚠️ No client found for email: ${email}`);
    }
  }
}

// Handle complaint events
async function handleComplaint(supabase: any, event: SESEventRecord) {
  const complainedEmails = event.complaint?.complainedRecipients?.map(r => r.emailAddress) || [];
  console.log(`🟠 Complaint detected for: ${complainedEmails.join(", ")}`);

  for (const email of complainedEmails) {
    const { data: client } = await supabase
      .from("clients")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (client) {
      // Update status and log event
      await supabase
        .from("clients")
        .update({ status: "email_complaint" })
        .eq("id", client.id);

      await supabase
        .from("client_events")
        .insert({
          client_id: client.id,
          event_type: "email_bounce", // Using bounce type for complaints too
          metadata: {
            complaint_type: event.complaint?.complaintFeedbackType,
            message_id: event.mail.messageId,
            timestamp: event.complaint?.timestamp,
            is_complaint: true,
          },
        });

      console.log(`✅ Complaint logged for client ${client.id}`);
    }
  }
}

// Handle open events - engagement tracking
async function handleOpen(supabase: any, event: SESEventRecord) {
  const emails = event.mail.destination || [];
  console.log(`👁️ Email opened by: ${emails.join(", ")}`);

  for (const email of emails) {
    const { data: client } = await supabase
      .from("clients")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (client) {
      const { error } = await supabase
        .from("client_events")
        .insert({
          client_id: client.id,
          event_type: "email_open",
          metadata: {
            message_id: event.mail.messageId,
            subject: event.mail.commonHeaders?.subject,
            ip_address: event.open?.ipAddress,
            user_agent: event.open?.userAgent,
            timestamp: event.open?.timestamp,
          },
        });

      if (error) {
        console.error(`❌ Error logging open event:`, error);
      } else {
        console.log(`✅ Open event logged for client ${client.id}`);
      }
    }
  }
}

// Handle click events - engagement tracking
async function handleClick(supabase: any, event: SESEventRecord) {
  const emails = event.mail.destination || [];
  console.log(`🖱️ Link clicked by: ${emails.join(", ")}`);

  for (const email of emails) {
    const { data: client } = await supabase
      .from("clients")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (client) {
      const { error } = await supabase
        .from("client_events")
        .insert({
          client_id: client.id,
          event_type: "email_click",
          metadata: {
            message_id: event.mail.messageId,
            subject: event.mail.commonHeaders?.subject,
            link: event.click?.link,
            ip_address: event.click?.ipAddress,
            user_agent: event.click?.userAgent,
            timestamp: event.click?.timestamp,
          },
        });

      if (error) {
        console.error(`❌ Error logging click event:`, error);
      } else {
        console.log(`✅ Click event logged for client ${client.id}`);
      }
    }
  }
}

// Handle delivery events
async function handleDelivery(supabase: any, event: SESEventRecord) {
  const emails = event.delivery?.recipients || [];
  console.log(`📬 Email delivered to: ${emails.join(", ")}`);

  for (const email of emails) {
    const { data: client } = await supabase
      .from("clients")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (client) {
      await supabase
        .from("client_events")
        .insert({
          client_id: client.id,
          event_type: "email_sent",
          metadata: {
            message_id: event.mail.messageId,
            subject: event.mail.commonHeaders?.subject,
            delivered_at: event.delivery?.timestamp,
          },
        });

      console.log(`✅ Delivery event logged for client ${client.id}`);
    }
  }
}

// Handle send events
async function handleSend(supabase: any, event: SESEventRecord) {
  const emails = event.mail.destination || [];
  console.log(`📤 Email sent to: ${emails.join(", ")}`);

  for (const email of emails) {
    const { data: client } = await supabase
      .from("clients")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (client) {
      await supabase
        .from("client_events")
        .insert({
          client_id: client.id,
          event_type: "email_sent",
          metadata: {
            message_id: event.mail.messageId,
            subject: event.mail.commonHeaders?.subject,
            sent_at: event.mail.timestamp,
          },
        });

      console.log(`✅ Send event logged for client ${client.id}`);
    }
  }
}

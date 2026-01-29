import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SendCampaignRequest {
  campaign_id: string;
  dry_run?: boolean;
}

interface DebtInfo {
  totalDebt: number;
  daysUntilDue: number | null;
}

// Helper function to get client's real debt information
async function getClientDebtInfo(
  supabase: SupabaseClient,
  clientEmail: string | null
): Promise<DebtInfo> {
  if (!clientEmail) {
    return { totalDebt: 0, daysUntilDue: null };
  }

  try {
    // Fetch open invoices for the client
    const { data: openInvoices, error } = await supabase
      .from('invoices')
      .select('amount_due, due_date')
      .eq('customer_email', clientEmail)
      .in('status', ['open', 'past_due', 'draft'])
      .order('due_date', { ascending: true });

    if (error) {
      console.error('Error fetching client debt info:', error);
      return { totalDebt: 0, daysUntilDue: null };
    }

    // Calculate total debt amount
    const totalDebt = (openInvoices || []).reduce(
      (sum, inv) => sum + (inv.amount_due || 0),
      0
    );

    // Calculate days until the earliest due date
    let daysUntilDue: number | null = null;
    if (openInvoices?.length && openInvoices[0].due_date) {
      const dueDate = new Date(openInvoices[0].due_date);
      const today = new Date();
      daysUntilDue = Math.ceil(
        (dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    return { totalDebt, daysUntilDue };
  } catch (err) {
    console.error('Exception in getClientDebtInfo:', err);
    return { totalDebt: 0, daysUntilDue: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { campaign_id, dry_run }: SendCampaignRequest = await req.json();
    console.log('Starting campaign:', campaign_id, 'dry_run:', dry_run);

    // Get campaign with template and segment
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select(`
        *,
        template:message_templates(*),
        segment:segments(*)
      `)
      .eq('id', campaign_id)
      .single();

    if (campaignError || !campaign) {
      throw new Error('Campaign not found');
    }

    if (campaign.status !== 'draft' && !dry_run) {
      throw new Error('Campaign must be in draft status to send');
    }

    // Update campaign status
    if (!dry_run) {
      await supabase.from('campaigns').update({ status: 'sending' }).eq('id', campaign_id);
    }

    // Get recipients based on segment
    const { data: recipients, error: recipientsError } = await supabase
      .from('campaign_recipients')
      .select('*, client:clients(*)')
      .eq('campaign_id', campaign_id)
      .eq('status', 'pending');

    if (recipientsError) throw recipientsError;

    let sentCount = 0;
    let failedCount = 0;
    let excludedCount = 0;
    const results: Array<{ client_id: string; status: string; reason?: string }> = [];

    // Get provider credentials
    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
    const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER');
    const MANYCHAT_API_KEY = Deno.env.get('MANYCHAT_API_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

    for (const recipient of recipients || []) {
      const client = recipient.client;
      if (!client) continue;

      // Check guardrails
      let exclusionReason: string | null = null;

      // 1. Opt-out check
      if (campaign.respect_opt_out) {
        const { data: optOut } = await supabase
          .from('opt_outs')
          .select('*')
          .eq('client_id', client.id)
          .or(`channel.eq.all,channel.eq.${campaign.channel}`)
          .limit(1);
        
        if (optOut && optOut.length > 0) {
          exclusionReason = 'opted_out';
        }
      }

      // 2. No phone check for phone-based channels
      if (!exclusionReason && ['whatsapp', 'sms'].includes(campaign.channel) && !client.phone) {
        exclusionReason = 'no_phone';
      }

      // 3. No email check for email channel
      if (!exclusionReason && campaign.channel === 'email' && !client.email) {
        exclusionReason = 'no_email';
      }

      // 4. Dedupe check (24h by default)
      if (!exclusionReason && campaign.dedupe_hours > 0) {
        const { data: recentSends } = await supabase
          .from('campaign_recipients')
          .select('id')
          .eq('client_id', client.id)
          .eq('status', 'sent')
          .gte('sent_at', new Date(Date.now() - campaign.dedupe_hours * 60 * 60 * 1000).toISOString())
          .limit(1);
        
        if (recentSends && recentSends.length > 0) {
          exclusionReason = 'deduped';
        }
      }

      // 5. Exclude refunds/negatives (check for negative transactions)
      if (!exclusionReason && campaign.segment?.exclude_refunds) {
        const { data: refunds } = await supabase
          .from('transactions')
          .select('id')
          .eq('customer_email', client.email)
          .lt('amount', 0)
          .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
          .limit(1);
        
        if (refunds && refunds.length > 0) {
          exclusionReason = 'has_refund';
        }
      }

      // 6. Quiet hours check
      if (!exclusionReason && campaign.respect_quiet_hours) {
        const now = new Date();
        const currentHour = now.getHours();
        const startHour = parseInt(campaign.quiet_hours_start?.split(':')[0] || '22');
        const endHour = parseInt(campaign.quiet_hours_end?.split(':')[0] || '9');
        
        if (startHour > endHour) {
          // Overnight quiet hours (e.g., 22:00 - 09:00)
          if (currentHour >= startHour || currentHour < endHour) {
            exclusionReason = 'quiet_hours';
          }
        } else {
          // Same day quiet hours
          if (currentHour >= startHour && currentHour < endHour) {
            exclusionReason = 'quiet_hours';
          }
        }
      }

      // If excluded, update recipient and continue
      if (exclusionReason) {
        await supabase.from('campaign_recipients').update({
          status: 'excluded',
          exclusion_reason: exclusionReason,
        }).eq('id', recipient.id);
        
        excludedCount++;
        results.push({ client_id: client.id, status: 'excluded', reason: exclusionReason });
        continue;
      }

      // Dry run - don't actually send
      if (dry_run) {
        results.push({ client_id: client.id, status: 'would_send' });
        continue;
      }

      // Get real debt information for this client
      const debtInfo = await getClientDebtInfo(supabase, client.email);
      const formattedAmount = `$${(debtInfo.totalDebt / 100).toFixed(2)}`;
      const daysLeft = debtInfo.daysUntilDue !== null
        ? Math.max(0, debtInfo.daysUntilDue).toString()
        : 'N/A';

      // Build message from template with REAL variables
      let message = campaign.template?.content || '';
      const clientName = client.full_name || 'Cliente';
      message = message.replace(/\{\{name\}\}/g, clientName);
      message = message.replace(/\{\{amount\}\}/g, formattedAmount);
      message = message.replace(/\{\{days_left\}\}/g, daysLeft);

      let externalMessageId: string | null = null;
      let sendSuccess = false;

      try {
        // Send based on channel
        if (campaign.channel === 'whatsapp' && client.phone && TWILIO_ACCOUNT_SID) {
          let phoneNumber = client.phone.replace(/[^\d+]/g, '');
          if (!phoneNumber.startsWith('+')) {
            phoneNumber = phoneNumber.length === 10 ? '+1' + phoneNumber : '+' + phoneNumber;
          }

          const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
          const formData = new URLSearchParams();
          formData.append('To', `whatsapp:${phoneNumber}`);
          formData.append('From', `whatsapp:${TWILIO_PHONE_NUMBER}`);
          formData.append('Body', message);

          const response = await fetch(twilioUrl, {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData.toString(),
          });

          const result = await response.json();
          if (response.ok && result.sid) {
            sendSuccess = true;
            externalMessageId = result.sid;
          } else {
            console.error('WhatsApp send error:', result);
          }
        } else if (campaign.channel === 'sms' && client.phone && TWILIO_ACCOUNT_SID) {
          let phoneNumber = client.phone.replace(/[^\d+]/g, '');
          if (!phoneNumber.startsWith('+')) {
            phoneNumber = phoneNumber.length === 10 ? '+1' + phoneNumber : '+' + phoneNumber;
          }

          const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
          const formData = new URLSearchParams();
          formData.append('To', phoneNumber);
          formData.append('From', TWILIO_PHONE_NUMBER!);
          formData.append('Body', message);

          const response = await fetch(twilioUrl, {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData.toString(),
          });

          const result = await response.json();
          if (response.ok && result.sid) {
            sendSuccess = true;
            externalMessageId = result.sid;
          } else {
            console.error('SMS send error:', result);
          }
        } else if (campaign.channel === 'messenger' && MANYCHAT_API_KEY) {
          const searchField = client.email ? 'email' : 'phone';
          const searchValue = client.email || client.phone?.replace(/[^\d+]/g, '');

          const searchResponse = await fetch(
            `https://api.manychat.com/fb/subscriber/findBySystemField?field=${searchField}&value=${encodeURIComponent(searchValue!)}`,
            { headers: { 'Authorization': `Bearer ${MANYCHAT_API_KEY}` } }
          );
          const searchResult = await searchResponse.json();

          if (searchResult.status === 'success' && searchResult.data?.id) {
            const sendResponse = await fetch('https://api.manychat.com/fb/sending/sendContent', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                subscriber_id: searchResult.data.id,
                data: {
                  version: 'v2',
                  content: { messages: [{ type: 'text', text: message }] }
                }
              }),
            });
            const sendResult = await sendResponse.json();
            if (sendResult.status === 'success') {
              sendSuccess = true;
              externalMessageId = searchResult.data.id;
            } else {
              console.error('Messenger send error:', sendResult);
            }
          }
        } else if (campaign.channel === 'email') {
          // Check for email provider configuration
          if (!RESEND_API_KEY) {
            console.error('Email provider not configured: RESEND_API_KEY missing');
            await supabase.from('campaign_recipients').update({
              status: 'failed',
              exclusion_reason: 'email_provider_not_configured',
            }).eq('id', recipient.id);
            failedCount++;
            results.push({
              client_id: client.id,
              status: 'failed',
              reason: 'Email provider not configured'
            });
            continue;
          }

          if (!client.email) {
            exclusionReason = 'no_email';
          } else {
            // Build email subject from template or campaign name
            const emailSubject = campaign.template?.subject || campaign.name || 'Mensaje importante';

            // Send via Resend API
            const resendResponse = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                from: 'Cobranza <onboarding@resend.dev>', // Use Resend test domain, replace with verified domain in production
                to: [client.email],
                subject: emailSubject,
                html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                  <p style="font-size: 16px; line-height: 1.6; color: #333;">${message.replace(/\n/g, '<br>')}</p>
                  <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;">
                  <p style="font-size: 12px; color: #999; margin-top: 20px;">Este es un mensaje automatizado. Por favor no responda a este correo.</p>
                </div>`,
                text: message,
              }),
            });

            const resendResult = await resendResponse.json();
            console.log('Resend API response:', resendResponse.status, resendResult);

            if (resendResponse.ok && resendResult.id) {
              sendSuccess = true;
              externalMessageId = resendResult.id;
            } else {
              console.error('Resend error:', resendResult);
            }
          }
        }

        // Update recipient status
        if (sendSuccess) {
          await supabase.from('campaign_recipients').update({
            status: 'sent',
            external_message_id: externalMessageId,
            sent_at: new Date().toISOString(),
          }).eq('id', recipient.id);

          // Log to client_events
          await supabase.from('client_events').insert({
            client_id: client.id,
            event_type: 'email_sent',
            metadata: {
              channel: campaign.channel,
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              message_id: externalMessageId,
              amount_shown: formattedAmount,
              days_left_shown: daysLeft,
            }
          });

          sentCount++;
          results.push({ client_id: client.id, status: 'sent' });
        } else {
          await supabase.from('campaign_recipients').update({
            status: 'failed',
            exclusion_reason: 'send_failed',
          }).eq('id', recipient.id);
          
          failedCount++;
          results.push({ client_id: client.id, status: 'failed' });
        }

        // Rate limiting - wait between sends
        if (campaign.rate_limit_per_minute > 0) {
          const delayMs = Math.ceil(60000 / campaign.rate_limit_per_minute);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

      } catch (sendError) {
        console.error('Error sending to recipient:', sendError);
        await supabase.from('campaign_recipients').update({
          status: 'failed',
          exclusion_reason: 'error',
        }).eq('id', recipient.id);
        
        failedCount++;
        results.push({ client_id: client.id, status: 'failed', reason: 'error' });
      }
    }

    // Update campaign stats
    if (!dry_run) {
      await supabase.from('campaigns').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_count: sentCount,
        failed_count: failedCount,
      }).eq('id', campaign_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run,
        stats: {
          total: recipients?.length || 0,
          sent: sentCount,
          failed: failedCount,
          excluded: excludedCount,
        },
        results: dry_run ? results : undefined,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in send-campaign:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

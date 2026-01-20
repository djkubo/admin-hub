import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// SECURITY: Webhooks disabled until signature verification is configured
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // SECURITY: Webhook disabled - return 503 until signature verification is properly configured
  console.error('❌ ses-webhook: Webhook disabled until signature verification is configured');
  return new Response(
    JSON.stringify({ 
      error: 'Webhook disabled', 
      code: 'WEBHOOK_DISABLED',
      message: 'SES webhook is disabled until SNS signature verification is properly configured. Contact admin.'
    }),
    { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});

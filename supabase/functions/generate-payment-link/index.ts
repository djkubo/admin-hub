import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface GenerateLinkRequest {
  stripe_customer_id: string;
  invoice_id?: string;
  client_id?: string;
  customer_email?: string;
  customer_name?: string;
  expires_days?: number; // Default 7 days
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const payload: GenerateLinkRequest = await req.json();
    
    if (!payload.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: 'stripe_customer_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('📝 Generating payment link for:', payload.stripe_customer_id);

    // Generate unique token
    const token = crypto.randomUUID();
    
    // Calculate expiration (default 7 days)
    const expiresDays = payload.expires_days || 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresDays);

    // Check if there's already an active link for this invoice
    if (payload.invoice_id) {
      const { data: existingLink } = await supabase
        .from('payment_update_links')
        .select('token, expires_at')
        .eq('invoice_id', payload.invoice_id)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (existingLink) {
        console.log('♻️ Reusing existing payment link for invoice:', payload.invoice_id);
        const baseUrl = Deno.env.get('APP_URL') || 'https://zen-admin-joy.lovable.app';
        return new Response(
          JSON.stringify({
            success: true,
            token: existingLink.token,
            url: `${baseUrl}/update-card?token=${existingLink.token}`,
            expires_at: existingLink.expires_at,
            reused: true,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Insert new payment link
    const { data: link, error: insertError } = await supabase
      .from('payment_update_links')
      .insert({
        token,
        stripe_customer_id: payload.stripe_customer_id,
        invoice_id: payload.invoice_id || null,
        client_id: payload.client_id || null,
        customer_email: payload.customer_email || null,
        customer_name: payload.customer_name || null,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ Error creating payment link:', insertError);
      return new Response(
        JSON.stringify({ error: 'Failed to create payment link', details: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build the full URL
    const baseUrl = Deno.env.get('APP_URL') || 'https://zen-admin-joy.lovable.app';
    const fullUrl = `${baseUrl}/update-card?token=${token}`;

    console.log('✅ Payment link created:', fullUrl);

    return new Response(
      JSON.stringify({
        success: true,
        token,
        url: fullUrl,
        expires_at: expiresAt.toISOString(),
        link_id: link.id,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error in generate-payment-link:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

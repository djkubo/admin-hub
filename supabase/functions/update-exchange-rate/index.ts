import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RATE_APIS = [
  {
    name: 'exchangerate.host',
    url: 'https://api.exchangerate.host/latest?base=MXN&symbols=USD',
    extract: (data: any) => data?.rates?.USD,
  },
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.app/latest?from=MXN&to=USD',
    extract: (data: any) => data?.rates?.USD,
  },
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let rate: number | null = null;
    let apiSource = 'unknown';

    for (const api of RATE_APIS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(api.url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) continue;
        const data = await resp.json();
        const extracted = api.extract(data);
        if (typeof extracted === 'number' && extracted > 0 && extracted < 1) {
          rate = extracted;
          apiSource = api.name;
          break;
        }
      } catch { continue; }
    }

    if (!rate) {
      return new Response(
        JSON.stringify({ ok: false, error: 'All exchange rate APIs failed' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error: insertError } = await supabase
      .from('exchange_rates')
      .insert({ base_currency: 'MXN', target_currency: 'USD', rate, source: apiSource });

    if (insertError) {
      return new Response(
        JSON.stringify({ ok: false, error: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, rate, source: apiSource, message: `MXN→USD rate updated: ${rate}` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

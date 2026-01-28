import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ADMIN_KEY = 'vrp_admin_2026_K8p3dQ7xN2v9Lm5R1s0T4u6Yh8Gf3Jk'

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const requestId = crypto.randomUUID().slice(0, 8)
  console.log(`[${requestId}] vrp-brain-api: Start`)

  try {
    // ========== SECURITY CHECK ==========
    const providedKey = req.headers.get('x-admin-key')
    if (providedKey !== ADMIN_KEY) {
      console.warn(`[${requestId}] Unauthorized - Invalid key`)
      return new Response(
        JSON.stringify({ ok: false, error: 'Unauthorized', message: 'Invalid x-admin-key' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ========== PARSE BODY ==========
    const body = await req.json()
    const { action, ...params } = body

    if (!action) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing action field' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[${requestId}] Action: ${action}`)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    let result: any
    let error: any

    // ========== ACTION ROUTER ==========
    switch (action) {
      case 'identify':
        console.log(`[${requestId}] Calling unify_identity_v2 with params:`, JSON.stringify(params))
        const identifyResult = await supabase.rpc('unify_identity_v2', params)
        result = identifyResult.data
        error = identifyResult.error
        break

      case 'search':
        console.log(`[${requestId}] Calling match_knowledge`)
        const searchResult = await supabase.rpc('match_knowledge', params)
        result = searchResult.data
        error = searchResult.error
        break

      case 'insert':
        console.log(`[${requestId}] Inserting into table: ${params.table}`)
        if (!params.table || !params.data) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Insert requires "table" and "data" fields' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        const insertResult = await supabase.from(params.table).insert(params.data).select()
        result = insertResult.data
        error = insertResult.error
        break

      default:
        console.warn(`[${requestId}] Unknown action: ${action}`)
        return new Response(
          JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    if (error) {
      console.error(`[${requestId}] Error:`, JSON.stringify(error))
      return new Response(
        JSON.stringify({ ok: false, error: error.message, details: error }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[${requestId}] Success - Result:`, JSON.stringify(result))
    return new Response(
      JSON.stringify({ ok: true, data: result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Internal server error'
    console.error(`[${requestId}] Fatal error:`, err)
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const requestId = crypto.randomUUID().slice(0, 8)
  console.log(`[${requestId}] vrp-brain-api: Start`)

  try {
    // ========== SECURITY CHECK ==========
    const ADMIN_KEY = Deno.env.get('VRP_ADMIN_KEY')
    if (!ADMIN_KEY) {
      console.error(`[${requestId}] VRP_ADMIN_KEY not configured`)
      return new Response(
        JSON.stringify({ ok: false, error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
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
      case 'identify': {
        console.log(`[${requestId}] Calling unify_identity_v2 with params:`, JSON.stringify(params))
        const identifyResult = await supabase.rpc('unify_identity_v2', params)
        result = identifyResult.data
        error = identifyResult.error
        break
      }

      case 'search': {
        console.log(`[${requestId}] Calling match_knowledge`)
        const searchResult = await supabase.rpc('match_knowledge', params)
        result = searchResult.data
        error = searchResult.error
        break
      }

      case 'insert': {
        // Whitelist allowed tables for security
        const allowedTables = ['chat_events', 'lead_events']
        if (!params.table || !params.data) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Insert requires "table" and "data" fields' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        if (!allowedTables.includes(params.table)) {
          console.warn(`[${requestId}] Blocked insert attempt to table: ${params.table}`)
          return new Response(
            JSON.stringify({ ok: false, error: `Table '${params.table}' not allowed for insertion` }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        console.log(`[${requestId}] Inserting into table: ${params.table}`)
        const insertResult = await supabase.from(params.table).insert(params.data).select()
        result = insertResult.data
        error = insertResult.error
        break
      }

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

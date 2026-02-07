import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type EmbeddingResponse = { data?: Array<{ embedding?: number[] }> }

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const requestId = crypto.randomUUID().slice(0, 8)
  console.log(`[${requestId}] vrp-brain-api: Start`)

  try {
    // ========== SECURITY CHECK ==========
    // Support both:
    // 1) x-admin-key (VRP_ADMIN_KEY) for server-to-server ingestion scripts
    // 2) Authorization: Bearer <user JWT> for in-app admin users (validated via is_admin()).
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    const adminKey = Deno.env.get('VRP_ADMIN_KEY')
    const providedAdminKey = req.headers.get('x-admin-key')
    const authHeader = req.headers.get('Authorization')

    let authMode: 'admin_key' | 'jwt_is_admin' | null = null
    let requesterEmail: string | null = null

    if (adminKey && providedAdminKey && providedAdminKey === adminKey) {
      authMode = 'admin_key'
    } else if (authHeader?.startsWith('Bearer ')) {
      const authClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      })

      const {
        data: { user },
        error: userError,
      } = await authClient.auth.getUser()

      if (userError || !user) {
        console.warn(`[${requestId}] Unauthorized - invalid/expired JWT`, userError?.message)
        return new Response(
          JSON.stringify({ ok: false, error: 'Unauthorized', message: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data: isAdmin, error: adminError } = await authClient.rpc('is_admin')
      if (adminError || !isAdmin) {
        console.warn(`[${requestId}] Forbidden - not admin`, adminError?.message)
        return new Response(
          JSON.stringify({ ok: false, error: 'Forbidden', message: 'User is not an admin' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      authMode = 'jwt_is_admin'
      requesterEmail = user.email ?? null
    } else {
      console.warn(`[${requestId}] Unauthorized - missing auth`)
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Unauthorized',
          message: 'Provide x-admin-key or Authorization: Bearer <token>',
        }),
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
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    let result: any
    let error: any

    // Supabase vector types are commonly represented as strings (e.g. "[0.1,0.2,...]").
    // Accept either a vector-string or a JSON array of numbers for convenience.
    const toVectorString = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value
      if (Array.isArray(value) && value.every((n) => typeof n === 'number')) {
        return `[${value.join(',')}]`
      }
      return undefined
    }

    const embeddingModel = Deno.env.get('OPENAI_EMBEDDING_MODEL') || 'text-embedding-3-small' // 1536 dims
    const openAiApiKey = Deno.env.get('OPENAI_API_KEY')

    const createEmbedding = async (input: string): Promise<number[]> => {
      if (!openAiApiKey) throw new Error('OPENAI_API_KEY not configured')

      const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: embeddingModel,
          input,
        }),
      })

      const text = await resp.text()
      if (!resp.ok) throw new Error(`OpenAI embeddings failed (${resp.status}): ${text.slice(0, 200)}`)

      const json = JSON.parse(text) as EmbeddingResponse
      const embedding = json?.data?.[0]?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('OpenAI embeddings returned empty embedding')
      return embedding
    }

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
        // Allow query_embedding as a number[] or accept query_text and embed server-side.
        if (Array.isArray((params as any)?.query_embedding)) {
          const vec = toVectorString((params as any).query_embedding)
          if (vec) (params as any).query_embedding = vec
        } else if (typeof (params as any)?.query_text === 'string' && !(params as any)?.query_embedding) {
          const queryText = String((params as any).query_text).trim()
          if (!queryText) {
            return new Response(
              JSON.stringify({ ok: false, error: 'search requires query_embedding or non-empty query_text' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
          }
          const embedding = await createEmbedding(queryText)
          ;(params as any).query_embedding = toVectorString(embedding)
          delete (params as any).query_text
        }
        const searchResult = await supabase.rpc('match_knowledge', params)
        result = searchResult.data
        error = searchResult.error
        break
      }

      case 'insert': {
        // Whitelist allowed tables for security
        const allowedTables = ['chat_events', 'lead_events', 'vrp_knowledge']
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
        // If inserting vectors, accept embedding as number[] and convert to vector string.
        if (params.table === 'vrp_knowledge' && typeof params.data === 'object' && params.data) {
          const d = params.data as { content?: unknown; embedding?: unknown }

          // If no embedding provided, compute on the server (uses OPENAI_API_KEY).
          if (d.embedding === undefined || d.embedding === null || d.embedding === '') {
            const content = typeof d.content === 'string' ? d.content.trim() : ''
            if (!content) {
              return new Response(
                JSON.stringify({ ok: false, error: 'vrp_knowledge insert requires non-empty content' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              )
            }
            const embedding = await createEmbedding(content)
            d.embedding = toVectorString(embedding)
          }

          if (Array.isArray(d.embedding)) {
            const vec = toVectorString(d.embedding)
            if (vec) d.embedding = vec
          }
        }
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

    console.log(`[${requestId}] Success (${authMode}${requesterEmail ? `:${requesterEmail}` : ''}) - Result:`, JSON.stringify(result))
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

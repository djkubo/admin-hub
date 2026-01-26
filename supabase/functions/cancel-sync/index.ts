import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createLogger, LogLevel } from '../_shared/logger.ts';

const logger = createLogger('cancel-sync', LogLevel.INFO);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return { valid: false, error: 'Missing Authorization header' };
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
        return { valid: false, error: 'Invalid token' };
    }

    const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
    if (adminError || !isAdmin) {
        return { valid: false, error: 'Not authorized as admin' };
    }

    return { valid: true, userId: user.id };
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        // Verify admin
        const authCheck = await verifyAdmin(req);
        if (!authCheck.valid) {
            return new Response(
                JSON.stringify({ ok: false, error: authCheck.error }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        logger.info('Admin verified for cancel-sync');

        const { syncRunId } = await req.json();

        if (!syncRunId) {
            return new Response(
                JSON.stringify({ ok: false, error: 'syncRunId required' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Update sync run to canceled status
        const { data, error } = await supabase
            .from('sync_runs')
            .update({
                status: 'canceled',
                completed_at: new Date().toISOString(),
                error_message: 'Canceled by user'
            })
            .eq('id', syncRunId)
            .in('status', ['running', 'continuing'])
            .select()
            .single();

        if (error) {
            logger.error('Failed to cancel sync', error, { syncRunId });
            return new Response(
                JSON.stringify({ ok: false, error: 'Failed to cancel sync' }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        if (!data) {
            logger.warn('Sync not found or already completed', { syncRunId });
            return new Response(
                JSON.stringify({ ok: false, error: 'Sync not found or already completed' }),
                { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        logger.info('Sync canceled successfully', { syncRunId, source: data.source });

        return new Response(
            JSON.stringify({ ok: true, syncRun: data }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        logger.error('Cancel sync error', error instanceof Error ? error : new Error(String(error)));
        return new Response(
            JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});

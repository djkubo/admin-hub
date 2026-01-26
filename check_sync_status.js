// Quick sync status checker
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const supabaseUrl = Deno.env.get('VITE_SUPABASE_URL') || Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('VITE_SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY');

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE env vars');
    Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

console.log('🔍 Checking sync status...\n');

// Get recent sync runs
const { data: syncs, error } = await supabase
    .from('sync_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(5);

if (error) {
    console.error('❌ Error:', error.message);
    Deno.exit(1);
}

syncs.forEach((sync, i) => {
    const age = Math.floor((Date.now() - new Date(sync.started_at).getTime()) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;

    console.log(`${i + 1}. ${sync.source} (${sync.status})`);
    console.log(`   Started: ${ageStr}`);
    console.log(`   Records: ${sync.total_fetched || 0}`);

    if (sync.status === 'running' || sync.status === 'continuing') {
        console.log(`   ⚡ ACTIVE SYNC`);
        if (sync.metadata?.currentStep) {
            console.log(`   Step: ${sync.metadata.currentStep}`);
        }
    }

    if (sync.error_message) {
        console.log(`   ❌ Error: ${sync.error_message}`);
    }
    console.log('');
});

// Check for stuck syncs
const stuckSyncs = syncs.filter(s =>
    (s.status === 'running' || s.status === 'continuing') &&
    (Date.now() - new Date(s.started_at).getTime()) > 5 * 60 * 1000 // > 5 minutes
);

if (stuckSyncs.length > 0) {
    console.log('⚠️  STUCK SYNCS DETECTED (running > 5 min):');
    stuckSyncs.forEach(s => console.log(`   - ${s.id} (${s.source})`));
}

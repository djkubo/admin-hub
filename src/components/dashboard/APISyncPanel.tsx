import { useState, useRef, useCallback } from 'react';
import { RefreshCw, Loader2, CheckCircle, AlertCircle, Zap, History, Clock, MessageCircle, Users, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { supabase } from '@/integrations/supabase/client';
import type { 
  SyncResult,
  FetchStripeBody,
  FetchStripeResponse,
  FetchPayPalBody,
  FetchPayPalResponse,
  SyncContactsBody,
  SyncContactsResponse
} from '@/types/edgeFunctions';

// Helper to safely format error messages (avoid [object Object])
const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (obj.message) return String(obj.message);
    if (obj.error) return String(obj.error);
    try {
      return JSON.stringify(error);
    } catch {
      return 'Error desconocido';
    }
  }
  return 'Error desconocido';
};

export function APISyncPanel() {
  const queryClient = useQueryClient();
  const [stripeSyncing, setStripeSyncing] = useState(false);
  const [paypalSyncing, setPaypalSyncing] = useState(false);
  const [manychatSyncing, setManychatSyncing] = useState(false);
  const [ghlSyncing, setGhlSyncing] = useState(false);
  const [invoicesSyncing, setInvoicesSyncing] = useState(false);
  const [stripeResult, setStripeResult] = useState<SyncResult | null>(null);
  const [paypalResult, setPaypalResult] = useState<SyncResult | null>(null);
  const [manychatResult, setManychatResult] = useState<SyncResult | null>(null);
  const [ghlResult, setGhlResult] = useState<SyncResult | null>(null);
  const [invoicesResult, setInvoicesResult] = useState<SyncResult | null>(null);
  const [stripeProgress, setStripeProgress] = useState<{ current: number; total: number } | null>(null);
  const [paypalProgress, setPaypalProgress] = useState<{ current: number; total: number } | null>(null);
  const [invoicesProgress, setInvoicesProgress] = useState<{ current: number; total: number } | null>(null);

  // Helper to sync in chunks to avoid timeouts - now with per-service progress
  const syncInChunks = async (
    service: 'stripe' | 'paypal',
    years: number,
    setResult: (r: SyncResult) => void,
    setProgress: (p: { current: number; total: number } | null) => void
  ): Promise<{ synced_transactions: number; synced_clients: number; paid_count: number; failed_count: number }> => {
    const now = new Date();
    const allResults = { synced_transactions: 0, synced_clients: 0, paid_count: 0, failed_count: 0 };
    
    // Sync in 30-day chunks to avoid API limits and timeouts
    const totalChunks = Math.ceil(years * 12); // Monthly chunks
    
    for (let i = 0; i < totalChunks; i++) {
      setProgress({ current: i + 1, total: totalChunks });
      
      const endDate = new Date(now.getTime() - (i * 31 * 24 * 60 * 60 * 1000));
      const startDate = new Date(endDate.getTime() - (31 * 24 * 60 * 60 * 1000));
      
      try {
        if (service === 'stripe') {
          const data = await invokeWithAdminKey<FetchStripeResponse, FetchStripeBody>(
            'fetch-stripe',
            { 
              fetchAll: true,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString()
            }
          );
          if (data?.success) {
            allResults.synced_transactions += data.synced_transactions ?? 0;
            allResults.paid_count += data.paid_count ?? 0;
            allResults.failed_count += data.failed_count ?? 0;
          }
        } else {
          // PayPal: Loop through ALL internal pages for this chunk
          let paypalSyncRunId: string | null = null;
          let paypalHasMore = true;
          let paypalPage = 1;
          
          while (paypalHasMore && paypalPage <= 500) {
            const data = await invokeWithAdminKey<FetchPayPalResponse, FetchPayPalBody>(
              'fetch-paypal',
              { 
                fetchAll: true,
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                syncRunId: paypalSyncRunId,
                page: paypalPage
              }
            );
            
            if (!data?.success) {
              console.error(`PayPal page ${paypalPage} failed:`, data?.error);
              break;
            }
            
            // Track sync run ID across pages
            paypalSyncRunId = data.syncRunId || paypalSyncRunId;
            
            // Accumulate results
            allResults.synced_transactions += data.synced_transactions ?? 0;
            allResults.paid_count += data.paid_count ?? 0;
            allResults.failed_count += data.failed_count ?? 0;
            
            // Check pagination
            paypalHasMore = data.hasMore === true;
            paypalPage = data.nextPage || (paypalPage + 1);
            
            // Rate limit delay
            if (paypalHasMore) {
              await new Promise(r => setTimeout(r, 200));
            }
          }
        }
      } catch (err) {
        console.error(`Chunk ${i + 1} failed:`, err);
        // Continue with next chunk
      }
    }
    
    setProgress(null);
    setResult({ 
      success: true, 
      ...allResults,
      message: `Sincronizado historial completo (${years} años)` 
    });
    
    return allResults;
  };

  // Polling refs to allow cleanup
  const stripePollingRef = useRef<number | null>(null);
  const invoicesPollingRef = useRef<number | null>(null);

  // Poll sync_runs for progress updates (Stripe)
  const pollSyncProgress = useCallback(async (syncRunId: string, source: 'stripe') => {
    // Clear any existing polling
    if (stripePollingRef.current) {
      clearTimeout(stripePollingRef.current);
    }

    const poll = async () => {
      try {
        const { data, error } = await supabase
          .from('sync_runs')
          .select('status, total_fetched, total_inserted')
          .eq('id', syncRunId)
          .single();
        
        if (error || !data) {
          console.error('Polling error:', error);
          return;
        }
        
        if (data.status === 'running' || data.status === 'continuing') {
          setStripeProgress({ current: data.total_fetched || 0, total: 0 });
          toast.info(`Stripe: ${(data.total_fetched || 0).toLocaleString()} transacciones...`, { 
            id: 'stripe-sync' 
          });
          stripePollingRef.current = window.setTimeout(poll, 3000);
        } else if (data.status === 'completed') {
          setStripeProgress(null);
          setStripeResult({ 
            success: true, 
            synced_transactions: data.total_inserted ?? 0,
            message: 'Sincronización completada'
          });
          toast.success(`Stripe: ${(data.total_inserted ?? 0).toLocaleString()} transacciones sincronizadas`, {
            id: 'stripe-sync'
          });
          queryClient.invalidateQueries({ queryKey: ['transactions'] });
          queryClient.invalidateQueries({ queryKey: ['clients'] });
          setStripeSyncing(false);
        } else if (data.status === 'error' || data.status === 'cancelled') {
          setStripeProgress(null);
          setStripeResult({ success: false, error: 'Sync failed or cancelled' });
          toast.error('Stripe: Sincronización falló', { id: 'stripe-sync' });
          setStripeSyncing(false);
        }
      } catch (err) {
        console.error('Poll error:', err);
      }
    };
    
    poll();
  }, [queryClient]);

  // Poll sync_runs for invoices progress updates
  const pollInvoiceProgress = useCallback(async (syncRunId: string) => {
    // Clear any existing polling
    if (invoicesPollingRef.current) {
      clearTimeout(invoicesPollingRef.current);
    }

    const poll = async () => {
      try {
        const { data, error } = await supabase
          .from('sync_runs')
          .select('status, total_fetched, total_inserted, metadata')
          .eq('id', syncRunId)
          .single();
        
        if (error || !data) {
          console.error('Invoice polling error:', error);
          return;
        }
        
        if (data.status === 'running' || data.status === 'continuing') {
          setInvoicesProgress({ current: data.total_fetched || 0, total: 0 });
          toast.info(`Facturas: ${(data.total_fetched || 0).toLocaleString()} sincronizadas...`, { 
            id: 'invoices-sync' 
          });
          invoicesPollingRef.current = window.setTimeout(poll, 3000);
        } else if (data.status === 'completed') {
          setInvoicesProgress(null);
          const metadata = data.metadata as { stats?: { paid?: number; open?: number; draft?: number } } | null;
          const stats = metadata?.stats || { paid: 0, open: 0, draft: 0 };
          
          setInvoicesResult({ 
            success: true, 
            synced_transactions: data.total_inserted ?? 0,
            total_inserted: data.total_inserted ?? 0,
            message: `${data.total_inserted} facturas sincronizadas (${stats.paid || 0} pagadas, ${stats.open || 0} abiertas)`
          });
          toast.success(`Facturas: ${(data.total_inserted ?? 0).toLocaleString()} sincronizadas`, {
            id: 'invoices-sync'
          });
          queryClient.invalidateQueries({ queryKey: ['invoices'] });
          queryClient.invalidateQueries({ queryKey: ['pending-invoices'] });
          setInvoicesSyncing(false);
        } else if (data.status === 'error' || data.status === 'cancelled') {
          setInvoicesProgress(null);
          setInvoicesResult({ success: false, error: 'Sync failed or cancelled' });
          toast.error('Facturas: Sincronización falló', { id: 'invoices-sync' });
          setInvoicesSyncing(false);
        }
      } catch (err) {
        console.error('Invoice poll error:', err);
      }
    };
    
    poll();
  }, [queryClient]);

  const syncStripe = async (mode: 'last24h' | 'last31d' | 'all6months' | 'allHistory') => {
    setStripeSyncing(true);
    setStripeResult(null);
    
    try {
      let startDate: Date;
      const endDate = new Date();
      
      // Calculate date range based on mode
      switch (mode) {
        case 'last24h':
          startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'last31d':
          startDate = new Date(endDate.getTime() - 31 * 24 * 60 * 60 * 1000);
          break;
        case 'all6months':
          startDate = new Date(endDate.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);
          break;
        case 'allHistory':
        default:
          startDate = new Date(endDate.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);
          break;
      }
      
      // ONE single call - backend handles all pagination in background
      const data = await invokeWithAdminKey<FetchStripeResponse, FetchStripeBody>(
        'fetch-stripe', 
        { 
          fetchAll: true,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        }
      );

      // Check if it's running in background
      if (data.status === 'running' && data.syncRunId) {
        toast.info('Stripe: Sincronización iniciada en background...', { id: 'stripe-sync' });
        pollSyncProgress(data.syncRunId, 'stripe');
        // Don't setStripeSyncing(false) - polling will handle it
        return;
      } else if (data.success) {
        setStripeResult(data);
        const modeLabel = mode === 'last24h' ? '24h' : mode === 'last31d' ? '31 días' : mode === 'all6months' ? '6 meses' : 'historial completo';
        toast.success(`Stripe (${modeLabel}): ${(data.synced_transactions ?? 0).toLocaleString()} transacciones sincronizadas`);
      }
      
      // Refresh all data
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients-count'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setStripeResult({ success: false, error: errorMessage });
      toast.error(`Error sincronizando Stripe: ${errorMessage}`);
    } finally {
      // Only set syncing to false if not polling
      if (!stripePollingRef.current) {
        setStripeSyncing(false);
        setStripeProgress(null);
      }
    }
  };

  const syncPayPal = async (mode: 'last24h' | 'last31d' | 'all6months' | 'allHistory') => {
    setPaypalSyncing(true);
    setPaypalResult(null);
    
    try {
      if (mode === 'last24h') {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const data = await invokeWithAdminKey<FetchPayPalResponse, FetchPayPalBody>(
          'fetch-paypal', 
          { 
            fetchAll: true,
            startDate: yesterday.toISOString(),
            endDate: now.toISOString()
          }
        );

        setPaypalResult(data);
        
        if (data.success) {
          toast.success(`PayPal (24h): ${data.synced_transactions ?? 0} transacciones sincronizadas`);
        }
      } else if (mode === 'last31d') {
        const now = new Date();
        const startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        
        const data = await invokeWithAdminKey<FetchPayPalResponse, FetchPayPalBody>(
          'fetch-paypal', 
          { 
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: now.toISOString()
          }
        );

        setPaypalResult(data);
        
        if (data.success) {
          toast.success(`PayPal (31 días): ${data.synced_transactions ?? 0} transacciones sincronizadas`);
        }
      } else if (mode === 'all6months') {
        const results = await syncInChunks('paypal', 0.5, setPaypalResult, setPaypalProgress);
        toast.success(`PayPal: ${results.synced_transactions} transacciones sincronizadas (6 meses)`);
      } else if (mode === 'allHistory') {
        // PayPal API only allows 3 years max - use 2.5 to be safe
        const results = await syncInChunks('paypal', 2.5, setPaypalResult, setPaypalProgress);
        toast.success(`PayPal: ${results.synced_transactions} transacciones sincronizadas (historial completo)`);
      }
      
      // Refresh all data
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients-count'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setPaypalResult({ success: false, error: errorMessage });
      toast.error(`Error sincronizando PayPal: ${errorMessage}`);
    } finally {
      setPaypalSyncing(false);
      setPaypalProgress(null);
    }
  };

  // Standard sync response type from unified Edge Functions
  interface StandardSyncResponse {
    ok: boolean;
    status: 'completed' | 'continuing' | 'error' | 'already_running';
    syncRunId?: string;
    processed?: number;
    hasMore?: boolean;
    nextCursor?: string | null;
    duration_ms?: number;
    error?: string;
    stats?: {
      total_fetched?: number;
      total_inserted?: number;
      total_updated?: number;
      total_skipped?: number;
      total_conflicts?: number;
    };
  }

  const syncManyChat = async () => {
    setManychatSyncing(true);
    setManychatResult(null);
    
    try {
      let totalProcessed = 0;
      let totalInserted = 0;
      let totalUpdated = 0;
      let hasMore = true;
      let cursor: number | undefined = undefined;
      let syncRunId: string | undefined = undefined;

      // Paginated sync loop
      while (hasMore) {
        const data = await invokeWithAdminKey<StandardSyncResponse>(
          'sync-manychat', 
          { dry_run: false, cursor, syncRunId }
        );

        if (!data?.ok) {
          throw new Error(data?.error || 'Sync failed');
        }

        syncRunId = data.syncRunId;
        totalProcessed += data.processed ?? 0;
        totalInserted += data.stats?.total_inserted ?? 0;
        totalUpdated += data.stats?.total_updated ?? 0;
        
        hasMore = data.hasMore ?? false;
        cursor = data.nextCursor ? parseInt(data.nextCursor) : undefined;
      }

      setManychatResult({
        success: true,
        total_fetched: totalProcessed,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
      });
      
      toast.success(`ManyChat: ${totalProcessed} contactos sincronizados (${totalInserted} nuevos, ${totalUpdated} actualizados)`);
      
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients-count'] });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setManychatResult({ success: false, error: errorMessage });
      toast.error(`Error sincronizando ManyChat: ${errorMessage}`);
    } finally {
      setManychatSyncing(false);
    }
  };

  // Extended response for GHL stage-only mode
  interface GHLSyncResponse extends StandardSyncResponse {
    staged?: number;
    stageOnly?: boolean;
    nextStartAfterId?: string | null;
    nextStartAfter?: number | null;
  }

  const syncGHL = async () => {
    setGhlSyncing(true);
    setGhlResult(null);
    
    try {
      let totalProcessed = 0;
      let totalStaged = 0;
      let hasMore = true;
      let startAfterId: string | null = null;
      let startAfter: number | null = null;
      let syncRunId: string | undefined = undefined;
      let page = 0;

      // Paginated sync loop - handles 150k+ contacts
      // Using stageOnly mode for "stage first, merge later" architecture
      while (hasMore) {
        page++;
        
        const data = await invokeWithAdminKey<GHLSyncResponse>(
          'sync-ghl', 
          { 
            dry_run: false, 
            stageOnly: true, // Stage only - no immediate merge
            startAfterId,
            startAfter,
            syncRunId 
          }
        );

        if (!data?.ok) {
          // Check for already running
          if (data?.status === 'already_running') {
            toast.info('Ya hay un sync de GHL en progreso');
            setGhlResult({ success: true, message: 'Sync en progreso...' });
            return;
          }
          throw new Error(data?.error || 'Sync failed');
        }

        syncRunId = data.syncRunId;
        totalProcessed += data.processed ?? 0;
        totalStaged += data.staged ?? data.processed ?? 0;
        
        hasMore = data.hasMore ?? false;
        startAfterId = data.nextStartAfterId ?? null;
        startAfter = data.nextStartAfter ?? null;

        // Progress toast every 5 pages
        if (page % 5 === 0) {
          toast.info(`GHL: ${totalStaged} contactos descargados...`, { id: 'ghl-progress' });
        }

        // Small delay between pages to avoid rate limits
        if (hasMore) {
          await new Promise(r => setTimeout(r, 150));
        }

        // Safety limit: 2000 pages = 200k contacts
        if (page >= 2000) {
          console.log('GHL sync reached page limit');
          break;
        }
      }

      setGhlResult({
        success: true,
        total_fetched: totalStaged,
        message: `${totalStaged} contactos descargados a staging`
      });
      
      toast.success(`GoHighLevel: ${totalStaged} contactos descargados (listos para unificar)`, { id: 'ghl-progress' });
      
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients-count'] });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setGhlResult({ success: false, error: errorMessage });
      toast.error(`Error sincronizando GoHighLevel: ${errorMessage}`);
    } finally {
      setGhlSyncing(false);
    }
  };

  const syncInvoices = async (mode: 'recent' | 'full') => {
    setInvoicesSyncing(true);
    setInvoicesResult(null);
    setInvoicesProgress(null);
    
    try {
      // ONE single call with fetchAll=true - backend handles all pagination in background
      const data = await invokeWithAdminKey<{
        success: boolean;
        synced: number;
        upserted: number;
        hasMore: boolean;
        nextCursor: string | null;
        syncRunId: string | null;
        status?: 'running' | 'completed' | 'error';
        stats?: { draft: number; open: number; paid: number; void: number; uncollectible: number };
        error?: string;
      }>('fetch-invoices', {
        mode,
        fetchAll: true, // NEW: Process all pages in background
      });

      if (!data.success && data.error) {
        throw new Error(data.error);
      }

      // Check if it's running in background
      if (data.status === 'running' && data.syncRunId) {
        toast.info('Facturas: Sincronización iniciada en background...', { id: 'invoices-sync' });
        pollInvoiceProgress(data.syncRunId);
        // Don't setInvoicesSyncing(false) - polling will handle it
        return;
      } else if (data.success) {
        // Immediate completion (unlikely for large datasets)
        setInvoicesResult({
          success: true,
          synced_transactions: data.upserted || 0,
          total_inserted: data.upserted || 0,
          message: `${data.upserted} facturas sincronizadas`
        });
        toast.success(`Facturas: ${data.upserted} sincronizadas`, { id: 'invoices-sync' });
      }
      
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['pending-invoices'] });
    } catch (error) {
      const errorMessage = formatError(error);
      setInvoicesResult({ success: false, error: errorMessage });
      toast.error(`Error sincronizando facturas: ${errorMessage}`);
      setInvoicesSyncing(false);
      setInvoicesProgress(null);
    }
    // Note: Don't set syncing=false in finally - polling handles it for background mode
  };

  const syncAllHistory = async () => {
    // Run sequentially to avoid rate limits
    await syncStripe('allHistory');
    await syncPayPal('allHistory');
  };

  // Each sync can run independently - no global blocking
  return (
    <Card className="bg-[#1a1f36] border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg text-white">Sincronización API</CardTitle>
            <CardDescription>
              Importa automáticamente todas las transacciones desde Stripe y PayPal
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stripe Progress indicator */}
        {stripeProgress && (
          <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/30 space-y-2">
            <div className="flex items-center gap-2 text-sm text-purple-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Stripe: {stripeProgress.current.toLocaleString()} transacciones sincronizadas</span>
            </div>
            <Progress 
              value={100} 
              className="h-2 animate-pulse"
            />
            <p className="text-xs text-gray-400">
              Procesando en background... Actualizando cada 3s
            </p>
          </div>
        )}

        {/* PayPal Progress indicator */}
        {paypalProgress && (
          <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/30 space-y-2">
            <div className="flex items-center gap-2 text-sm text-yellow-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>PayPal: Mes {paypalProgress.current}/{paypalProgress.total}</span>
            </div>
            <Progress 
              value={(paypalProgress.current / paypalProgress.total) * 100} 
              className="h-2"
            />
            <p className="text-xs text-gray-400">
              Procesando... {paypalProgress.current} de {paypalProgress.total} períodos
            </p>
          </div>
        )}

        {/* Stripe Sync */}
        <div className="p-4 bg-[#0f1225] rounded-lg border border-gray-700/50 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <span className="text-purple-400 font-bold text-sm">S</span>
              </div>
              <div>
                <h4 className="font-medium text-white">Stripe</h4>
                <p className="text-xs text-gray-400">
                  {stripeResult?.success 
                    ? `${stripeResult.synced_transactions} transacciones (${stripeResult.paid_count} pagos, ${stripeResult.failed_count} fallidos)`
                    : 'Sincroniza desde Stripe API'
                  }
                </p>
              </div>
            </div>
            {stripeResult && (
              <Badge variant={stripeResult.success ? 'default' : 'destructive'} className="gap-1">
                {stripeResult.success ? (
                  <><CheckCircle className="h-3 w-3" /> OK</>
                ) : (
                  <><AlertCircle className="h-3 w-3" /> Error</>
                )}
              </Badge>
            )}
          </div>
          
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('last24h')}
              disabled={stripeSyncing}
              className="gap-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Últimas 24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('last31d')}
              disabled={stripeSyncing}
              className="gap-2"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              31 días
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('all6months')}
              disabled={stripeSyncing}
              className="gap-2"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              6 Meses
            </Button>
            <Button
              size="sm"
              onClick={() => syncStripe('allHistory')}
              disabled={stripeSyncing}
              className="gap-2 bg-purple-600 hover:bg-purple-700"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Todo Historial
            </Button>
          </div>
        </div>

        {/* PayPal Sync */}
        <div className="p-4 bg-[#0f1225] rounded-lg border border-gray-700/50 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-yellow-500/20 flex items-center justify-center">
                <span className="text-yellow-400 font-bold text-sm">P</span>
              </div>
              <div>
                <h4 className="font-medium text-white">PayPal</h4>
                <p className="text-xs text-gray-400">
                  {paypalResult?.success 
                    ? `${paypalResult.synced_transactions} transacciones (${paypalResult.paid_count} pagos, ${paypalResult.failed_count} fallidos)`
                    : 'Sincroniza desde PayPal API'
                  }
                </p>
              </div>
            </div>
            {paypalResult && (
              <Badge variant={paypalResult.success ? 'default' : 'destructive'} className="gap-1">
                {paypalResult.success ? (
                  <><CheckCircle className="h-3 w-3" /> OK</>
                ) : (
                  <><AlertCircle className="h-3 w-3" /> Error</>
                )}
              </Badge>
            )}
          </div>
          
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('last24h')}
              disabled={paypalSyncing}
              className="gap-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Últimas 24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('last31d')}
              disabled={paypalSyncing}
              className="gap-2"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              31 días
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('all6months')}
              disabled={paypalSyncing}
              className="gap-2"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              6 Meses
            </Button>
            <Button
              size="sm"
              onClick={() => syncPayPal('allHistory')}
              disabled={paypalSyncing}
              className="gap-2 bg-yellow-600 hover:bg-yellow-700"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Todo Historial
            </Button>
          </div>
        </div>

        {/* Invoices/Facturas Sync */}
        <div className="p-4 bg-[#0f1225] rounded-lg border border-cyan-500/30 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                <FileText className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <h4 className="font-medium text-white">Facturas Stripe</h4>
                <p className="text-xs text-gray-400">
                  {invoicesResult?.success 
                    ? invoicesResult.message
                    : 'Sincroniza todas las facturas (draft, open, paid, void)'
                  }
                </p>
              </div>
            </div>
            {invoicesResult && (
              <Badge variant={invoicesResult.success ? 'default' : 'destructive'} className="gap-1">
                {invoicesResult.success ? (
                  <><CheckCircle className="h-3 w-3" /> OK</>
                ) : (
                  <><AlertCircle className="h-3 w-3" /> Error</>
                )}
              </Badge>
            )}
          </div>
          
          {invoicesProgress && (
            <div className="flex items-center gap-2 text-xs text-cyan-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Página {invoicesProgress.current}...</span>
            </div>
          )}
          
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncInvoices('recent')}
              disabled={invoicesSyncing}
              className="gap-2 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10"
            >
              {invoicesSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Últimos 90 días
            </Button>
            <Button
              size="sm"
              onClick={() => syncInvoices('full')}
              disabled={invoicesSyncing}
              className="gap-2 bg-cyan-600 hover:bg-cyan-700"
            >
              {invoicesSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Todo Historial
            </Button>
          </div>
          
          <p className="text-xs text-gray-500">
            📄 Sincroniza facturas con status, paid_at, raw_data y client_id vinculado
          </p>
        </div>

        <div className="p-4 bg-[#0f1225] rounded-lg border border-blue-500/30 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <MessageCircle className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <h4 className="font-medium text-white">ManyChat</h4>
                <p className="text-xs text-gray-400">
                  {manychatResult?.success 
                    ? `${manychatResult.total_fetched} contactos (${manychatResult.total_inserted} nuevos, ${manychatResult.total_updated} actualizados)`
                    : 'Sincroniza todos tus suscriptores de ManyChat'
                  }
                </p>
              </div>
            </div>
            {manychatResult && (
              <Badge variant={manychatResult.success ? 'default' : 'destructive'} className="gap-1">
                {manychatResult.success ? (
                  <><CheckCircle className="h-3 w-3" /> OK</>
                ) : (
                  <><AlertCircle className="h-3 w-3" /> Error</>
                )}
              </Badge>
            )}
          </div>
          
          <Button
            onClick={syncManyChat}
            disabled={manychatSyncing}
            className="w-full gap-2 bg-blue-600 hover:bg-blue-700"
          >
            {manychatSyncing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sincronizando contactos...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Importar Todos los Contactos
              </>
            )}
          </Button>
          
          <p className="text-xs text-gray-500">
            📱 Importa suscriptores de Instagram, Messenger y WhatsApp. Unifica por email/phone.
          </p>
        </div>

        {/* GoHighLevel Sync */}
        <div className="p-4 bg-[#0f1225] rounded-lg border border-green-500/30 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                <Users className="h-5 w-5 text-green-400" />
              </div>
              <div>
                <h4 className="font-medium text-white">GoHighLevel</h4>
                <p className="text-xs text-gray-400">
                  {ghlResult?.success 
                    ? (ghlResult.message || `${ghlResult.total_fetched?.toLocaleString() || 0} contactos (${ghlResult.total_inserted?.toLocaleString() || 0} nuevos, ${ghlResult.total_updated?.toLocaleString() || 0} actualizados)`)
                    : ghlResult?.error
                      ? ghlResult.error
                      : 'Sincroniza todos tus contactos de GHL (150k+ soportado)'
                  }
                </p>
              </div>
            </div>
            {ghlResult && (
              <Badge variant={ghlResult.success ? 'default' : 'destructive'} className="gap-1">
                {ghlResult.success ? (
                  <><CheckCircle className="h-3 w-3" /> OK</>
                ) : (
                  <><AlertCircle className="h-3 w-3" /> Error</>
                )}
              </Badge>
            )}
          </div>
          
          <Button
            onClick={syncGHL}
            disabled={ghlSyncing}
            className="w-full gap-2 bg-green-600 hover:bg-green-700"
          >
            {ghlSyncing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sincronizando contactos...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4" />
                Importar Todos los Contactos
              </>
            )}
          </Button>
          
          <p className="text-xs text-gray-500">
            📋 Importa contactos de tu CRM GoHighLevel. Unifica por email/phone.
          </p>
        </div>

        {/* Sync All Button */}
        <Button 
          onClick={syncAllHistory}
          disabled={stripeSyncing || paypalSyncing}
          className="w-full bg-gradient-to-r from-purple-600 to-yellow-600 hover:from-purple-700 hover:to-yellow-700"
        >
          {(stripeSyncing || paypalSyncing) ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sincronizando...
            </>
          ) : (
            <>
              <History className="mr-2 h-4 w-4" />
              Sincronizar TODO el Historial (Stripe + PayPal)
            </>
          )}
        </Button>

        <p className="text-xs text-gray-500 text-center">
          💡 Backend procesa todo el historial automáticamente con paginación interna
        </p>
      </CardContent>
    </Card>
  );
}

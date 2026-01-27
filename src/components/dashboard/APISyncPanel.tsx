import { useState } from 'react';
import { RefreshCw, Loader2, CheckCircle, AlertCircle, Zap, History, Clock, MessageCircle, Users, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { invokeWithAdminKey } from '@/lib/adminApi';
import type { 
  SyncResult,
  FetchStripeBody,
  FetchStripeResponse,
  FetchPayPalBody,
  FetchPayPalResponse,
  SyncContactsBody,
  SyncContactsResponse
} from '@/types/edgeFunctions';

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
          const data = await invokeWithAdminKey<FetchPayPalResponse, FetchPayPalBody>(
            'fetch-paypal',
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

  const syncStripe = async (mode: 'last24h' | 'last31d' | 'all6months' | 'allHistory') => {
    setStripeSyncing(true);
    setStripeResult(null);
    
    try {
      if (mode === 'last24h') {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const data = await invokeWithAdminKey<FetchStripeResponse, FetchStripeBody>(
          'fetch-stripe', 
          { 
            fetchAll: true,
            startDate: yesterday.toISOString(),
            endDate: now.toISOString()
          }
        );

        setStripeResult(data);
        
        if (data.success) {
          toast.success(`Stripe (24h): ${data.synced_transactions ?? 0} transacciones sincronizadas`);
        }
      } else if (mode === 'last31d') {
        const now = new Date();
        const startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        
        const data = await invokeWithAdminKey<FetchStripeResponse, FetchStripeBody>(
          'fetch-stripe', 
          { 
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: now.toISOString()
          }
        );

        setStripeResult(data);
        
        if (data.success) {
          toast.success(`Stripe (31 días): ${data.synced_transactions ?? 0} transacciones sincronizadas`);
        }
      } else if (mode === 'all6months') {
        const results = await syncInChunks('stripe', 0.5, setStripeResult, setStripeProgress);
        toast.success(`Stripe: ${results.synced_transactions} transacciones sincronizadas (6 meses)`);
      } else if (mode === 'allHistory') {
        // Sync last 3 years - this covers most business histories
        const results = await syncInChunks('stripe', 3, setStripeResult, setStripeProgress);
        toast.success(`Stripe: ${results.synced_transactions} transacciones sincronizadas (historial completo)`);
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
      setStripeSyncing(false);
      setStripeProgress(null);
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
    
    try {
      let hasMore = true;
      let cursor: string | null = null;
      let syncRunId: string | null = null; // Track sync run ID across pages
      let totalSynced = 0;
      let totalUpserted = 0;
      let page = 0;
      const stats = { draft: 0, open: 0, paid: 0, void: 0, uncollectible: 0 };

      while (hasMore) {
        page++;
        setInvoicesProgress({ current: page, total: 0 }); // Unknown total
        
        const data = await invokeWithAdminKey<{
          success: boolean;
          synced: number;
          upserted: number;
          hasMore: boolean;
          nextCursor: string | null;
          syncRunId: string | null;
          stats?: typeof stats;
          error?: string;
        }>('fetch-invoices', {
          mode,
          cursor,
          syncRunId, // Pass syncRunId to continue existing sync
        });

        if (!data.success) {
          throw new Error(data.error || 'Fetch invoices failed');
        }

        // Save syncRunId from first page
        if (data.syncRunId && !syncRunId) {
          syncRunId = data.syncRunId;
        }

        totalSynced += data.synced || 0;
        totalUpserted += data.upserted || 0;
        
        if (data.stats) {
          stats.draft += data.stats.draft || 0;
          stats.open += data.stats.open || 0;
          stats.paid += data.stats.paid || 0;
          stats.void += data.stats.void || 0;
          stats.uncollectible += data.stats.uncollectible || 0;
        }

        hasMore = data.hasMore && !!data.nextCursor;
        cursor = data.nextCursor;
        
        // Progress toast every 5 pages
        if (page % 5 === 0) {
          toast.info(`Facturas: Página ${page} - ${totalUpserted} sincronizadas...`, { id: 'invoices-progress' });
        }

        // Small delay between pages to avoid rate limits
        if (hasMore) {
          await new Promise(r => setTimeout(r, 200));
        }
        
        // Safety: limit to 100 pages (10,000 invoices per sync)
        if (page >= 100) {
          console.log('Reached page limit, stopping');
          break;
        }
      }

      setInvoicesResult({
        success: true,
        synced_transactions: totalSynced,
        total_inserted: totalUpserted,
        message: `${totalUpserted} facturas sincronizadas (${stats.paid} pagadas, ${stats.open} abiertas, ${stats.draft} borradores)`
      });
      
      toast.success(`Facturas: ${totalUpserted} sincronizadas (${stats.paid} pagadas, ${stats.open} abiertas)`, { id: 'invoices-progress' });
      
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['pending-invoices'] });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setInvoicesResult({ success: false, error: errorMessage });
      toast.error(`Error sincronizando facturas: ${errorMessage}`);
    } finally {
      setInvoicesSyncing(false);
      setInvoicesProgress(null);
    }
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
              <span>Stripe: Mes {stripeProgress.current}/{stripeProgress.total}</span>
            </div>
            <Progress 
              value={(stripeProgress.current / stripeProgress.total) * 100} 
              className="h-2"
            />
            <p className="text-xs text-gray-400">
              Procesando... {stripeProgress.current} de {stripeProgress.total} períodos
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
          💡 "Todo el Historial" sincroniza los últimos 3 años en bloques mensuales para evitar timeouts
        </p>
      </CardContent>
    </Card>
  );
}

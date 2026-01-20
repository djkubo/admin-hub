import { useState } from 'react';
import { RefreshCw, Loader2, CheckCircle, AlertCircle, Zap, History, Clock, MessageCircle, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';

interface SyncResult {
  success: boolean;
  synced_transactions?: number;
  synced_clients?: number;
  paid_count?: number;
  failed_count?: number;
  total_fetched?: number;
  total_inserted?: number;
  total_updated?: number;
  total_conflicts?: number;
  message?: string;
  error?: string;
}

export function APISyncPanel() {
  const queryClient = useQueryClient();
  const [stripeSyncing, setStripeSyncing] = useState(false);
  const [paypalSyncing, setPaypalSyncing] = useState(false);
  const [manychatSyncing, setManychatSyncing] = useState(false);
  const [ghlSyncing, setGhlSyncing] = useState(false);
  const [stripeResult, setStripeResult] = useState<SyncResult | null>(null);
  const [paypalResult, setPaypalResult] = useState<SyncResult | null>(null);
  const [manychatResult, setManychatResult] = useState<SyncResult | null>(null);
  const [ghlResult, setGhlResult] = useState<SyncResult | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; label: string } | null>(null);

  // Helper to sync in chunks to avoid timeouts
  const syncInChunks = async (
    service: 'stripe' | 'paypal',
    years: number,
    setResult: (r: SyncResult) => void
  ) => {
    const now = new Date();
    let allResults = { synced_transactions: 0, synced_clients: 0, paid_count: 0, failed_count: 0 };
    
    // Sync in 30-day chunks to avoid API limits and timeouts
    const totalChunks = years * 12; // Monthly chunks
    
    for (let i = 0; i < totalChunks; i++) {
      setSyncProgress({ 
        current: i + 1, 
        total: totalChunks, 
        label: `${service === 'stripe' ? 'Stripe' : 'PayPal'}: Mes ${i + 1}/${totalChunks}` 
      });
      
      const endDate = new Date(now.getTime() - (i * 31 * 24 * 60 * 60 * 1000));
      const startDate = new Date(endDate.getTime() - (31 * 24 * 60 * 60 * 1000));
      
      try {
        const { data, error } = await supabase.functions.invoke(
          service === 'stripe' ? 'fetch-stripe' : 'fetch-paypal',
          {
            body: { 
              fetchAll: true,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString()
            }
          }
        );

        if (error) {
          console.error(`Error en chunk ${i + 1}:`, error);
          continue; // Continue with next chunk instead of failing completely
        }
        
        if (data?.success) {
          allResults.synced_transactions += data.synced_transactions || 0;
          allResults.synced_clients += data.synced_clients || 0;
          allResults.paid_count += data.paid_count || 0;
          allResults.failed_count += data.failed_count || 0;
        }
      } catch (err) {
        console.error(`Chunk ${i + 1} failed:`, err);
        // Continue with next chunk
      }
    }
    
    setSyncProgress(null);
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
        
        const { data, error } = await supabase.functions.invoke('fetch-stripe', {
          body: { 
            fetchAll: true,
            startDate: yesterday.toISOString(),
            endDate: now.toISOString()
          }
        });

        if (error) throw error;
        setStripeResult(data);
        
        if (data.success) {
          toast.success(`Stripe (24h): ${data.synced_transactions} transacciones sincronizadas`);
        }
      } else if (mode === 'last31d') {
        const now = new Date();
        const startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        
        const { data, error } = await supabase.functions.invoke('fetch-stripe', {
          body: { 
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: now.toISOString()
          }
        });

        if (error) throw error;
        setStripeResult(data);
        
        if (data.success) {
          toast.success(`Stripe (31 días): ${data.synced_transactions} transacciones sincronizadas`);
        }
      } else if (mode === 'all6months') {
        const results = await syncInChunks('stripe', 0.5, setStripeResult);
        toast.success(`Stripe: ${results.synced_transactions} transacciones sincronizadas (6 meses)`);
      } else if (mode === 'allHistory') {
        // Sync last 3 years - this covers most business histories
        const results = await syncInChunks('stripe', 3, setStripeResult);
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
      setSyncProgress(null);
    }
  };

  const syncPayPal = async (mode: 'last24h' | 'last31d' | 'all6months' | 'allHistory') => {
    setPaypalSyncing(true);
    setPaypalResult(null);
    
    try {
      if (mode === 'last24h') {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const { data, error } = await supabase.functions.invoke('fetch-paypal', {
          body: { 
            fetchAll: true,
            startDate: yesterday.toISOString(),
            endDate: now.toISOString()
          }
        });

        if (error) throw error;
        setPaypalResult(data);
        
        if (data.success) {
          toast.success(`PayPal (24h): ${data.synced_transactions} transacciones sincronizadas`);
        }
      } else if (mode === 'last31d') {
        const now = new Date();
        const startDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
        
        const { data, error } = await supabase.functions.invoke('fetch-paypal', {
          body: { 
            fetchAll: true,
            startDate: startDate.toISOString(),
            endDate: now.toISOString()
          }
        });

        if (error) throw error;
        setPaypalResult(data);
        
        if (data.success) {
          toast.success(`PayPal (31 días): ${data.synced_transactions} transacciones sincronizadas`);
        }
      } else if (mode === 'all6months') {
        const results = await syncInChunks('paypal', 0.5, setPaypalResult);
        toast.success(`PayPal: ${results.synced_transactions} transacciones sincronizadas (6 meses)`);
      } else if (mode === 'allHistory') {
        // PayPal API only allows 3 years max - use 2.5 to be safe
        const results = await syncInChunks('paypal', 2.5, setPaypalResult);
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
      setSyncProgress(null);
    }
  };

  const syncManyChat = async () => {
    setManychatSyncing(true);
    setManychatResult(null);
    
    try {
      const { data, error } = await supabase.functions.invoke('sync-manychat', {
        body: { dry_run: false }
      });

      if (error) throw error;
      
      setManychatResult({
        success: true,
        total_fetched: data.stats?.total_fetched || 0,
        total_inserted: data.stats?.total_inserted || 0,
        total_updated: data.stats?.total_updated || 0,
        total_conflicts: data.stats?.total_conflicts || 0
      });
      
      toast.success(`ManyChat: ${data.stats?.total_fetched || 0} contactos sincronizados (${data.stats?.total_inserted || 0} nuevos, ${data.stats?.total_updated || 0} actualizados)`);
      
      // Refresh clients data
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

  const syncGHL = async () => {
    setGhlSyncing(true);
    setGhlResult(null);
    
    try {
      const { data, error } = await supabase.functions.invoke('sync-ghl', {
        body: { dry_run: false }
      });

      if (error) throw error;
      
      setGhlResult({
        success: true,
        total_fetched: data.stats?.total_fetched || 0,
        total_inserted: data.stats?.total_inserted || 0,
        total_updated: data.stats?.total_updated || 0,
        total_conflicts: data.stats?.total_conflicts || 0
      });
      
      toast.success(`GoHighLevel: ${data.stats?.total_fetched || 0} contactos sincronizados (${data.stats?.total_inserted || 0} nuevos, ${data.stats?.total_updated || 0} actualizados)`);
      
      // Refresh clients data
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

  const syncAllHistory = async () => {
    // Run sequentially to avoid rate limits
    await syncStripe('allHistory');
    await syncPayPal('allHistory');
  };

  const isSyncing = stripeSyncing || paypalSyncing || manychatSyncing || ghlSyncing;

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
        {/* Progress indicator */}
        {syncProgress && (
          <div className="p-3 bg-primary/10 rounded-lg border border-primary/30 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{syncProgress.label}</span>
            </div>
            <Progress 
              value={(syncProgress.current / syncProgress.total) * 100} 
              className="h-2"
            />
            <p className="text-xs text-gray-400">
              Procesando... {syncProgress.current} de {syncProgress.total} períodos
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
              disabled={isSyncing}
              className="gap-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Últimas 24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('last31d')}
              disabled={isSyncing}
              className="gap-2"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              31 días
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('all6months')}
              disabled={isSyncing}
              className="gap-2"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              6 Meses
            </Button>
            <Button
              size="sm"
              onClick={() => syncStripe('allHistory')}
              disabled={isSyncing}
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
              disabled={isSyncing}
              className="gap-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              Últimas 24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('last31d')}
              disabled={isSyncing}
              className="gap-2"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              31 días
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('all6months')}
              disabled={isSyncing}
              className="gap-2"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              6 Meses
            </Button>
            <Button
              size="sm"
              onClick={() => syncPayPal('allHistory')}
              disabled={isSyncing}
              className="gap-2 bg-yellow-600 hover:bg-yellow-700"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Todo Historial
            </Button>
          </div>
        </div>

        {/* ManyChat Sync */}
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
            disabled={isSyncing}
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
                    ? `${ghlResult.total_fetched} contactos (${ghlResult.total_inserted} nuevos, ${ghlResult.total_updated} actualizados)`
                    : 'Sincroniza todos tus contactos de GHL'
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
            disabled={isSyncing}
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
          disabled={isSyncing}
          className="w-full bg-gradient-to-r from-purple-600 to-yellow-600 hover:from-purple-700 hover:to-yellow-700"
        >
          {isSyncing ? (
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

import { useState } from 'react';
import { RefreshCw, Loader2, CheckCircle, AlertCircle, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface SyncResult {
  success: boolean;
  synced_transactions?: number;
  synced_clients?: number;
  paid_count?: number;
  failed_count?: number;
  total_fetched?: number;
  message?: string;
  error?: string;
}

export function APISyncPanel() {
  const queryClient = useQueryClient();
  const [stripeSyncing, setStripeSyncing] = useState(false);
  const [paypalSyncing, setPaypalSyncing] = useState(false);
  const [stripeResult, setStripeResult] = useState<SyncResult | null>(null);
  const [paypalResult, setPaypalResult] = useState<SyncResult | null>(null);

  const syncStripe = async (mode: 'last24h' | 'last31d' | 'all6months' | 'latest100') => {
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
        const now = new Date();
        let allResults = { synced_transactions: 0, synced_clients: 0, paid_count: 0, failed_count: 0 };
        
        for (let i = 0; i < 6; i++) {
          const endDate = new Date(now.getTime() - (i * 31 * 24 * 60 * 60 * 1000));
          const startDate = new Date(endDate.getTime() - (31 * 24 * 60 * 60 * 1000));
          
          const { data, error } = await supabase.functions.invoke('fetch-stripe', {
            body: { 
              fetchAll: true,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString()
            }
          });

          if (error) throw error;
          
          if (data.success) {
            allResults.synced_transactions += data.synced_transactions || 0;
            allResults.synced_clients += data.synced_clients || 0;
            allResults.paid_count += data.paid_count || 0;
            allResults.failed_count += data.failed_count || 0;
          }
        }
        
        setStripeResult({ 
          success: true, 
          ...allResults,
          message: `Sincronizados últimos 6 meses` 
        });
        toast.success(`Stripe: ${allResults.synced_transactions} transacciones sincronizadas (6 meses)`);
      } else {
        // Default: latest 100
        const { data, error } = await supabase.functions.invoke('fetch-stripe', {
          body: { fetchAll: false }
        });

        if (error) throw error;
        setStripeResult(data);
        
        if (data.success) {
          toast.success(`Stripe: ${data.synced_transactions} transacciones sincronizadas`);
        }
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
    }
  };

  const syncPayPal = async (mode: 'last24h' | 'last31d' | 'all6months') => {
    setPaypalSyncing(true);
    setPaypalResult(null);
    
    try {
      if (mode === 'last24h') {
        // Sync last 24 hours only
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const { data, error } = await supabase.functions.invoke('fetch-paypal', {
          body: { 
            fetchAll: true, // Fetch all pages within the date range
            startDate: yesterday.toISOString(),
            endDate: now.toISOString()
          }
        });

        if (error) throw error;
        
        setPaypalResult(data);
        
        if (data.success) {
          toast.success(`PayPal (24h): ${data.synced_transactions} transacciones sincronizadas`);
        }
      } else if (mode === 'all6months') {
        // Fetch last 6 months in 31-day chunks
        const now = new Date();
        let allResults = { synced_transactions: 0, synced_clients: 0, paid_count: 0, failed_count: 0 };
        
        for (let i = 0; i < 6; i++) {
          const endDate = new Date(now.getTime() - (i * 31 * 24 * 60 * 60 * 1000));
          const startDate = new Date(endDate.getTime() - (31 * 24 * 60 * 60 * 1000));
          
          const { data, error } = await supabase.functions.invoke('fetch-paypal', {
            body: { 
              fetchAll: true,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString()
            }
          });

          if (error) throw error;
          
          if (data.success) {
            allResults.synced_transactions += data.synced_transactions || 0;
            allResults.synced_clients += data.synced_clients || 0;
            allResults.paid_count += data.paid_count || 0;
            allResults.failed_count += data.failed_count || 0;
          }
        }
        
        setPaypalResult({ 
          success: true, 
          ...allResults,
          message: `Sincronizados últimos 6 meses` 
        });
        toast.success(`PayPal: ${allResults.synced_transactions} transacciones sincronizadas (6 meses)`);
      } else {
        // Default: last 31 days
        const { data, error } = await supabase.functions.invoke('fetch-paypal', {
          body: { fetchAll: true }
        });

        if (error) throw error;
        
        setPaypalResult(data);
        
        if (data.success) {
          toast.success(`PayPal: ${data.synced_transactions} transacciones sincronizadas`);
        }
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
    }
  };

  const syncAll = async () => {
    await Promise.all([
      syncStripe('all6months'),
      syncPayPal('all6months')
    ]);
  };

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
          
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('last24h')}
              disabled={stripeSyncing}
              className="gap-2 flex-1 min-w-[120px] border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Últimas 24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncStripe('last31d')}
              disabled={stripeSyncing}
              className="gap-2 flex-1 min-w-[120px]"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Últimos 31 días
            </Button>
            <Button
              size="sm"
              onClick={() => syncStripe('all6months')}
              disabled={stripeSyncing}
              className="gap-2 flex-1 min-w-[120px] bg-purple-600 hover:bg-purple-700"
            >
              {stripeSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              6 Meses
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
          
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('last24h')}
              disabled={paypalSyncing}
              className="gap-2 flex-1 min-w-[120px] border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Últimas 24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncPayPal('last31d')}
              disabled={paypalSyncing}
              className="gap-2 flex-1 min-w-[120px]"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Últimos 31 días
            </Button>
            <Button
              size="sm"
              onClick={() => syncPayPal('all6months')}
              disabled={paypalSyncing}
              className="gap-2 flex-1 min-w-[120px] bg-yellow-600 hover:bg-yellow-700"
            >
              {paypalSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              6 Meses
            </Button>
          </div>
        </div>

        {/* Sync All Button */}
        <Button 
          onClick={syncAll}
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
              <Zap className="mr-2 h-4 w-4" />
              Sincronizar Todo (Stripe + PayPal)
            </>
          )}
        </Button>

        <p className="text-xs text-gray-500 text-center">
          💡 Usa "Todo el Historial" para importar todas las transacciones desde que creaste tu cuenta
        </p>
      </CardContent>
    </Card>
  );
}

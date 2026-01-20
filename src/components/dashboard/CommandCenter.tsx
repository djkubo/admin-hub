import { useState } from 'react';
import { useDailyKPIs, TimeFilter } from '@/hooks/useDailyKPIs';
import { 
  DollarSign, 
  UserPlus, 
  RefreshCw, 
  ArrowRightCircle, 
  AlertTriangle,
  XCircle,
  Loader2,
  Clock,
  Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface CommandCenterProps {
  lastSync?: Date | null;
}

export function CommandCenter({ lastSync }: CommandCenterProps) {
  const [filter, setFilter] = useState<TimeFilter>('today');
  const { kpis, isLoading, refetch } = useDailyKPIs(filter);
  const [isSyncing, setIsSyncing] = useState(false);
  const queryClient = useQueryClient();

  const filterLabels: Record<TimeFilter, string> = {
    today: 'Hoy',
    '7d': '7d',
    month: 'Mes',
  };

  const handleSyncAll = async () => {
    setIsSyncing(true);
    try {
      // Sync Stripe last 24h
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
      const [stripeResult, paypalResult, subsResult, invoicesResult] = await Promise.all([
        supabase.functions.invoke('fetch-stripe', {
          body: { fetchAll: true, startDate: yesterday.toISOString(), endDate: now.toISOString() }
        }),
        supabase.functions.invoke('fetch-paypal', {
          body: { fetchAll: true, startDate: yesterday.toISOString(), endDate: now.toISOString() }
        }),
        supabase.functions.invoke('fetch-subscriptions', { body: {} }),
        supabase.functions.invoke('fetch-invoices', { body: {} }),
      ]);

      const totalTx = (stripeResult.data?.synced_transactions || 0) + (paypalResult.data?.synced_transactions || 0);
      
      toast.success(`Sync completo: ${totalTx} transacciones, ${subsResult.data?.synced || 0} suscripciones, ${invoicesResult.data?.synced || 0} facturas`);
      
      // Invalidate all queries
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['daily-kpis'] });
      
      refetch();
    } catch (error) {
      console.error('Sync error:', error);
      toast.error('Error en sincronización');
    } finally {
      setIsSyncing(false);
    }
  };

  const totalRevenue = kpis.newRevenue + kpis.conversionRevenue + kpis.renewalRevenue;
  const atRiskAmount = kpis.failuresToday * 50; // Estimate avg failed payment

  const cards = [
    {
      title: 'Ventas',
      value: `$${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: DollarSign,
      color: 'emerald',
      subtitle: filterLabels[filter],
    },
    {
      title: 'Nuevos',
      value: kpis.newPayersToday,
      icon: UserPlus,
      color: 'cyan',
      subtitle: `$${kpis.newRevenue.toFixed(0)}`,
    },
    {
      title: 'Renovaciones',
      value: kpis.renewalsToday,
      icon: RefreshCw,
      color: 'green',
      subtitle: `$${kpis.renewalRevenue.toFixed(0)}`,
    },
    {
      title: 'Trial→Paid',
      value: kpis.trialConversionsToday,
      icon: ArrowRightCircle,
      color: 'purple',
      subtitle: `$${kpis.conversionRevenue.toFixed(0)}`,
    },
    {
      title: 'Fallos',
      value: kpis.failuresToday,
      icon: AlertTriangle,
      color: 'amber',
      subtitle: kpis.failuresToday > 0 ? `~$${atRiskAmount} riesgo` : 'OK',
      isNegative: true,
    },
    {
      title: 'Cancelaciones',
      value: kpis.cancellationsToday,
      icon: XCircle,
      color: 'red',
      subtitle: 'suscripciones',
      isNegative: true,
    },
  ];

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; icon: string; border: string }> = {
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', icon: 'text-emerald-500', border: 'border-emerald-500/30' },
      cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', icon: 'text-cyan-500', border: 'border-cyan-500/30' },
      green: { bg: 'bg-green-500/10', text: 'text-green-400', icon: 'text-green-500', border: 'border-green-500/30' },
      purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', icon: 'text-purple-500', border: 'border-purple-500/30' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: 'text-amber-500', border: 'border-amber-500/30' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400', icon: 'text-red-500', border: 'border-red-500/30' },
    };
    return colors[color] || colors.emerald;
  };

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Zap className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Command Center</h2>
            <p className="text-xs text-muted-foreground">
              {lastSync ? (
                <>Última sync: {formatDistanceToNow(lastSync, { addSuffix: true, locale: es })}</>
              ) : (
                'Sin sincronizar'
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Time filter */}
          <div className="flex rounded-lg border border-border/50 overflow-hidden">
            {(['today', '7d', 'month'] as TimeFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:text-foreground'
                }`}
              >
                {filterLabels[f]}
              </button>
            ))}
          </div>

          {/* Sync All button */}
          <Button
            onClick={handleSyncAll}
            disabled={isSyncing}
            size="sm"
            className="gap-2 bg-gradient-to-r from-purple-600 to-yellow-600 hover:from-purple-700 hover:to-yellow-700"
          >
            {isSyncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Sync All
          </Button>
        </div>
      </div>

      {/* 6 KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map((card, index) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;

          if (isLoading) {
            return (
              <div key={index} className="rounded-xl border border-border/50 bg-card p-4 animate-pulse">
                <div className="h-8 w-8 rounded-lg bg-muted mb-2" />
                <div className="h-4 w-16 bg-muted rounded mb-1" />
                <div className="h-6 w-12 bg-muted rounded" />
              </div>
            );
          }

          return (
            <div
              key={index}
              className={`rounded-xl border ${colors.border} bg-card p-4 transition-all hover:shadow-lg cursor-pointer group`}
            >
              <div className={`inline-flex p-2 rounded-lg ${colors.bg} mb-2 group-hover:scale-110 transition-transform`}>
                <Icon className={`h-4 w-4 ${colors.icon}`} />
              </div>
              <p className="text-xs text-muted-foreground">{card.title}</p>
              <p className={`text-2xl font-bold ${card.isNegative && typeof card.value === 'number' && card.value > 0 ? 'text-red-400' : 'text-foreground'}`}>
                {card.value}
              </p>
              <p className={`text-[10px] ${colors.text} mt-0.5`}>{card.subtitle}</p>
            </div>
          );
        })}
      </div>

      {/* Failure reasons inline */}
      {kpis.failureReasons.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-amber-400 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Razones:
          </span>
          {kpis.failureReasons.slice(0, 3).map((reason, i) => (
            <Badge
              key={i}
              variant="outline"
              className="text-xs border-amber-500/30 text-amber-400 bg-amber-500/10"
            >
              {reason.reason}: {reason.count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

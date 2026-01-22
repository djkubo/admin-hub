import { useMemo } from 'react';
import { CreditCard, Clock, CheckCircle, XCircle, AlertTriangle, TrendingUp, RefreshCw, Loader2, CloudCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSubscriptions, Subscription } from '@/hooks/useSubscriptions';
import { formatDistanceToNow, addDays, isAfter, isBefore } from 'date-fns';
import { es } from 'date-fns/locale';

export function SubscriptionsPage() {
  const { subscriptions, isLoading, syncSubscriptions, revenueByPlan, totalActiveRevenue, totalActiveCount, isSyncing, syncProgress } = useSubscriptions();

  const now = new Date();
  const in3Days = addDays(now, 3);
  const thirtyDaysAgo = addDays(now, -30);

  const funnel = useMemo(() => {
    const trials = subscriptions.filter((s: Subscription) => s.status === 'trialing');
    const trialsExpiringSoon = trials.filter((s: Subscription) => 
      s.trial_end && isBefore(new Date(s.trial_end), in3Days)
    );
    const active = subscriptions.filter((s: Subscription) => s.status === 'active');
    const canceled = subscriptions.filter((s: Subscription) => 
      s.canceled_at && isAfter(new Date(s.canceled_at), thirtyDaysAgo)
    );
    const pastDue = subscriptions.filter((s: Subscription) => s.status === 'past_due');

    return {
      trials: trials.length,
      trialsExpiringSoon: trialsExpiringSoon.length,
      active: active.length,
      canceled: canceled.length,
      pastDue: pastDue.length,
      trialsExpiringSoonList: trialsExpiringSoon.sort((a, b) => 
        new Date(a.trial_end!).getTime() - new Date(b.trial_end!).getTime()
      ),
      canceledList: canceled.sort((a, b) => 
        new Date(b.canceled_at!).getTime() - new Date(a.canceled_at!).getTime()
      ),
    };
  }, [subscriptions]);

  const funnelCards = [
    { label: 'Trials', value: funnel.trials, icon: Clock, color: 'purple' },
    { label: 'Por Vencer', value: funnel.trialsExpiringSoon, icon: AlertTriangle, color: 'amber' },
    { label: 'Activas', value: funnel.active, icon: CheckCircle, color: 'emerald' },
    { label: 'Past Due', value: funnel.pastDue, icon: AlertTriangle, color: 'red' },
    { label: 'Churn', value: funnel.canceled, icon: XCircle, color: 'red' },
  ];

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; border: string }> = {
      purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
    };
    return colors[color] || colors.purple;
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2">
            <CreditCard className="h-5 w-5 md:h-8 md:w-8 text-purple-500" />
            Suscripciones
          </h1>
          <p className="text-[10px] md:text-sm text-muted-foreground mt-0.5">
            Funnel: Trials → Conversiones → Churn
          </p>
        </div>
        <div className="flex items-center gap-3 justify-between sm:justify-end">
          <div className="text-left sm:text-right">
            <p className="text-lg md:text-2xl font-bold text-foreground">
              ${(totalActiveRevenue / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}
            </p>
            <p className="text-[10px] md:text-xs text-muted-foreground">MRR ({totalActiveCount})</p>
          </div>
          <Button
            onClick={() => syncSubscriptions.mutate()}
            disabled={isSyncing}
            variant="outline"
            size="sm"
            className="touch-feedback h-8"
          >
            {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="hidden sm:inline ml-2">Sync</span>
          </Button>
        </div>
      </div>

      {/* Sync Progress Banner */}
      {isSyncing && syncProgress && (
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 flex items-center gap-3">
          <CloudCog className="h-5 w-5 text-purple-400 animate-pulse shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-foreground text-sm">Sincronizando...</p>
            <p className="text-[10px] text-muted-foreground truncate">
              {syncProgress.fetched > 0 && `${syncProgress.fetched} obtenidas`}
              {syncProgress.inserted > 0 && ` • ${syncProgress.inserted} guardadas`}
            </p>
          </div>
          <Badge variant="outline" className="border-purple-500/30 text-purple-400 text-[10px] shrink-0">
            {syncProgress.status === 'running' ? 'En progreso' : syncProgress.status}
          </Badge>
        </div>
      )}

      {/* Funnel Cards - 3 cols mobile, 5 cols desktop */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 md:gap-4">
        {funnelCards.map((card, i) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;
          return (
            <div key={i} className={`rounded-xl border ${colors.border} bg-card p-2.5 md:p-4 touch-feedback`}>
              <div className={`inline-flex p-1 md:p-2 rounded-lg ${colors.bg} mb-1`}>
                <Icon className={`h-3 w-3 md:h-4 md:w-4 ${colors.text}`} />
              </div>
              <p className="text-[9px] md:text-xs text-muted-foreground truncate">{card.label}</p>
              <p className={`text-base md:text-2xl font-bold ${colors.text}`}>{card.value}</p>
            </div>
          );
        })}
      </div>

      {/* Two Lists - Stack on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Trials Expiring Soon */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="p-3 border-b border-border/50 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <h3 className="font-semibold text-foreground text-sm">Trials por Vencer</h3>
          </div>
          {funnel.trialsExpiringSoonList.length === 0 ? (
            <div className="p-6 text-center">
              <CheckCircle className="h-6 w-6 mx-auto mb-2 text-emerald-500/50" />
              <p className="text-muted-foreground text-xs">Sin trials por vencer</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30 max-h-[300px] overflow-y-auto">
              {funnel.trialsExpiringSoonList.slice(0, 10).map((sub: Subscription) => (
                <div key={sub.id} className="p-3 hover:bg-muted/20 touch-feedback">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs md:text-sm font-medium truncate">{sub.customer_email || 'Sin email'}</p>
                      <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30 text-[10px] mt-1">
                        {sub.plan_name}
                      </Badge>
                    </div>
                    <span className="text-amber-400 text-[10px] md:text-xs shrink-0">
                      {formatDistanceToNow(new Date(sub.trial_end!), { addSuffix: true, locale: es })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Cancellations */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="p-3 border-b border-border/50 flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500" />
            <h3 className="font-semibold text-foreground text-sm">Cancelaciones (30d)</h3>
          </div>
          {funnel.canceledList.length === 0 ? (
            <div className="p-6 text-center">
              <CheckCircle className="h-6 w-6 mx-auto mb-2 text-emerald-500/50" />
              <p className="text-muted-foreground text-xs">Sin cancelaciones</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30 max-h-[300px] overflow-y-auto">
              {funnel.canceledList.slice(0, 10).map((sub: Subscription) => (
                <div key={sub.id} className="p-3 hover:bg-muted/20 touch-feedback">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs md:text-sm font-medium truncate">{sub.customer_email || 'Sin email'}</p>
                      <Badge variant="outline" className="bg-gray-500/10 text-gray-400 border-gray-500/30 text-[10px] mt-1">
                        {sub.plan_name}
                      </Badge>
                    </div>
                    <span className="text-[10px] text-red-400 shrink-0 max-w-[80px] truncate">
                      {sub.cancel_reason || 'Sin razón'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Revenue by Plan */}
      {revenueByPlan.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-card p-3 md:p-6">
          <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            Ingresos por Plan
          </h3>
          <div className="space-y-2">
            {revenueByPlan.slice(0, 5).map((plan, i) => (
              <div key={i} className="flex items-center gap-2 md:gap-4">
                <div className="w-16 md:w-32 text-[10px] md:text-sm font-medium truncate">{plan.name}</div>
                <div className="flex-1">
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-purple-500 to-emerald-500"
                      style={{ width: `${plan.percentage}%` }}
                    />
                  </div>
                </div>
                <div className="w-12 md:w-20 text-right text-[10px] md:text-sm text-muted-foreground">
                  ${(plan.revenue / 100).toFixed(0)}
                </div>
                <div className="w-10 md:w-16 text-right text-[9px] md:text-xs text-muted-foreground">
                  {plan.percentage.toFixed(0)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

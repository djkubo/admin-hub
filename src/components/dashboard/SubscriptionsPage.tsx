import { useMemo } from 'react';
import { CreditCard, Clock, CheckCircle, XCircle, AlertTriangle, TrendingUp, TrendingDown, RefreshCw, Loader2, CloudCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSubscriptions, Subscription } from '@/hooks/useSubscriptions';
import { formatDistanceToNow, addDays, format, isAfter, isBefore } from 'date-fns';
import { es } from 'date-fns/locale';

export function SubscriptionsPage() {
  const { subscriptions, isLoading, syncSubscriptions, revenueByPlan, totalActiveRevenue, totalActiveCount, isSyncing, syncProgress } = useSubscriptions();

  const now = new Date();
  const in3Days = addDays(now, 3);
  const thirtyDaysAgo = addDays(now, -30);

  // Funnel metrics
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
    { label: 'Trials Activos', value: funnel.trials, icon: Clock, color: 'purple' },
    { label: 'Por Vencer (3d)', value: funnel.trialsExpiringSoon, icon: AlertTriangle, color: 'amber' },
    { label: 'Activas', value: funnel.active, icon: CheckCircle, color: 'emerald' },
    { label: 'Past Due', value: funnel.pastDue, icon: AlertTriangle, color: 'red' },
    { label: 'Churn 30d', value: funnel.canceled, icon: XCircle, color: 'red' },
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <CreditCard className="h-8 w-8 text-purple-500" />
            Suscripciones
          </h1>
          <p className="text-muted-foreground mt-1">
            Funnel de suscripciones: Trials, Conversiones y Churn
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-2xl font-bold text-foreground">${(totalActiveRevenue / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-sm text-muted-foreground">MRR ({totalActiveCount} activas)</p>
          </div>
          <Button
            onClick={() => syncSubscriptions.mutate()}
            disabled={isSyncing}
            variant="outline"
          >
            {isSyncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sincronizar
          </Button>
        </div>
      </div>

      {/* Sync Progress Banner */}
      {isSyncing && syncProgress && (
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-4 flex items-center gap-4">
          <CloudCog className="h-6 w-6 text-purple-400 animate-pulse" />
          <div className="flex-1">
            <p className="font-medium text-foreground">Sincronizando en segundo plano...</p>
            <p className="text-sm text-muted-foreground">
              {syncProgress.fetched > 0 && `${syncProgress.fetched} obtenidas`}
              {syncProgress.inserted > 0 && ` • ${syncProgress.inserted} guardadas`}
              {' • Puedes recargar la página sin perder el progreso'}
            </p>
          </div>
          <Badge variant="outline" className="border-purple-500/30 text-purple-400">
            {syncProgress.status === 'running' ? 'En progreso' : syncProgress.status}
          </Badge>
        </div>
      )}

      {/* Funnel Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {funnelCards.map((card, i) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;
          return (
            <div key={i} className={`rounded-xl border ${colors.border} bg-card p-4`}>
              <div className={`inline-flex p-2 rounded-lg ${colors.bg} mb-2`}>
                <Icon className={`h-4 w-4 ${colors.text}`} />
              </div>
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className={`text-2xl font-bold ${colors.text}`}>{card.value}</p>
            </div>
          );
        })}
      </div>

      {/* Two Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trials Expiring Soon */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="p-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h3 className="font-semibold text-foreground">Trials por Vencer (3 días)</h3>
            </div>
          </div>
          {funnel.trialsExpiringSoonList.length === 0 ? (
            <div className="p-8 text-center">
              <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
              <p className="text-muted-foreground text-sm">Sin trials por vencer</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Email</TableHead>
                  <TableHead className="text-muted-foreground">Plan</TableHead>
                  <TableHead className="text-muted-foreground">Vence en</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {funnel.trialsExpiringSoonList.slice(0, 10).map((sub: Subscription) => (
                  <TableRow key={sub.id} className="border-border/50">
                    <TableCell className="font-medium truncate max-w-[150px]">
                      {sub.customer_email || 'Sin email'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30">
                        {sub.plan_name}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-amber-400 text-sm">
                        {formatDistanceToNow(new Date(sub.trial_end!), { addSuffix: true, locale: es })}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Recent Cancellations */}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="p-4 border-b border-border/50">
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <h3 className="font-semibold text-foreground">Cancelaciones Recientes (30d)</h3>
            </div>
          </div>
          {funnel.canceledList.length === 0 ? (
            <div className="p-8 text-center">
              <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
              <p className="text-muted-foreground text-sm">Sin cancelaciones recientes</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Email</TableHead>
                  <TableHead className="text-muted-foreground">Plan</TableHead>
                  <TableHead className="text-muted-foreground">Razón</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {funnel.canceledList.slice(0, 10).map((sub: Subscription) => (
                  <TableRow key={sub.id} className="border-border/50">
                    <TableCell className="font-medium truncate max-w-[150px]">
                      {sub.customer_email || 'Sin email'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-gray-500/10 text-gray-400 border-gray-500/30">
                        {sub.plan_name}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-red-400">
                        {sub.cancel_reason || 'Sin razón'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Revenue by Plan */}
      {revenueByPlan.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-card p-6">
          <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-emerald-500" />
            Ingresos por Plan (Pareto)
          </h3>
          <div className="space-y-3">
            {revenueByPlan.slice(0, 5).map((plan, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="w-32 text-sm font-medium truncate">{plan.name}</div>
                <div className="flex-1">
                  <div className="h-3 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-purple-500 to-emerald-500"
                      style={{ width: `${plan.percentage}%` }}
                    />
                  </div>
                </div>
                <div className="w-20 text-right text-sm text-muted-foreground">
                  ${(plan.revenue / 100).toFixed(0)}
                </div>
                <div className="w-16 text-right text-xs text-muted-foreground">
                  {plan.percentage.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

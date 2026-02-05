import { useMemo, useState } from 'react';
import { CreditCard, Clock, CheckCircle, XCircle, AlertTriangle, TrendingUp, RefreshCw, Loader2, CloudCog, DollarSign, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useSubscriptions, Subscription } from '@/hooks/useSubscriptions';
import { formatDistanceToNow, addDays, isAfter, isBefore } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

// PayPal icon
const PayPalIcon = () => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
    <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.72a.771.771 0 0 1 .762-.655h6.99c2.321 0 4.072.589 5.204 1.75.537.55.913 1.2 1.122 1.938.216.764.256 1.649.119 2.634-.288 2.018-1.227 3.523-2.795 4.476-1.474.894-3.348 1.348-5.572 1.348H8.97a.762.762 0 0 0-.752.64l-.774 4.875-.367 2.321a.405.405 0 0 1-.001.29z"/>
  </svg>
);

// Stripe icon
const StripeIcon = () => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
    <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z"/>
  </svg>
);

export function SubscriptionsPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [statusFilter, setStatusFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState<'all' | 'stripe' | 'paypal'>('all');
  const [searchInput, setSearchInput] = useState('');
  
  const searchQuery = useDebouncedValue(searchInput, 400);

  const { 
    subscriptions, 
    isLoading,
    totalCount,
    totalPages,
    syncSubscriptions,
    syncPayPalSubscriptions,
    revenueByPlan, 
    totalActiveRevenue, 
    totalActiveCount, 
    statusBreakdown,
    revenueAtRisk,
    atRiskCount,
    stripeCount,
    paypalCount,
    isSyncing, 
    syncProgress 
  } = useSubscriptions({
    page,
    pageSize,
    statusFilter,
    searchQuery,
    providerFilter,
  });

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
    // FIXED: Include both past_due AND unpaid in at-risk list
    const atRisk = subscriptions.filter((s: Subscription) => 
      s.status === 'past_due' || s.status === 'unpaid'
    );

    return {
      trials: trials.length,
      trialsExpiringSoon: trialsExpiringSoon.length,
      active: active.length,
      canceled: canceled.length,
      atRisk: atRisk.length,
      trialsExpiringSoonList: trialsExpiringSoon.sort((a, b) => 
        new Date(a.trial_end!).getTime() - new Date(b.trial_end!).getTime()
      ),
      canceledList: canceled.sort((a, b) => 
        new Date(b.canceled_at!).getTime() - new Date(a.canceled_at!).getTime()
      ),
      atRiskList: atRisk.sort((a, b) => b.amount - a.amount),
    };
  }, [subscriptions]);

  // VRP Style: Semantic colors only (emerald=active, amber=warning, red=risk, zinc=neutral)
  const funnelCards = [
    { label: 'Trials', value: funnel.trials, icon: Clock, color: 'amber' },           // Pendiente → Amber
    { label: 'Por Vencer', value: funnel.trialsExpiringSoon, icon: AlertTriangle, color: 'amber' },
    { label: 'Activas', value: funnel.active, icon: CheckCircle, color: 'emerald' },
    { label: 'En Riesgo', value: funnel.atRisk, icon: AlertTriangle, color: 'red' },
    { label: 'Churn', value: funnel.canceled, icon: XCircle, color: 'neutral' },      // Neutral → Zinc
  ];

  // VRP Style: Neutral zinc + semantic colors only (emerald=ok, red=risk, amber=warning)
  const getColorClasses = (color: string) => {
    const semanticColors: Record<string, { bg: string; text: string; border: string }> = {
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
    };
    // Return semantic color if exists, otherwise neutral zinc
    return semanticColors[color] || { bg: 'bg-zinc-800', text: 'text-foreground', border: 'border-zinc-700' };
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2">
            <CreditCard className="h-5 w-5 md:h-8 md:w-8 text-primary" />
            Suscripciones
          </h1>
          <p className="text-[10px] md:text-sm text-muted-foreground mt-0.5">
            Funnel: Trials → Conversiones → Churn
          </p>
        </div>
        <div className="flex items-center gap-3 justify-between sm:justify-end">
          {/* MRR Display */}
          <div className="text-left sm:text-right">
            <p className="text-lg md:text-2xl font-bold text-foreground">
              ${(totalActiveRevenue / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}
            </p>
            <p className="text-[10px] md:text-xs text-muted-foreground">MRR ({totalActiveCount} activas)</p>
          </div>
          {/* Revenue at Risk - NEW */}
          {revenueAtRisk > 0 && (
            <div className="text-left sm:text-right border-l border-red-500/30 pl-3">
              <p className="text-lg md:text-2xl font-bold text-red-400">
                ${(revenueAtRisk / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}
              </p>
              <p className="text-[10px] md:text-xs text-red-400/70">En Riesgo ({atRiskCount})</p>
            </div>
          )}
          <div className="flex items-center gap-2">
            {/* Provider breakdown */}
            <div className="hidden sm:flex items-center gap-2 text-xs mr-2">
              <div className="flex items-center gap-1 text-muted-foreground">
                <StripeIcon />
                <span>{stripeCount}</span>
              </div>
              <div className="flex items-center gap-1 text-[#0070ba]">
                <PayPalIcon />
                <span>{paypalCount}</span>
              </div>
            </div>
            <Button
              onClick={() => syncSubscriptions.mutate()}
              disabled={isSyncing}
              variant="outline"
              size="sm"
              className="touch-feedback h-8"
              title="Sync Stripe"
            >
              {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <StripeIcon />}
            </Button>
            <Button
              onClick={() => syncPayPalSubscriptions.mutate()}
              disabled={isSyncing}
              variant="outline"
              size="sm"
              className="touch-feedback h-8"
              title="Sync PayPal"
            >
              <PayPalIcon />
            </Button>
          </div>
        </div>
      </div>

      {/* Sync Progress Banner - VRP Neutral */}
      {isSyncing && syncProgress && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-3 flex items-center gap-3">
          <CloudCog className="h-5 w-5 text-primary animate-pulse shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-foreground text-sm">Sincronizando...</p>
            <p className="text-[10px] text-muted-foreground truncate">
              {syncProgress.fetched > 0 && `${syncProgress.fetched} obtenidas`}
              {syncProgress.inserted > 0 && ` • ${syncProgress.inserted} guardadas`}
            </p>
          </div>
          <Badge variant="outline" className="border-zinc-700 text-white text-[10px] shrink-0">
            {syncProgress.status === 'running' ? 'En progreso' : syncProgress.status}
          </Badge>
        </div>
      )}

      {/* Revenue at Risk Alert - NEW */}
      {revenueAtRisk > 0 && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 md:p-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-red-500/20">
              <DollarSign className="h-5 w-5 text-red-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-red-400 text-sm md:text-base">
                Revenue at Risk: ${(revenueAtRisk / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}/mes
              </h3>
              <p className="text-[10px] md:text-xs text-red-400/70 mt-0.5">
                {statusBreakdown.past_due} pagos vencidos + {statusBreakdown.unpaid} impagos = {atRiskCount} clientes requieren atención
              </p>
            </div>
          </div>
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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar email o plan..."
            value={searchInput}
            onChange={(e) => { setSearchInput(e.target.value); setPage(1); }}
            className="pl-8 h-8 bg-muted/50 border-border/50 text-sm"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos ({statusBreakdown.active + statusBreakdown.trialing + statusBreakdown.past_due + statusBreakdown.unpaid + statusBreakdown.canceled})</SelectItem>
            <SelectItem value="active">Activos ({statusBreakdown.active})</SelectItem>
            <SelectItem value="trialing">Trials ({statusBreakdown.trialing})</SelectItem>
            <SelectItem value="at_risk">En Riesgo ({statusBreakdown.past_due + statusBreakdown.unpaid})</SelectItem>
            <SelectItem value="canceled">Cancelados ({statusBreakdown.canceled})</SelectItem>
          </SelectContent>
        </Select>
        <Select value={providerFilter} onValueChange={(v: any) => { setProviderFilter(v); setPage(1); }}>
          <SelectTrigger className="w-28 h-8 text-xs">
            <SelectValue placeholder="Proveedor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="stripe">Stripe</SelectItem>
            <SelectItem value="paypal">PayPal</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Three Lists - Stack on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* At Risk List - NEW (most important, shown first) */}
        <div className="rounded-xl border border-red-500/30 bg-card overflow-hidden">
          <div className="p-3 border-b border-red-500/30 flex items-center gap-2 bg-red-500/5">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <h3 className="font-semibold text-red-400 text-sm">Requieren Atención</h3>
            <Badge variant="outline" className="ml-auto border-red-500/30 text-red-400 text-[10px]">
              {funnel.atRisk}
            </Badge>
          </div>
          {funnel.atRiskList.length === 0 ? (
            <div className="p-6 text-center">
              <CheckCircle className="h-6 w-6 mx-auto mb-2 text-emerald-500/50" />
              <p className="text-muted-foreground text-xs">Sin pagos pendientes 🎉</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30 max-h-[300px] overflow-y-auto">
              {funnel.atRiskList.slice(0, 15).map((sub: Subscription) => (
                <div key={sub.id} className="p-3 hover:bg-red-500/5 touch-feedback">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs md:text-sm font-medium truncate">{sub.customer_email || 'Sin email'}</p>
                      <div className="flex items-center gap-1 mt-1">
                        <Badge 
                          variant="outline" 
                          className={`text-[10px] ${
                            sub.status === 'unpaid' 
                              ? 'bg-red-500/20 text-red-300 border-red-500/30' 
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                          }`}
                        >
                          {sub.status === 'unpaid' ? 'Impago' : 'Vencido'}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{sub.plan_name}</span>
                      </div>
                    </div>
                    <span className="text-red-400 font-bold text-sm shrink-0">
                      ${(sub.amount / 100).toFixed(0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

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
                      <Badge variant="outline" className="bg-zinc-800 text-zinc-400 border-zinc-700 text-[10px] mt-1">
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
            <XCircle className="h-4 w-4 text-gray-500" />
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
                    <span className="text-[10px] text-gray-400 shrink-0 max-w-[80px] truncate">
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
            {revenueByPlan.slice(0, 8).map((plan, i) => (
              <div key={i} className="flex items-center gap-2 md:gap-4">
                <div className="w-24 md:w-40 text-[10px] md:text-sm font-medium truncate">{plan.name}</div>
                <div className="flex-1">
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${plan.percentage}%` }}
                    />
                  </div>
                </div>
                <div className="w-8 md:w-12 text-center text-[10px] md:text-xs text-muted-foreground">
                  {plan.count}
                </div>
                <div className="w-14 md:w-20 text-right text-[10px] md:text-sm font-medium text-foreground">
                  ${(plan.revenue / 100).toFixed(0)}
                </div>
                <div className="w-10 md:w-12 text-right text-[9px] md:text-xs text-muted-foreground">
                  {plan.percentage.toFixed(0)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pagination */}
      {totalCount > pageSize && (
        <div className="flex items-center justify-between p-3 rounded-xl border border-border/50 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Mostrando {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, totalCount)} de {totalCount.toLocaleString()}</span>
            <Select value={pageSize.toString()} onValueChange={(v) => { setPageSize(parseInt(v)); setPage(1); }}>
              <SelectTrigger className="w-20 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-8"
            >
              <ChevronLeft className="h-4 w-4" />
              Anterior
            </Button>
            <span className="text-sm text-muted-foreground px-2">
              {page} / {totalPages || 1}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-8"
            >
              Siguiente
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

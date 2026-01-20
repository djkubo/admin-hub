import { useState } from 'react';
import { useDailyKPIs, TimeFilter } from '@/hooks/useDailyKPIs';
import { 
  UserPlus, 
  Play, 
  ArrowRightCircle, 
  DollarSign, 
  RefreshCw, 
  XCircle, 
  AlertTriangle,
  TrendingUp
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function DailyKPIsPanel() {
  const [filter, setFilter] = useState<TimeFilter>('today');
  const { kpis, isLoading, refetch } = useDailyKPIs(filter);

  const filterLabels: Record<TimeFilter, string> = {
    today: 'Hoy',
    '7d': '7 días',
    month: 'Este mes',
  };

  const kpiCards = [
    {
      title: 'Registros',
      value: kpis.registrationsToday,
      icon: UserPlus,
      color: 'blue',
      subtitle: 'Nuevos usuarios',
    },
    {
      title: 'Trials Iniciados',
      value: kpis.trialsStartedToday,
      icon: Play,
      color: 'purple',
      subtitle: 'Pruebas activas',
    },
    {
      title: 'Conversiones Trial',
      value: kpis.trialConversionsToday,
      revenue: kpis.conversionRevenue,
      icon: ArrowRightCircle,
      color: 'emerald',
      subtitle: 'De trial a pago',
    },
    {
      title: 'Nuevos Pagadores',
      value: kpis.newPayersToday,
      revenue: kpis.newRevenue,
      icon: DollarSign,
      color: 'cyan',
      subtitle: 'Primera compra',
    },
    {
      title: 'Renovaciones',
      value: kpis.renewalsToday,
      revenue: kpis.renewalRevenue,
      icon: RefreshCw,
      color: 'green',
      subtitle: 'Pagos recurrentes',
    },
    {
      title: 'Fallos',
      value: kpis.failuresToday,
      icon: AlertTriangle,
      color: 'amber',
      subtitle: 'Pagos rechazados',
      isNegative: true,
    },
    {
      title: 'Cancelaciones',
      value: kpis.cancellationsToday,
      icon: XCircle,
      color: 'red',
      subtitle: 'Suscripciones canceladas',
      isNegative: true,
    },
  ];

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; icon: string; border: string }> = {
      blue: { bg: 'bg-blue-500/10', text: 'text-blue-400', icon: 'text-blue-500', border: 'border-blue-500/30' },
      purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', icon: 'text-purple-500', border: 'border-purple-500/30' },
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', icon: 'text-emerald-500', border: 'border-emerald-500/30' },
      cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', icon: 'text-cyan-500', border: 'border-cyan-500/30' },
      green: { bg: 'bg-green-500/10', text: 'text-green-400', icon: 'text-green-500', border: 'border-green-500/30' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: 'text-amber-500', border: 'border-amber-500/30' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400', icon: 'text-red-500', border: 'border-red-500/30' },
    };
    return colors[color] || colors.blue;
  };

  const totalRevenue = kpis.newRevenue + kpis.conversionRevenue + kpis.renewalRevenue;

  return (
    <div className="space-y-4">
      {/* Header with filter */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">KPIs Diarios</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border/50 overflow-hidden">
            {(['today', '7d', 'month'] as TimeFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-[#1a1f36] text-gray-400 hover:text-white'
                }`}
              >
                {filterLabels[f]}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Total Revenue Banner */}
      <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-400">Ingresos Totales ({filterLabels[filter]})</p>
            <p className="text-3xl font-bold text-white">
              ${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="flex items-center gap-2 text-cyan-400">
              <span>Nuevos:</span>
              <span className="font-semibold">${kpis.newRevenue.toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-2 text-emerald-400">
              <span>Conversiones:</span>
              <span className="font-semibold">${kpis.conversionRevenue.toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-2 text-green-400">
              <span>Renovaciones:</span>
              <span className="font-semibold">${kpis.renewalRevenue.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {kpiCards.map((card, index) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;

          if (isLoading) {
            return (
              <div key={index} className="rounded-xl border border-border/50 bg-[#1a1f36] p-4">
                <Skeleton className="h-8 w-8 rounded-lg mb-2" />
                <Skeleton className="h-4 w-20 mb-1" />
                <Skeleton className="h-6 w-16" />
              </div>
            );
          }

          return (
            <div
              key={index}
              className={`rounded-xl border ${colors.border} bg-[#1a1f36] p-4 transition-all hover:shadow-lg`}
            >
              <div className={`inline-flex p-2 rounded-lg ${colors.bg} mb-2`}>
                <Icon className={`h-4 w-4 ${colors.icon}`} />
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{card.title}</p>
              <p className={`text-xl font-bold ${card.isNegative && card.value > 0 ? 'text-red-400' : 'text-white'}`}>
                {card.value}
              </p>
              {'revenue' in card && card.revenue !== undefined && card.revenue > 0 && (
                <p className={`text-xs ${colors.text} mt-0.5`}>
                  ${card.revenue.toFixed(2)}
                </p>
              )}
              <p className="text-[10px] text-gray-500 mt-1">{card.subtitle}</p>
            </div>
          );
        })}
      </div>

      {/* Failure Reasons */}
      {kpis.failureReasons.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-[#1a1f36] p-4">
          <h3 className="text-sm font-medium text-amber-400 mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Razones de Fallo
          </h3>
          <div className="flex flex-wrap gap-2">
            {kpis.failureReasons.slice(0, 5).map((reason, i) => (
              <Badge
                key={i}
                variant="outline"
                className="border-amber-500/30 text-amber-400 bg-amber-500/10"
              >
                {reason.reason}: {reason.count}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

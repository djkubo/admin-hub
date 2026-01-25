import { useEffect, useMemo, useState } from "react";
import { DollarSign, TrendingUp, Users, Calendar } from "lucide-react";
import { subMonths, startOfMonth, endOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

interface MetricsResponse {
  mrr: number;
  arpu: number;
  churnRate: number;
  ltv: number;
  ltvCacRatio: number;
  activeCustomers: number;
  avgLifespanMonths: number;
}

export function LTVMetrics() {
  const [metrics, setMetrics] = useState<MetricsResponse>({
    mrr: 0,
    arpu: 0,
    churnRate: 0,
    ltv: 0,
    ltvCacRatio: 0,
    activeCustomers: 0,
    avgLifespanMonths: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      setLoading(true);
      const now = new Date();
      const lastMonthStart = startOfMonth(subMonths(now, 1));
      const lastMonthEnd = endOfMonth(subMonths(now, 1));

      try {
        const [{ data: mrrRows, error: mrrError }, { data: churnRows, error: churnError }] =
          await Promise.all([
            supabase.rpc("metrics_mrr", {
              start_date: lastMonthStart.toISOString(),
              end_date: lastMonthEnd.toISOString(),
            }),
            supabase.rpc("metrics_churn", {
              start_date: lastMonthStart.toISOString(),
              end_date: lastMonthEnd.toISOString(),
            }),
          ]);

        if (mrrError) throw mrrError;
        if (churnError) throw churnError;

        const mrrRow = Array.isArray(mrrRows) ? mrrRows[0] : mrrRows;
        const churnRow = Array.isArray(churnRows) ? churnRows[0] : churnRows;
        const mrrValue = Number(mrrRow?.mrr ?? 0) / 100;
        const activeCustomers = Number(mrrRow?.active_customers ?? 0);
        const arpu = activeCustomers > 0 ? mrrValue / activeCustomers : 0;
        const churnRate = Number(churnRow?.churn_rate ?? 0);

        const effectiveChurnRate = Math.max(churnRate, 5) / 100;
        const ltv = arpu / effectiveChurnRate;
        const estimatedCAC = arpu * 0.3;
        const ltvCacRatio = estimatedCAC > 0 ? ltv / estimatedCAC : 0;
        const avgLifespanMonths = churnRate > 0 ? 100 / churnRate : 20;

        setMetrics({
          mrr: mrrValue,
          arpu,
          churnRate,
          ltv,
          ltvCacRatio,
          activeCustomers,
          avgLifespanMonths,
        });
      } catch (error) {
        console.error("Error fetching LTV metrics:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
  }, []);

  const loadingState = useMemo(
    () => (
      <div className="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="rounded-xl border border-border/50 bg-[#1a1f36] p-3 sm:p-5">
            <div className="h-8 w-8 rounded-lg bg-muted/30 mb-3" />
            <div className="h-5 w-20 bg-muted/30 rounded mb-2" />
            <div className="h-3 w-24 bg-muted/20 rounded" />
          </div>
        ))}
      </div>
    ),
    []
  );

  const MetricCard = ({
    icon: Icon,
    label,
    value,
    subtext,
    color,
  }: {
    icon: any;
    label: string;
    value: string;
    subtext?: string;
    color: string;
  }) => (
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-3 sm:p-5 hover:border-primary/30 transition-all">
      <div className="flex items-start justify-between mb-2 sm:mb-3">
        <div className={`p-1.5 sm:p-2.5 rounded-lg ${color}`}>
          <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      </div>
      <p className="text-lg sm:text-2xl font-bold text-white mb-0.5 sm:mb-1">{value}</p>
      <p className="text-xs sm:text-sm text-gray-400">{label}</p>
      {subtext && (
        <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 sm:mt-1">{subtext}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-0">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-white">Métricas de LTV</h3>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Fórmula: ARPU / User Churn Rate
          </p>
        </div>
      </div>

      {loading ? (
        loadingState
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            icon={DollarSign}
            label="LTV"
            value={`$${metrics.ltv.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}`}
            subtext="Valor por cliente"
            color="bg-emerald-500/20 text-emerald-400"
          />

          <MetricCard
            icon={TrendingUp}
            label="MRR"
            value={`$${metrics.mrr.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}`}
            subtext="Último mes"
            color="bg-indigo-500/20 text-indigo-400"
          />

          <MetricCard
            icon={Users}
            label="ARPU"
            value={`$${metrics.arpu.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`}
            subtext={`${metrics.activeCustomers} activos`}
            color="bg-purple-500/20 text-purple-400"
          />

          <MetricCard
            icon={Calendar}
            label="Churn"
            value={`${metrics.churnRate.toFixed(1)}%`}
            subtext={`~${metrics.avgLifespanMonths.toFixed(0)}m vida`}
            color="bg-rose-500/20 text-rose-400"
          />
        </div>
      )}

      {/* LTV Formula Explanation - Hidden on mobile */}
      <div className="hidden sm:block rounded-lg bg-gray-800/30 border border-gray-700/50 p-3 sm:p-4 mt-3 sm:mt-4">
        <div className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm overflow-x-auto">
          <div className="flex items-center gap-1 sm:gap-2 whitespace-nowrap">
            <span className="text-gray-400">LTV =</span>
            <span className="font-mono text-primary">
              ${metrics.arpu.toFixed(2)}
            </span>
            <span className="text-gray-500">(ARPU)</span>
            <span className="text-gray-400">÷</span>
            <span className="font-mono text-rose-400">
              {(Math.max(metrics.churnRate, 5) / 100).toFixed(2)}
            </span>
            <span className="text-gray-500">(Churn)</span>
            <span className="text-gray-400">=</span>
            <span className="font-mono font-bold text-emerald-400">
              ${metrics.ltv.toFixed(0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

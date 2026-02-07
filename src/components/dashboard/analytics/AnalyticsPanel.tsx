import { useState, useMemo } from "react";
import { MRRMovementsChart } from "./MRRMovementsChart";
import { CohortRetentionTable } from "./CohortRetentionTable";
import { LTVMetrics } from "./LTVMetrics";
import { RevenueByPlanChart } from "./RevenueByPlanChart";
import { SourceAnalytics } from "./SourceAnalytics";
import { AnalyzeButton } from "./AnalyzeButton";
import { AIInsightsWidget } from "../AIInsightsWidget";
import { Sparkles, BarChart3 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { startOfMonth, subMonths } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalyticsTransactions } from "@/hooks/useAnalyticsTransactions";
import { useAnalyticsActiveSubscriptions } from "@/hooks/useAnalyticsActiveSubscriptions";

export type AnalyticsPeriod = "7d" | "30d" | "90d" | "all";

function getMonthsForPeriod(period: AnalyticsPeriod): number {
  switch (period) {
    case "7d":
      return 1;
    case "30d":
      return 2;
    case "90d":
      return 4;
    case "all":
      return 12;
  }
}

export function AnalyticsPanel() {
  const [period, setPeriod] = useState<AnalyticsPeriod>("30d");
  
  const monthsToShow = getMonthsForPeriod(period);
  const monthsLookback = Math.max(monthsToShow, 2); // LTV churn needs ~60 days

  // Load the minimum transaction history required for the selected modules (server-paged, auto-draining).
  const txStartIso = useMemo(() => {
    const now = new Date();
    const start = startOfMonth(subMonths(now, monthsLookback - 1));
    return start.toISOString();
  }, [monthsLookback]);

  const txQuery = useAnalyticsTransactions({
    startDate: txStartIso,
    statuses: ["succeeded", "paid"],
    pageSize: 1000,
    maxPages: 25,
  });

  const subsQuery = useAnalyticsActiveSubscriptions({ pageSize: 1000, maxPages: 10 });

  const isLoading = txQuery.isLoading || subsQuery.isLoading;
  const transactions = txQuery.transactions;
  const activeSubscriptions = subsQuery.subscriptions;

  const periodButtons: { value: AnalyticsPeriod; label: string }[] = [
    { value: "7d", label: "7 días" },
    { value: "30d", label: "30 días" },
    { value: "90d", label: "90 días" },
    { value: "all", label: "Todo" },
  ];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-display text-foreground flex items-center gap-3">
              <BarChart3 className="h-7 w-7 text-primary" />
              ANALÍTICA
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Métricas avanzadas: LTV, MRR, Cohortes
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-display text-foreground flex items-center gap-3">
            <BarChart3 className="h-7 w-7 text-primary" />
            ANALÍTICA
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Métricas avanzadas: LTV, MRR, Cohortes
          </p>
        </div>
      </div>

      {/* Loading/progress hint (auto-draining pages in the background) */}
      {(txQuery.isFetching || subsQuery.isFetching) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Cargando métricas…</span>
          <span>
            Transacciones: {txQuery.loadedCount.toLocaleString()}
            {typeof txQuery.totalCount === "number" ? ` / ${txQuery.totalCount.toLocaleString()}` : ""}
          </span>
          <span className="hidden sm:inline">
            Suscripciones activas: {subsQuery.loadedCount.toLocaleString()}
            {typeof subsQuery.totalCount === "number" ? ` / ${subsQuery.totalCount.toLocaleString()}` : ""}
          </span>
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 sm:p-4 rounded-xl border border-zinc-800 bg-card">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
            <Sparkles className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-white text-sm sm:text-base">El Oráculo - Análisis IA</h3>
            <p className="text-xs sm:text-sm text-muted-foreground truncate">
              Genera un análisis estratégico
            </p>
          </div>
        </div>
        <AnalyzeButton />
      </div>

      {/* AI Insights Results - Shows the last analysis */}
      <AIInsightsWidget />

      {/* Period Filter */}
      <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-muted/30 border border-border/50">
        <span className="text-xs sm:text-sm text-muted-foreground px-2">Período:</span>
        {periodButtons.map((btn) => (
          <Button
            key={btn.value}
            variant={period === btn.value ? "default" : "ghost"}
            size="sm"
            onClick={() => setPeriod(btn.value)}
            className="text-xs sm:text-sm h-7 sm:h-8 px-2 sm:px-3"
          >
            {btn.label}
          </Button>
        ))}
      </div>

      <Tabs defaultValue="source" className="space-y-3 sm:space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max sm:w-auto">
            <TabsTrigger value="source" className="text-xs sm:text-sm px-2.5 sm:px-3">Por Fuente</TabsTrigger>
            <TabsTrigger value="ltv" className="text-xs sm:text-sm px-2.5 sm:px-3">LTV & MRR</TabsTrigger>
            <TabsTrigger value="cohorts" className="text-xs sm:text-sm px-2.5 sm:px-3">Cohortes</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="source" className="space-y-4 sm:space-y-6">
          {/* Source Attribution Analytics */}
          <SourceAnalytics period={period} />
        </TabsContent>

        <TabsContent value="ltv" className="space-y-4 sm:space-y-6">
          {/* LTV Metrics Row - Usa historial completo para calcular Churn/LTV correctamente */}
          <LTVMetrics 
            transactions={transactions} 
            activeSubscriptions={activeSubscriptions} 
          />

          {/* Revenue by Plan Chart - Pareto Analysis */}
          <RevenueByPlanChart />

          {/* MRR Movements Chart */}
          <MRRMovementsChart 
            transactions={transactions} 
            monthsToShow={monthsToShow}
          />
        </TabsContent>

        <TabsContent value="cohorts" className="space-y-4 sm:space-y-6">
          {/* Cohort Retention Table */}
          <CohortRetentionTable 
            transactions={transactions} 
            monthsToShow={monthsToShow}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

import { RefreshCw, TrendingUp, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Line,
  ComposedChart,
} from "recharts";
import { useSubscriptions } from "@/hooks/useSubscriptions";

export function RevenueByPlanChart() {
  const {
    revenueByPlan,
    totalActiveRevenue,
    totalActiveCount,
    syncSubscriptions,
    isLoading,
  } = useSubscriptions();

  // Find which plans make up 80% of revenue (Pareto)
  const paretoPlans = revenueByPlan.filter((p) => p.cumulative <= 80 || p.cumulative - p.percentage < 80);
  const paretoPercentage = paretoPlans.length > 0 
    ? Math.round((paretoPlans.length / revenueByPlan.length) * 100) 
    : 0;

  // Colors for bars
  const getBarColor = (index: number, cumulative: number) => {
    if (cumulative <= 80) return "hsl(var(--chart-1))"; // Primary color for top 80%
    return "hsl(var(--muted-foreground) / 0.3)"; // Muted for the rest
  };

  const chartData = revenueByPlan.slice(0, 10).map((plan, index) => ({
    ...plan,
    revenueUSD: plan.revenue / 100,
    label: plan.name.length > 15 ? plan.name.slice(0, 15) + "..." : plan.name,
    isPareto: plan.cumulative <= 80 || plan.cumulative - plan.percentage < 80,
  }));

  return (
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-3 sm:p-6">
      <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/20 shrink-0">
            <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm sm:text-lg font-semibold text-white">Ingresos por Plan</h3>
            <p className="text-[10px] sm:text-sm text-muted-foreground truncate">
              Pareto: {paretoPercentage}% genera 80% ingresos
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
          <div className="text-left sm:text-right">
            <p className="text-lg sm:text-2xl font-bold text-primary">
              ${(totalActiveRevenue / 100).toLocaleString()}
            </p>
            <p className="text-[10px] sm:text-xs text-muted-foreground">MRR • {totalActiveCount} activas</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncSubscriptions.mutate()}
            disabled={syncSubscriptions.isPending}
            className="gap-1.5 sm:gap-2 text-xs sm:text-sm h-8 sm:h-9 px-2 sm:px-3"
          >
            <RefreshCw className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${syncSubscriptions.isPending ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Sync</span>
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-[200px] sm:h-[300px] flex items-center justify-center">
          <div className="h-6 w-6 sm:h-8 sm:w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : revenueByPlan.length === 0 ? (
        <div className="h-[200px] sm:h-[300px] flex flex-col items-center justify-center text-muted-foreground">
          <TrendingUp className="h-10 w-10 sm:h-12 sm:w-12 mb-2 sm:mb-3 opacity-30" />
          <p className="text-sm sm:text-base">No hay suscripciones activas</p>
          <p className="text-xs sm:text-sm">Sincroniza desde Stripe</p>
        </div>
      ) : (
        <>
          {/* Chart */}
          <div className="h-[220px] sm:h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.3)" />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                  interval={0}
                />
                <YAxis
                  yAxisId="left"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickFormatter={(value) => `$${value >= 1000 ? `${(value/1000).toFixed(0)}k` : value}`}
                  width={45}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="hsl(var(--chart-2))"
                  fontSize={10}
                  tickFormatter={(value) => `${value}%`}
                  domain={[0, 100]}
                  width={35}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value: any, name: string) => {
                    if (name === "revenueUSD") return [`$${value.toLocaleString()}`, "Ingresos"];
                    if (name === "cumulative") return [`${value.toFixed(1)}%`, "Acumulado"];
                    return [value, name];
                  }}
                />
                <Bar yAxisId="left" dataKey="revenueUSD" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.isPareto ? "hsl(var(--chart-1))" : "hsl(var(--muted-foreground) / 0.3)"}
                    />
                  ))}
                </Bar>
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="cumulative"
                  stroke="hsl(var(--chart-2))"
                  strokeWidth={2}
                  dot={{ fill: "hsl(var(--chart-2))", strokeWidth: 0, r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="mt-3 sm:mt-4 flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-xs sm:text-sm">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <div className="h-2.5 w-2.5 sm:h-3 sm:w-3 rounded bg-primary" />
              <span className="text-muted-foreground">Top 80%</span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <div className="h-2.5 w-2.5 sm:h-3 sm:w-3 rounded bg-muted-foreground/30" />
              <span className="text-muted-foreground">Resto</span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <div className="h-0.5 w-4 sm:w-6 bg-[hsl(var(--chart-2))]" />
              <span className="text-muted-foreground">% Acum</span>
            </div>
          </div>

          {/* Top Plans Table - Mobile optimized */}
          <div className="mt-4 sm:mt-6 border-t border-border/50 pt-3 sm:pt-4">
            <h4 className="text-xs sm:text-sm font-medium text-muted-foreground mb-2 sm:mb-3 flex items-center gap-1.5 sm:gap-2">
              <Crown className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-yellow-500" />
              Top Planes
            </h4>
            <div className="space-y-1.5 sm:space-y-2">
              {revenueByPlan.slice(0, 5).map((plan, index) => (
                <div
                  key={plan.name}
                  className="flex items-center justify-between p-2 sm:p-3 rounded-lg bg-muted/20"
                >
                  <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <span className="text-sm sm:text-lg font-bold text-muted-foreground shrink-0">#{index + 1}</span>
                    <div className="min-w-0">
                      <p className="font-medium text-white text-xs sm:text-sm truncate">{plan.name}</p>
                      <p className="text-[10px] sm:text-xs text-muted-foreground">
                        {plan.count} sub{plan.count !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <p className="font-semibold text-primary text-xs sm:text-sm">
                      ${(plan.revenue / 100).toLocaleString()}
                    </p>
                    <Badge
                      variant="outline"
                      className={`text-[10px] sm:text-xs ${
                        plan.cumulative <= 80
                          ? "border-primary/50 text-primary"
                          : "border-muted text-muted-foreground"
                      }`}
                    >
                      {plan.percentage.toFixed(1)}%
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

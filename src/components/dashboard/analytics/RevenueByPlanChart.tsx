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
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/20">
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Ingresos por Plan</h3>
            <p className="text-sm text-muted-foreground">
              Análisis Pareto: el {paretoPercentage}% de planes genera el 80% de ingresos
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-2xl font-bold text-primary">
              ${(totalActiveRevenue / 100).toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">MRR total • {totalActiveCount} activas</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncSubscriptions.mutate()}
            disabled={syncSubscriptions.isPending}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${syncSubscriptions.isPending ? "animate-spin" : ""}`} />
            Sincronizar
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-[300px] flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : revenueByPlan.length === 0 ? (
        <div className="h-[300px] flex flex-col items-center justify-center text-muted-foreground">
          <TrendingUp className="h-12 w-12 mb-3 opacity-30" />
          <p>No hay suscripciones activas</p>
          <p className="text-sm">Sincroniza desde Stripe para ver el análisis</p>
        </div>
      ) : (
        <>
          {/* Chart */}
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.3)" />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis
                  yAxisId="left"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickFormatter={(value) => `$${value.toLocaleString()}`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="hsl(var(--chart-2))"
                  fontSize={12}
                  tickFormatter={(value) => `${value}%`}
                  domain={[0, 100]}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
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
                  dot={{ fill: "hsl(var(--chart-2))", strokeWidth: 0, r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="mt-4 flex items-center justify-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-primary" />
              <span className="text-muted-foreground">Top 80% (Pareto)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-muted-foreground/30" />
              <span className="text-muted-foreground">Resto</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-0.5 w-6 bg-[hsl(var(--chart-2))]" />
              <span className="text-muted-foreground">% Acumulado</span>
            </div>
          </div>

          {/* Top Plans Table */}
          <div className="mt-6 border-t border-border/50 pt-4">
            <h4 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Crown className="h-4 w-4 text-yellow-500" />
              Top Planes por Ingresos
            </h4>
            <div className="space-y-2">
              {revenueByPlan.slice(0, 5).map((plan, index) => (
                <div
                  key={plan.name}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/20"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-muted-foreground">#{index + 1}</span>
                    <div>
                      <p className="font-medium text-white">{plan.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {plan.count} {plan.count === 1 ? "suscripción" : "suscripciones"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-primary">
                      ${(plan.revenue / 100).toLocaleString()}
                    </p>
                    <Badge
                      variant="outline"
                      className={
                        plan.cumulative <= 80
                          ? "border-primary/50 text-primary"
                          : "border-muted text-muted-foreground"
                      }
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

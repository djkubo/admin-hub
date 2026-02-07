import { useMemo } from "react";
import { DollarSign, TrendingUp, Users, Calendar } from "lucide-react";
import type { AnalyticsActiveSubscription } from "@/hooks/useAnalyticsActiveSubscriptions";

interface Transaction {
  id: string;
  amount: number;
  status: string;
  stripe_created_at: string | null;
  customer_email: string | null;
}

interface LTVMetricsProps {
  transactions: Transaction[];
  activeSubscriptions: AnalyticsActiveSubscription[];
}

export function LTVMetrics({ transactions, activeSubscriptions: activeSubscriptionsInput }: LTVMetricsProps) {
  const metrics = useMemo(() => {
    // Get successful transactions
    const successfulTx = transactions.filter(
      (tx) =>
        tx.status === "succeeded" ||
        tx.status === "paid"
    );

    // *** MRR CORRECTO: Suma de suscripciones activas ***
    // Solo considera suscripciones con status 'active' (no 'trialing', 'canceled', etc.)
    const activeSubscriptions = (activeSubscriptionsInput || []).filter(
      (s) => s.status === "active"
    );
    const mrr = activeSubscriptions.reduce((sum, s) => sum + s.amount, 0) / 100;
    const activeSubscriptionCount = activeSubscriptions.length;

    // Get unique paying customers from active subscriptions
    const activeCustomerEmails = new Set(
      activeSubscriptions
        .filter((s) => s.customer_email)
        .map((s) => s.customer_email!.toLowerCase())
    );
    const activeCustomers = activeCustomerEmails.size;

    // Calculate ARPU (Average Revenue Per User) based on active subscriptions
    const arpu = activeCustomers > 0 ? mrr / activeCustomers : 0;

    // Calculate User Churn Rate
    // Compare active customers 2 months ago vs those who churned last month
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    // Customers who paid 30-60 days ago
    const twoMonthsAgoCustomers = new Set(
      successfulTx
        .filter((tx) => {
          if (!tx.stripe_created_at || !tx.customer_email) return false;
          const txDate = new Date(tx.stripe_created_at);
          return txDate >= sixtyDaysAgo && txDate < thirtyDaysAgo;
        })
        .map((tx) => tx.customer_email!.toLowerCase())
    );

    // Customers who paid in the last 30 days
    const lastMonthCustomers = new Set(
      successfulTx
        .filter((tx) => {
          if (!tx.stripe_created_at || !tx.customer_email) return false;
          const txDate = new Date(tx.stripe_created_at);
          return txDate >= thirtyDaysAgo;
        })
        .map((tx) => tx.customer_email!.toLowerCase())
    );

    // Churned = customers from 2 months ago who didn't pay last month
    let churnedCount = 0;
    twoMonthsAgoCustomers.forEach((email) => {
      if (!lastMonthCustomers.has(email)) {
        churnedCount++;
      }
    });

    const churnRate =
      twoMonthsAgoCustomers.size > 0
        ? (churnedCount / twoMonthsAgoCustomers.size) * 100
        : 0;

    // Calculate LTV (Lifetime Value) = ARPU / Churn Rate
    // If churn rate is 0, use a minimum of 5% to avoid infinity
    const effectiveChurnRate = Math.max(churnRate, 5) / 100;
    const ltv = arpu / effectiveChurnRate;

    // Calculate average customer lifespan in months
    const avgLifespanMonths = churnRate > 0 ? 100 / churnRate : 20;

    return {
      mrr,
      arpu,
      churnRate,
      ltv,
      activeCustomers,
      avgLifespanMonths,
      activeSubscriptionCount,
    };
  }, [transactions, activeSubscriptionsInput]);

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
    <div className="rounded-xl border border-border/50 bg-card p-3 sm:p-5 hover:border-primary/30 transition-all">
      <div className="flex items-start justify-between mb-2 sm:mb-3">
        <div className={`p-1.5 sm:p-2.5 rounded-lg ${color}`}>
          <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      </div>
      <p className="text-lg sm:text-2xl font-bold text-foreground mb-0.5 sm:mb-1">{value}</p>
      <p className="text-xs sm:text-sm text-muted-foreground">{label}</p>
      {subtext && (
        <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 sm:mt-1">{subtext}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-0">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-foreground">Métricas de LTV</h3>
          <p className="text-xs sm:text-sm text-muted-foreground">
            MRR = Suma de suscripciones activas | LTV = ARPU / tasa de bajas
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* VRP Style: Neutral zinc cards with primary accent for icons */}
        <MetricCard
          icon={DollarSign}
          label="MRR"
          value={`$${metrics.mrr.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`}
          subtext={`${metrics.activeSubscriptionCount} suscripciones activas`}
          color="bg-zinc-800 text-primary"
        />

        <MetricCard
          icon={TrendingUp}
          label="LTV"
          value={`$${metrics.ltv.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`}
          subtext="Valor por cliente"
          color="bg-zinc-800 text-primary"
        />

        <MetricCard
          icon={Users}
          label="ARPU"
          value={`$${metrics.arpu.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`}
          subtext={`${metrics.activeCustomers} activos`}
          color="bg-zinc-800 text-primary"
        />

        <MetricCard
          icon={Calendar}
          label="Bajas"
          value={`${metrics.churnRate.toFixed(1)}%`}
          subtext={`~${metrics.avgLifespanMonths.toFixed(0)}m de vida`}
          color="bg-red-500/20 text-red-400"
        />
      </div>

      {/* LTV Formula Explanation - Hidden on mobile */}
      <div className="hidden sm:block rounded-lg bg-gray-800/30 border border-gray-700/50 p-3 sm:p-4 mt-3 sm:mt-4">
        <div className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm overflow-x-auto">
          <div className="flex items-center gap-1 sm:gap-2 whitespace-nowrap">
            <span className="text-gray-400">MRR =</span>
            <span className="font-mono text-emerald-400 font-bold">
              ${metrics.mrr.toFixed(0)}
            </span>
            <span className="text-gray-500">({metrics.activeSubscriptionCount} subs activas)</span>
          </div>
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
            <span className="text-gray-500">(Bajas)</span>
            <span className="text-gray-400">=</span>
            <span className="font-mono font-bold text-indigo-400">
              ${metrics.ltv.toFixed(0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

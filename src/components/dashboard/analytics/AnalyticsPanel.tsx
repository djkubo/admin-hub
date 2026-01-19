import { MRRMovementsChart } from "./MRRMovementsChart";
import { CohortRetentionTable } from "./CohortRetentionTable";
import { LTVMetrics } from "./LTVMetrics";
import { RevenueByPlanChart } from "./RevenueByPlanChart";
import { AnalyzeButton } from "./AnalyzeButton";
import { Transaction } from "@/hooks/useTransactions";
import { Client } from "@/hooks/useClients";
import { Sparkles } from "lucide-react";

interface AnalyticsPanelProps {
  transactions: Transaction[];
  clients: Client[];
}

export function AnalyticsPanel({ transactions, clients }: AnalyticsPanelProps) {
  return (
    <div className="space-y-6">
      {/* AI Analysis Section */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-white">El Oráculo - Análisis IA</h3>
            <p className="text-sm text-muted-foreground">
              Genera un análisis estratégico con oportunidades y riesgos
            </p>
          </div>
        </div>
        <AnalyzeButton />
      </div>

      {/* LTV Metrics Row */}
      <LTVMetrics transactions={transactions} />

      {/* Revenue by Plan Chart - Pareto Analysis */}
      <RevenueByPlanChart />

      {/* MRR Movements Chart */}
      <MRRMovementsChart transactions={transactions} clients={clients} />

      {/* Cohort Retention Table */}
      <CohortRetentionTable transactions={transactions} />
    </div>
  );
}

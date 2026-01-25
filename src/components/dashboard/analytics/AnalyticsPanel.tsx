import { MRRMovementsChart } from "./MRRMovementsChart";
import { CohortRetentionTable } from "./CohortRetentionTable";
import { LTVMetrics } from "./LTVMetrics";
import { RevenueByPlanChart } from "./RevenueByPlanChart";
import { SourceAnalytics } from "./SourceAnalytics";
import { AnalyzeButton } from "./AnalyzeButton";
import { AIInsightsWidget } from "../AIInsightsWidget";
import { Transaction } from "@/hooks/useTransactions";
import { Client } from "@/hooks/useClients";
import { Sparkles } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AnalyticsPanelProps {
  transactions: Transaction[];
  clients: Client[];
}

export function AnalyticsPanel({ transactions, clients }: AnalyticsPanelProps) {
  return (
    <div className="space-y-4 sm:space-y-6">
      {/* AI Analysis Section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 sm:p-4 rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
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
          <SourceAnalytics />
        </TabsContent>

        <TabsContent value="ltv" className="space-y-4 sm:space-y-6">
          {/* LTV Metrics Row */}
          <LTVMetrics />

          {/* Revenue by Plan Chart - Pareto Analysis */}
          <RevenueByPlanChart />

          {/* MRR Movements Chart */}
          <MRRMovementsChart transactions={transactions} clients={clients} />
        </TabsContent>

        <TabsContent value="cohorts" className="space-y-4 sm:space-y-6">
          {/* Cohort Retention Table */}
          <CohortRetentionTable transactions={transactions} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

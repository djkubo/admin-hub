import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { format, subMonths, startOfMonth, endOfMonth } from "date-fns";
import { es } from "date-fns/locale";

interface Transaction {
  id: string;
  amount: number;
  status: string;
  stripe_created_at: string | null;
  customer_email: string | null;
  source: string | null;
}

interface Client {
  email: string | null;
  status: string | null;
  payment_status: string | null;
  converted_at: string | null;
  created_at: string | null;
}

interface MRRMovementsChartProps {
  transactions: Transaction[];
  clients: Client[];
}

interface MonthData {
  month: string;
  newBusiness: number;
  reactivation: number;
  churn: number;
  net: number;
}

export function MRRMovementsChart({ transactions, clients }: MRRMovementsChartProps) {
  const chartData = useMemo(() => {
    const now = new Date();
    const months: MonthData[] = [];

    // Build a map of client payment history by email
    const clientPaymentHistory = new Map<string, Date[]>();
    
    for (const tx of transactions) {
      if (!tx.customer_email || !tx.stripe_created_at) continue;
      if (tx.status !== "succeeded" && tx.status !== "paid") continue;
      
      const email = tx.customer_email.toLowerCase();
      const txDate = new Date(tx.stripe_created_at);
      
      if (!clientPaymentHistory.has(email)) {
        clientPaymentHistory.set(email, []);
      }
      clientPaymentHistory.get(email)!.push(txDate);
    }

    // Sort payment dates for each client
    clientPaymentHistory.forEach((dates) => {
      dates.sort((a, b) => a.getTime() - b.getTime());
    });

    // Process last 6 months
    for (let i = 5; i >= 0; i--) {
      const monthDate = subMonths(now, i);
      const monthStart = startOfMonth(monthDate);
      const monthEnd = endOfMonth(monthDate);
      const prevMonthEnd = endOfMonth(subMonths(monthDate, 1));

      let newBusiness = 0;
      let reactivation = 0;
      let churn = 0;

      // Analyze transactions in this month
      const monthTransactions = transactions.filter((tx) => {
        if (!tx.stripe_created_at) return false;
        const txDate = new Date(tx.stripe_created_at);
        return txDate >= monthStart && txDate <= monthEnd;
      });

      // Track emails processed this month for new vs reactivation
      const processedEmails = new Set<string>();

      for (const tx of monthTransactions) {
        if (!tx.customer_email) continue;
        if (tx.status !== "succeeded" && tx.status !== "paid") continue;
        
        const email = tx.customer_email.toLowerCase();
        if (processedEmails.has(email)) continue;
        processedEmails.add(email);

        const history = clientPaymentHistory.get(email) || [];
        const firstPayment = history[0];
        
        // Check if this is first payment ever (new business)
        if (firstPayment && firstPayment >= monthStart && firstPayment <= monthEnd) {
          newBusiness += tx.amount / 100;
        } else {
          // Check for reactivation: had payment before, but gap > 60 days
          const previousPayments = history.filter((d) => d < monthStart);
          if (previousPayments.length > 0) {
            const lastPrevPayment = previousPayments[previousPayments.length - 1];
            const daysSinceLast = Math.floor(
              (monthStart.getTime() - lastPrevPayment.getTime()) / (1000 * 60 * 60 * 24)
            );
            if (daysSinceLast > 60) {
              reactivation += tx.amount / 100;
            }
          }
        }
      }

      // Calculate churn: clients who had payment in previous months but not this month
      const churned = new Set<string>();
      clientPaymentHistory.forEach((dates, email) => {
        const hadPaymentBefore = dates.some((d) => d <= prevMonthEnd);
        const hasPaymentThisMonth = dates.some(
          (d) => d >= monthStart && d <= monthEnd
        );
        const hasPaymentAfter = dates.some((d) => d > monthEnd);

        // If they paid before but not this month and not after, they churned
        if (hadPaymentBefore && !hasPaymentThisMonth) {
          // Find their average payment
          const prevPayments = transactions.filter(
            (tx) =>
              tx.customer_email?.toLowerCase() === email &&
              tx.stripe_created_at &&
              new Date(tx.stripe_created_at) <= prevMonthEnd &&
              (tx.status === "succeeded" || tx.status === "paid")
          );
          if (prevPayments.length > 0 && !churned.has(email)) {
            const avgPayment =
              prevPayments.reduce((sum, tx) => sum + tx.amount, 0) /
              prevPayments.length /
              100;
            // Only count as churn if they don't come back
            if (!hasPaymentAfter) {
              churn += avgPayment;
              churned.add(email);
            }
          }
        }
      });

      months.push({
        month: format(monthDate, "MMM yy", { locale: es }),
        newBusiness: Math.round(newBusiness),
        reactivation: Math.round(reactivation),
        churn: -Math.round(churn), // Negative for visual effect
        net: Math.round(newBusiness + reactivation - churn),
      });
    }

    return months;
  }, [transactions, clients]);

  // Custom tooltip content renderer (not a component, just a render function)
  const renderTooltipContent = (props: { active?: boolean; payload?: any[]; label?: string }) => {
    const { active, payload, label } = props;
    if (active && payload && payload.length) {
      return (
        <div className="bg-[#1a1f36] border border-gray-700/50 rounded-lg p-3 shadow-xl">
          <p className="text-white font-medium mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p
              key={index}
              className="text-sm"
              style={{ color: entry.color }}
            >
              {entry.name}: ${Math.abs(entry.value).toLocaleString()}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-white">Movimientos de MRR</h3>
        <p className="text-sm text-muted-foreground">
          Análisis de nuevo negocio, reactivaciones y churn por mes
        </p>
      </div>

      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} stackOffset="sign">
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.3} />
            <XAxis
              dataKey="month"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              tickFormatter={(value) => `$${Math.abs(value)}`}
            />
            <Tooltip content={renderTooltipContent} />
            <Legend
              wrapperStyle={{ paddingTop: "20px" }}
              formatter={(value) => (
                <span className="text-gray-300 text-sm">{value}</span>
              )}
            />
            <ReferenceLine y={0} stroke="#4B5563" />
            <Bar
              dataKey="newBusiness"
              name="Nuevo Negocio"
              stackId="stack"
              fill="#10B981"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="reactivation"
              name="Reactivación"
              stackId="stack"
              fill="#6366F1"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="churn"
              name="Churn"
              stackId="stack"
              fill="#F43F5E"
              radius={[0, 0, 4, 4]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary */}
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="text-center p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <p className="text-xs text-emerald-400 mb-1">Nuevo Negocio (6m)</p>
          <p className="text-lg font-bold text-emerald-400">
            ${chartData.reduce((sum, d) => sum + d.newBusiness, 0).toLocaleString()}
          </p>
        </div>
        <div className="text-center p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
          <p className="text-xs text-indigo-400 mb-1">Reactivaciones (6m)</p>
          <p className="text-lg font-bold text-indigo-400">
            ${chartData.reduce((sum, d) => sum + d.reactivation, 0).toLocaleString()}
          </p>
        </div>
        <div className="text-center p-3 rounded-lg bg-rose-500/10 border border-rose-500/20">
          <p className="text-xs text-rose-400 mb-1">Churn (6m)</p>
          <p className="text-lg font-bold text-rose-400">
            ${Math.abs(chartData.reduce((sum, d) => sum + d.churn, 0)).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  );
}

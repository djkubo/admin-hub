import { DollarSign, TrendingUp, TrendingDown, Users, UserMinus, Calendar } from 'lucide-react';
import { DashboardMetrics } from '@/hooks/useMetrics';
import { IncomingRevenueCard } from './IncomingRevenueCard';

interface MetricsCardsProps {
  metrics: DashboardMetrics;
  invoiceData?: {
    totalNext72h: number;
    totalPending: number;
    invoiceCount: number;
    isLoading: boolean;
  };
}

const defaultMetrics: DashboardMetrics = {
  salesTodayUSD: 0,
  salesTodayMXN: 0,
  salesTodayTotal: 0,
  salesMonthUSD: 0,
  salesMonthMXN: 0,
  salesMonthTotal: 0,
  conversionRate: 0,
  trialCount: 0,
  convertedCount: 0,
  churnCount: 0,
  recoveryList: [],
  leadCount: 0,
  customerCount: 0
};

export function MetricsCards({ metrics: propMetrics, invoiceData }: MetricsCardsProps) {
  // Ensure metrics is always defined with fallback values
  const metrics = propMetrics || defaultMetrics;
  const cards = [
    {
      title: 'Ventas Hoy',
      value: `$${metrics.salesTodayTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      subtitle: `$${metrics.salesTodayUSD.toFixed(2)} USD + $${metrics.salesTodayMXN.toFixed(2)} MXN`,
      icon: Calendar,
      trend: metrics.salesTodayTotal > 0 ? 'up' : 'neutral',
      color: 'cyan'
    },
    {
      title: 'Ventas del Mes',
      value: `$${metrics.salesMonthTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      subtitle: `$${metrics.salesMonthUSD.toFixed(2)} USD + $${metrics.salesMonthMXN.toFixed(2)} MXN`,
      icon: DollarSign,
      trend: 'up',
      color: 'emerald'
    },
    {
      title: 'Tasa de Conversión',
      value: `${metrics.conversionRate.toFixed(1)}%`,
      subtitle: `${metrics.convertedCount} de ${metrics.trialCount} trials`,
      icon: TrendingUp,
      trend: metrics.conversionRate > 10 ? 'up' : 'neutral',
      color: 'blue'
    },
    {
      title: 'Churn',
      value: metrics.churnCount.toString(),
      subtitle: 'Suscripciones perdidas',
      icon: UserMinus,
      trend: metrics.churnCount > 5 ? 'down' : 'neutral',
      color: 'red'
    }
  ];

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; icon: string; glow: string }> = {
      cyan: {
        bg: 'bg-cyan-500/10',
        text: 'text-cyan-400',
        icon: 'text-cyan-500',
        glow: 'shadow-cyan-500/20'
      },
      emerald: {
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-400',
        icon: 'text-emerald-500',
        glow: 'shadow-emerald-500/20'
      },
      blue: {
        bg: 'bg-blue-500/10',
        text: 'text-blue-400',
        icon: 'text-blue-500',
        glow: 'shadow-blue-500/20'
      },
      purple: {
        bg: 'bg-purple-500/10',
        text: 'text-purple-400',
        icon: 'text-purple-500',
        glow: 'shadow-purple-500/20'
      },
      red: {
        bg: 'bg-red-500/10',
        text: 'text-red-400',
        icon: 'text-red-500',
        glow: 'shadow-red-500/20'
      }
    };
    return colors[color] || colors.blue;
  };

  return (
    <div className="space-y-4">
      {/* Incoming Revenue Card - Prominent at top */}
      {invoiceData && (
        <IncomingRevenueCard
          totalNext72h={invoiceData.totalNext72h}
          totalPending={invoiceData.totalPending}
          invoiceCount={invoiceData.invoiceCount}
          isLoading={invoiceData.isLoading}
        />
      )}
      
      {/* Regular metrics grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cards.map((card, index) => {
          const colors = getColorClasses(card.color);
          const Icon = card.icon;
          
          return (
            <div 
              key={index}
              className={`relative rounded-xl border border-border/50 bg-[#1a1f36] p-6 transition-all hover:shadow-lg ${colors.glow}`}
            >
              {/* Sparkline indicator */}
              <div className="absolute top-4 right-4">
                <div className={`w-16 h-8 flex items-end gap-0.5`}>
                  {[40, 65, 45, 70, 55, 80, 60, 75].map((height, i) => (
                    <div
                      key={i}
                      className={`w-1.5 rounded-full ${
                        card.trend === 'up' 
                          ? 'bg-emerald-500/60' 
                          : card.trend === 'down' 
                            ? 'bg-red-500/60' 
                            : 'bg-gray-500/60'
                      }`}
                      style={{ height: `${height}%` }}
                    />
                  ))}
                </div>
              </div>

              <div className={`inline-flex p-2 rounded-lg ${colors.bg} mb-3`}>
                <Icon className={`h-5 w-5 ${colors.icon}`} />
              </div>
              
              <p className="text-sm text-gray-400 mb-1">{card.title}</p>
              <p className="text-2xl font-bold text-white mb-1">{card.value}</p>
              <p className={`text-xs ${colors.text}`}>{card.subtitle}</p>

              {card.trend === 'up' && (
                <div className="absolute bottom-4 right-4">
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                </div>
              )}
              {card.trend === 'down' && (
                <div className="absolute bottom-4 right-4">
                  <TrendingDown className="h-4 w-4 text-red-500" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

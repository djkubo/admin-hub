import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, TrendingUp, AlertTriangle, Loader2, Download, Users, CreditCard, UserX, Zap, UserPlus, Crown, Clock } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

interface ActionableClient {
  email: string;
  name: string;
  amount?: number;
  date?: string;
  reason?: string;
}

interface ActionableSegment {
  segment: string;
  description: string;
  count: number;
  priority: 'high' | 'medium' | 'low';
  action: string;
  clients: ActionableClient[];
}

interface DailyMetrics {
  date: string;
  summary: {
    totalSalesUSD: number;
    totalSalesMXN: number;
    transactionCount: number;
    newSubscriptions: number;
    newTrials: number;
    conversions: number;
    cancellations: number;
    failedPayments: number;
    churnRisk: number;
  };
  segments: ActionableSegment[];
  priorityActions?: Array<{ action: string; segment: string; impact: string }>;
}

interface AIInsight {
  id: string;
  date: string;
  summary: string;
  opportunities: Array<{ title: string; description: string; action?: string }>;
  risks: Array<{ title: string; description: string; prevention?: string }>;
  metrics: DailyMetrics;
  created_at: string;
}

const segmentIcons: Record<string, React.ElementType> = {
  pagos_fallidos: CreditCard,
  cancelaciones: UserX,
  nuevos_trials: Clock,
  conversiones_nuevas: Zap,
  registros_nuevos: UserPlus,
  riesgo_churn: AlertTriangle,
  clientes_vip: Crown,
};

const priorityColors: Record<string, string> = {
  high: 'bg-red-500/20 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

function downloadCSV(segment: ActionableSegment) {
  const headers = ['Email', 'Nombre', 'Monto', 'Fecha', 'Razón'];
  const rows = segment.clients.map(c => [
    c.email,
    c.name,
    c.amount?.toString() || '',
    c.date || '',
    c.reason || '',
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${segment.segment}_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  
  toast.success(`Descargado: ${segment.count} clientes`);
}

function SegmentCard({ segment }: { segment: ActionableSegment }) {
  const Icon = segmentIcons[segment.segment] || Users;
  
  return (
    <div className="p-3 sm:p-4 rounded-lg bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between mb-2 sm:mb-3">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
            <Icon className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
              <span className="font-semibold text-white capitalize text-xs sm:text-sm truncate">
                {segment.segment.replace(/_/g, ' ')}
              </span>
              <Badge className={`${priorityColors[segment.priority]} text-[10px] sm:text-xs`}>
                {segment.priority === 'high' ? 'Urgente' : segment.priority === 'medium' ? 'Import' : 'Normal'}
              </Badge>
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{segment.description}</p>
          </div>
        </div>
        <div className="text-right shrink-0 ml-2">
          <span className="text-lg sm:text-2xl font-bold text-white">{segment.count}</span>
          <p className="text-[10px] sm:text-xs text-muted-foreground">clientes</p>
        </div>
      </div>

      <p className="text-xs sm:text-sm text-primary mb-2 sm:mb-3">
        💡 {segment.action}
      </p>

      {segment.clients.length > 0 && (
        <>
          <div className="space-y-1 mb-2 sm:mb-3 max-h-24 sm:max-h-32 overflow-y-auto">
            {segment.clients.slice(0, 5).map((client, idx) => (
              <div key={idx} className="flex items-center justify-between text-[10px] sm:text-xs py-0.5 sm:py-1 px-1.5 sm:px-2 rounded bg-background/30">
                <div className="flex items-center gap-1.5 sm:gap-2 truncate min-w-0">
                  <span className="text-muted-foreground">{idx + 1}.</span>
                  <span className="text-foreground truncate">{client.email}</span>
                </div>
                {client.amount !== undefined && (
                  <span className="text-emerald-400 font-medium shrink-0 ml-1">${client.amount.toFixed(0)}</span>
                )}
              </div>
            ))}
            {segment.clients.length > 5 && (
              <p className="text-[10px] sm:text-xs text-muted-foreground text-center py-0.5 sm:py-1">
                +{segment.clients.length - 5} más...
              </p>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 sm:h-8 text-xs sm:text-sm"
            onClick={() => downloadCSV(segment)}
          >
            <Download className="h-3 w-3 sm:h-4 sm:w-4 mr-1.5 sm:mr-2" />
            Descargar CSV
          </Button>
        </>
      )}
    </div>
  );
}

export function AIInsightsWidget() {
  const { data: insight, isLoading, error } = useQuery({
    queryKey: ["ai-insights-latest"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_insights")
        .select("*")
        .order("date", { ascending: false })
        .limit(1)
        .single();

      if (error) throw error;
      return data as unknown as AIInsight;
    },
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/50 bg-gradient-to-br from-[#1a1f36] to-[#0f1225] p-4 sm:p-6">
        <div className="flex items-center justify-center py-6 sm:py-8">
          <Loader2 className="h-5 w-5 sm:h-6 sm:w-6 animate-spin text-primary" />
          <span className="ml-2 text-xs sm:text-sm text-muted-foreground">Cargando insights...</span>
        </div>
      </div>
    );
  }

  if (error || !insight) {
    return (
      <div className="rounded-xl border border-border/50 bg-gradient-to-br from-[#1a1f36] to-[#0f1225] p-4 sm:p-6">
        <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
          <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
            <Sparkles className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm sm:text-lg font-semibold text-white">Centro de Comando IA</h3>
            <p className="text-[10px] sm:text-sm text-muted-foreground">Tu análisis diario</p>
          </div>
        </div>
        <div className="text-center py-4 sm:py-6 text-muted-foreground">
          <p className="text-xs sm:text-sm">No hay análisis disponible aún.</p>
          <p className="text-[10px] sm:text-sm mt-1">Ejecuta el análisis desde Analytics.</p>
        </div>
      </div>
    );
  }

  const opportunities = Array.isArray(insight.opportunities) ? insight.opportunities : [];
  const risks = Array.isArray(insight.risks) ? insight.risks : [];
  const metrics = insight.metrics as DailyMetrics;
  const segments = metrics?.segments || [];
  const priorityActions = metrics?.priorityActions || [];

  // Sort segments by priority
  const sortedSegments = [...segments].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  return (
    <div className="rounded-xl border border-border/50 bg-gradient-to-br from-[#1a1f36] via-[#1a1f36] to-primary/5 p-4 sm:p-6 relative overflow-hidden">
      {/* Glow effect */}
      <div className="absolute top-0 right-0 w-24 h-24 sm:w-32 sm:h-32 bg-primary/10 rounded-full blur-3xl" />
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 mb-4 sm:mb-6 relative">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 shrink-0">
            <Sparkles className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
          </div>
          <div>
            <h3 className="text-base sm:text-xl font-bold text-white">Centro de Comando IA</h3>
            <p className="text-[10px] sm:text-sm text-muted-foreground">
              Análisis del {format(new Date(insight.date), "d 'de' MMMM", { locale: es })}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      {metrics?.summary && (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-4 sm:mb-6 md:grid-cols-4">
          <div className="p-2 sm:p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-center">
            <p className="text-lg sm:text-2xl font-bold text-emerald-400">{metrics.summary.conversions}</p>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Conversiones</p>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center">
            <p className="text-lg sm:text-2xl font-bold text-blue-400">{metrics.summary.newTrials}</p>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Nuevos Trials</p>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-center">
            <p className="text-lg sm:text-2xl font-bold text-amber-400">{metrics.summary.failedPayments}</p>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Pagos Fallidos</p>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
            <p className="text-lg sm:text-2xl font-bold text-red-400">{metrics.summary.cancellations}</p>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Cancelaciones</p>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="mb-4 sm:mb-6 p-3 sm:p-4 rounded-lg bg-background/50 border border-border/30">
        <p className="text-xs sm:text-sm text-foreground leading-relaxed">{insight.summary}</p>
      </div>

      {/* Priority Actions */}
      {priorityActions.length > 0 && (
        <div className="mb-4 sm:mb-6 p-3 sm:p-4 rounded-lg bg-primary/5 border border-primary/20">
          <h4 className="font-semibold text-white mb-2 sm:mb-3 flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
            <Zap className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary" />
            Acciones Prioritarias
          </h4>
          <div className="space-y-1.5 sm:space-y-2">
            {priorityActions.map((action, idx) => (
              <div key={idx} className="flex items-start gap-1.5 sm:gap-2 text-xs sm:text-sm">
                <span className="text-primary font-bold">{idx + 1}.</span>
                <span className="text-foreground">{action.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Tabs defaultValue="segments" className="w-full">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="grid w-max sm:w-full grid-cols-3 mb-3 sm:mb-4">
            <TabsTrigger value="segments" className="text-xs sm:text-sm px-2 sm:px-3">Segmentos</TabsTrigger>
            <TabsTrigger value="opportunities" className="text-xs sm:text-sm px-2 sm:px-3">Oportun.</TabsTrigger>
            <TabsTrigger value="risks" className="text-xs sm:text-sm px-2 sm:px-3">Riesgos</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="segments" className="space-y-3 sm:space-y-4">
          {sortedSegments.length > 0 ? (
            <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
              {sortedSegments.map((segment, idx) => (
                <SegmentCard key={idx} segment={segment} />
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-3 sm:py-4 text-xs sm:text-sm">
              Ejecuta el análisis para ver segmentos
            </p>
          )}
        </TabsContent>

        <TabsContent value="opportunities" className="space-y-2 sm:space-y-3">
          <div className="flex items-center gap-1.5 sm:gap-2 text-emerald-400 mb-1.5 sm:mb-2">
            <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span className="text-[10px] sm:text-sm font-semibold uppercase tracking-wider">Oportunidades</span>
          </div>
          {opportunities.length > 0 ? (
            opportunities.map((opp, idx) => (
              <div key={idx} className="p-3 sm:p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                <p className="font-medium text-emerald-300 text-xs sm:text-sm">{opp.title}</p>
                <p className="text-[10px] sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">{opp.description}</p>
                {opp.action && (
                  <p className="text-[10px] sm:text-sm text-emerald-400 mt-1.5 sm:mt-2">→ {opp.action}</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-xs sm:text-sm text-muted-foreground">Sin oportunidades detectadas</p>
          )}
        </TabsContent>

        <TabsContent value="risks" className="space-y-2 sm:space-y-3">
          <div className="flex items-center gap-1.5 sm:gap-2 text-amber-400 mb-1.5 sm:mb-2">
            <AlertTriangle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span className="text-[10px] sm:text-sm font-semibold uppercase tracking-wider">Riesgos</span>
          </div>
          {risks.length > 0 ? (
            risks.map((risk, idx) => (
              <div key={idx} className="p-3 sm:p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <p className="font-medium text-amber-300 text-xs sm:text-sm">{risk.title}</p>
                <p className="text-[10px] sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">{risk.description}</p>
                {risk.prevention && (
                  <p className="text-[10px] sm:text-sm text-amber-400 mt-1.5 sm:mt-2">→ {risk.prevention}</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-xs sm:text-sm text-muted-foreground">Sin riesgos detectados</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

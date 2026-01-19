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
    <div className="p-4 rounded-lg bg-background/50 border border-border/30 hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white capitalize">
                {segment.segment.replace(/_/g, ' ')}
              </span>
              <Badge className={priorityColors[segment.priority]}>
                {segment.priority === 'high' ? 'Urgente' : segment.priority === 'medium' ? 'Importante' : 'Normal'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{segment.description}</p>
          </div>
        </div>
        <div className="text-right">
          <span className="text-2xl font-bold text-white">{segment.count}</span>
          <p className="text-xs text-muted-foreground">clientes</p>
        </div>
      </div>

      <p className="text-sm text-primary mb-3">
        💡 {segment.action}
      </p>

      {segment.clients.length > 0 && (
        <>
          <div className="space-y-1 mb-3 max-h-32 overflow-y-auto">
            {segment.clients.slice(0, 5).map((client, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background/30">
                <div className="flex items-center gap-2 truncate">
                  <span className="text-muted-foreground">{idx + 1}.</span>
                  <span className="text-foreground truncate">{client.email}</span>
                </div>
                {client.amount !== undefined && (
                  <span className="text-emerald-400 font-medium">${client.amount.toFixed(2)}</span>
                )}
              </div>
            ))}
            {segment.clients.length > 5 && (
              <p className="text-xs text-muted-foreground text-center py-1">
                +{segment.clients.length - 5} más...
              </p>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => downloadCSV(segment)}
          >
            <Download className="h-4 w-4 mr-2" />
            Descargar Lista CSV
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
      <div className="rounded-xl border border-border/50 bg-gradient-to-br from-[#1a1f36] to-[#0f1225] p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="ml-2 text-muted-foreground">Cargando insights...</span>
        </div>
      </div>
    );
  }

  if (error || !insight) {
    return (
      <div className="rounded-xl border border-border/50 bg-gradient-to-br from-[#1a1f36] to-[#0f1225] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Centro de Comando IA</h3>
            <p className="text-sm text-muted-foreground">Tu análisis diario accionable</p>
          </div>
        </div>
        <div className="text-center py-6 text-muted-foreground">
          <p>No hay análisis disponible aún.</p>
          <p className="text-sm mt-1">Ejecuta el análisis desde la pestaña Analytics.</p>
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
    <div className="rounded-xl border border-border/50 bg-gradient-to-br from-[#1a1f36] via-[#1a1f36] to-primary/5 p-6 relative overflow-hidden">
      {/* Glow effect */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-3xl" />
      
      {/* Header */}
      <div className="flex items-center justify-between mb-6 relative">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-white">Centro de Comando IA</h3>
            <p className="text-sm text-muted-foreground">
              Análisis del {format(new Date(insight.date), "d 'de' MMMM, yyyy", { locale: es })}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      {metrics?.summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-center">
            <p className="text-2xl font-bold text-emerald-400">{metrics.summary.conversions}</p>
            <p className="text-xs text-muted-foreground">Conversiones</p>
          </div>
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center">
            <p className="text-2xl font-bold text-blue-400">{metrics.summary.newTrials}</p>
            <p className="text-xs text-muted-foreground">Nuevos Trials</p>
          </div>
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-center">
            <p className="text-2xl font-bold text-amber-400">{metrics.summary.failedPayments}</p>
            <p className="text-xs text-muted-foreground">Pagos Fallidos</p>
          </div>
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
            <p className="text-2xl font-bold text-red-400">{metrics.summary.cancellations}</p>
            <p className="text-xs text-muted-foreground">Cancelaciones</p>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="mb-6 p-4 rounded-lg bg-background/50 border border-border/30">
        <p className="text-foreground leading-relaxed">{insight.summary}</p>
      </div>

      {/* Priority Actions */}
      {priorityActions.length > 0 && (
        <div className="mb-6 p-4 rounded-lg bg-primary/5 border border-primary/20">
          <h4 className="font-semibold text-white mb-3 flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Acciones Prioritarias para Hoy
          </h4>
          <div className="space-y-2">
            {priorityActions.map((action, idx) => (
              <div key={idx} className="flex items-start gap-2 text-sm">
                <span className="text-primary font-bold">{idx + 1}.</span>
                <span className="text-foreground">{action.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Tabs defaultValue="segments" className="w-full">
        <TabsList className="grid w-full grid-cols-3 mb-4">
          <TabsTrigger value="segments">Segmentos</TabsTrigger>
          <TabsTrigger value="opportunities">Oportunidades</TabsTrigger>
          <TabsTrigger value="risks">Riesgos</TabsTrigger>
        </TabsList>

        <TabsContent value="segments" className="space-y-4">
          {sortedSegments.length > 0 ? (
            <div className="grid md:grid-cols-2 gap-4">
              {sortedSegments.map((segment, idx) => (
                <SegmentCard key={idx} segment={segment} />
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-4">
              Ejecuta el análisis para ver los segmentos accionables
            </p>
          )}
        </TabsContent>

        <TabsContent value="opportunities" className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-400 mb-2">
            <TrendingUp className="h-4 w-4" />
            <span className="text-sm font-semibold uppercase tracking-wider">Oportunidades de Crecimiento</span>
          </div>
          {opportunities.length > 0 ? (
            opportunities.map((opp, idx) => (
              <div key={idx} className="p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                <p className="font-medium text-emerald-300">{opp.title}</p>
                <p className="text-sm text-muted-foreground mt-1">{opp.description}</p>
                {opp.action && (
                  <p className="text-sm text-emerald-400 mt-2">→ {opp.action}</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Sin oportunidades detectadas</p>
          )}
        </TabsContent>

        <TabsContent value="risks" className="space-y-3">
          <div className="flex items-center gap-2 text-amber-400 mb-2">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm font-semibold uppercase tracking-wider">Riesgos a Mitigar</span>
          </div>
          {risks.length > 0 ? (
            risks.map((risk, idx) => (
              <div key={idx} className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <p className="font-medium text-amber-300">{risk.title}</p>
                <p className="text-sm text-muted-foreground mt-1">{risk.description}</p>
                {risk.prevention && (
                  <p className="text-sm text-amber-400 mt-2">→ {risk.prevention}</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Sin riesgos detectados</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

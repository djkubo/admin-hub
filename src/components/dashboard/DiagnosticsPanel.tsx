import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { 
  Shield, 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  RefreshCw, 
  Play,
  FileText,
  Database,
  Loader2,
  ArrowRightLeft,
  Brain,
  BarChart3,
  Calendar
} from "lucide-react";
import { format, subDays } from "date-fns";

interface DataQualityCheck {
  check_name: string;
  status: string;
  count: number;
  percentage: number;
  details: any;
}

interface ReconciliationRun {
  id: string;
  source: string;
  period_start: string;
  period_end: string;
  external_total: number;
  internal_total: number;
  difference: number;
  difference_pct: number;
  status: string;
  created_at: string;
}

interface RebuildLog {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  rows_processed: number;
  diff: any;
  promoted: boolean;
}

interface SyncRun {
  id: string;
  source: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_fetched: number | null;
  total_inserted: number | null;
  total_skipped: number | null;
  error_message: string | null;
}

const CHECK_LABELS: Record<string, string> = {
  'payments_without_email': 'Sin Email',
  'clients_without_phone': 'Sin Tel',
  'duplicate_phones': 'Duplicados',
  'non_normalized_emails': 'Emails mal',
  'mixed_currencies': 'Monedas',
  'clients_without_source': 'Sin Fuente',
};

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'ok':
    case 'completed':
      return <Badge className="bg-green-500/20 text-green-400 text-[10px] md:text-xs"><CheckCircle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> OK</Badge>;
    case 'running':
      return <Badge className="bg-blue-500/20 text-blue-400 text-[10px] md:text-xs"><Loader2 className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1 animate-spin" /> ...</Badge>;
    case 'warning':
      return <Badge className="bg-yellow-500/20 text-yellow-400 text-[10px] md:text-xs"><AlertTriangle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> Warn</Badge>;
    case 'critical':
    case 'fail':
    case 'error':
      return <Badge className="bg-red-500/20 text-red-400 text-[10px] md:text-xs"><XCircle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> Error</Badge>;
    case 'info':
      return <Badge variant="outline" className="text-[10px] md:text-xs">Info</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px] md:text-xs">{status}</Badge>;
  }
};

// Sync Health Panel Component
function SyncHealthPanel() {
  const { data: syncRuns = [], isLoading } = useQuery({
    queryKey: ['sync-runs-health'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as SyncRun[];
    },
    refetchInterval: 30000
  });

  const { data: webhookStats = [] } = useQuery({
    queryKey: ['webhook-stats'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('webhook_events')
        .select('source, event_type')
        .order('processed_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      
      const stats = new Map<string, { count: number; types: Set<string> }>();
      for (const e of data || []) {
        const existing = stats.get(e.source) || { count: 0, types: new Set() };
        existing.count++;
        existing.types.add(e.event_type);
        stats.set(e.source, existing);
      }
      return Array.from(stats.entries()).map(([source, data]) => ({
        source,
        count: data.count,
        types: Array.from(data.types).slice(0, 3)
      }));
    }
  });

  const syncBySource = syncRuns.reduce((acc, run) => {
    if (!acc[run.source]) acc[run.source] = [];
    acc[run.source].push(run);
    return acc;
  }, {} as Record<string, SyncRun[]>);

  if (isLoading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <Card>
      <CardHeader className="p-4 md:p-6">
        <CardTitle className="text-base md:text-lg">Sync Health</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Historial de sincronizaciones y webhooks
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-4 md:space-y-6">
        {/* Last Sync by Source - Cards */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          {['stripe', 'paypal', 'csv'].map(source => {
            const runs = syncBySource[source] || [];
            const lastRun = runs[0];
            const last7dRuns = runs.filter(r => new Date(r.started_at) > subDays(new Date(), 7));
            const totalInserted = last7dRuns.reduce((sum, r) => sum + (r.total_inserted || 0), 0);
            
            return (
              <div key={source} className="p-3 rounded-lg border border-border/50 bg-muted/30 touch-feedback">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm capitalize">{source}</span>
                  {lastRun ? getStatusBadge(lastRun.status) : <Badge variant="outline" className="text-[10px]">N/A</Badge>}
                </div>
                {lastRun ? (
                  <>
                    <p className="text-[10px] md:text-xs text-muted-foreground">
                      {format(new Date(lastRun.started_at), 'dd/MM HH:mm')}
                    </p>
                    <p className="text-xs md:text-sm text-foreground">
                      {lastRun.total_inserted || 0} ins • {lastRun.total_skipped || 0} skip
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      7d: {last7dRuns.length} syncs
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Sin datos</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Webhook Stats */}
        {webhookStats.length > 0 && (
          <div className="p-3 rounded-lg border border-border/50 bg-muted/30">
            <h4 className="font-medium text-sm mb-2">Webhooks (últimos 100)</h4>
            <div className="flex gap-3 flex-wrap">
              {webhookStats.map(stat => (
                <div key={stat.source} className="text-xs">
                  <span className="font-medium capitalize">{stat.source}:</span>{' '}
                  <span className="text-muted-foreground">{stat.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Sync Runs - Mobile Cards */}
        <div className="space-y-2 md:hidden">
          <h4 className="font-medium text-sm">Últimos syncs</h4>
          {syncRuns.slice(0, 10).map(run => (
            <div key={run.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border/30 bg-muted/20">
              <div className="flex items-center gap-2">
                <span className="font-medium text-xs capitalize w-14">{run.source}</span>
                <span className="text-[10px] text-muted-foreground">
                  {format(new Date(run.started_at), 'dd/MM HH:mm')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">{run.total_inserted || 0}</span>
                {getStatusBadge(run.status)}
              </div>
            </div>
          ))}
        </div>

        {/* Desktop Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 font-medium text-muted-foreground">Fuente</th>
                <th className="text-left py-2 font-medium text-muted-foreground">Fecha</th>
                <th className="text-left py-2 font-medium text-muted-foreground">Estado</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Fetched</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Inserted</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {syncRuns.slice(0, 15).map(run => (
                <tr key={run.id} className="border-b border-border/50">
                  <td className="py-2 font-medium capitalize">{run.source}</td>
                  <td className="py-2 text-muted-foreground">
                    {format(new Date(run.started_at), 'dd/MM HH:mm')}
                  </td>
                  <td className="py-2">{getStatusBadge(run.status)}</td>
                  <td className="py-2 text-right">{run.total_fetched || 0}</td>
                  <td className="py-2 text-right">{run.total_inserted || 0}</td>
                  <td className="py-2 text-right">{run.total_skipped || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DiagnosticsPanel() {
  const queryClient = useQueryClient();
  const [reconcileSource, setReconcileSource] = useState<string>('stripe');
  const [reconcileRange, setReconcileRange] = useState<string>('7d');
  const [isReconciling, setIsReconciling] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const { data: qualityChecks = [], isLoading: loadingChecks, refetch: refetchChecks } = useQuery({
    queryKey: ['data-quality-checks'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('data_quality_checks');
      if (error) throw error;
      return data as DataQualityCheck[];
    }
  });

  const { data: reconciliationRuns = [], isLoading: loadingReconciliation } = useQuery({
    queryKey: ['reconciliation-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reconciliation_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as ReconciliationRun[];
    }
  });

  const { data: rebuildLogs = [], isLoading: loadingRebuilds } = useQuery({
    queryKey: ['rebuild-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rebuild_logs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data as RebuildLog[];
    }
  });

  const hasCriticalIssues = qualityChecks.some(c => c.status === 'critical');
  const hasWarnings = qualityChecks.some(c => c.status === 'warning');

  const runReconciliation = async () => {
    setIsReconciling(true);
    try {
      const endDate = new Date();
      let startDate: Date;
      
      switch (reconcileRange) {
        case 'today':
          startDate = new Date();
          break;
        case '7d':
          startDate = subDays(new Date(), 7);
          break;
        case '30d':
          startDate = subDays(new Date(), 30);
          break;
        default:
          startDate = subDays(new Date(), 7);
      }

      const data = await invokeWithAdminKey('reconcile-metrics', {
        source: reconcileSource,
        start_date: format(startDate, 'yyyy-MM-dd'),
        end_date: format(endDate, 'yyyy-MM-dd')
      });

      queryClient.invalidateQueries({ queryKey: ['reconciliation-runs'] });
      
      if (data.status === 'ok') {
        toast.success(`OK: diferencia ${data.difference_pct}%`);
      } else if (data.status === 'warning') {
        toast.warning(`Warning: $${(data.difference / 100).toFixed(2)}`);
      } else {
        toast.error(`Fail: $${(data.difference / 100).toFixed(2)}`);
      }
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    } finally {
      setIsReconciling(false);
    }
  };

  const rebuildMetrics = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('rebuild_metrics_staging');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rebuild-logs'] });
      toast.success('Métricas en staging');
    },
    onError: (error: any) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  const promoteStaging = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('promote_metrics_staging');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rebuild-logs'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      toast.success('Staging promovido');
    },
    onError: (error: any) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  const runAIAudit = async () => {
    setIsAnalyzing(true);
    try {
      const [salesData, qualityData] = await Promise.all([
        supabase.rpc('kpi_sales', { p_range: '30d' }),
        supabase.rpc('data_quality_checks')
      ]);

      const prompt = `Analiza estos datos de métricas y calidad de datos de un SaaS:

MÉTRICAS DE VENTAS (30 días):
${JSON.stringify(salesData.data, null, 2)}

CHECKS DE CALIDAD:
${JSON.stringify(qualityData.data, null, 2)}

Por favor:
1. Detecta anomalías o patrones sospechosos
2. Sugiere posibles causas de problemas
3. Recomienda acciones correctivas
4. NO recalcules números, solo diagnostica

Responde en español, de forma concisa.`;

      const data = await invokeWithAdminKey('analyze-business', { prompt, context: 'diagnostics' });
      setAiAnalysis(data.analysis || data.message || 'No se pudo generar análisis');
    } catch (error: any) {
      toast.error(`Error AI: ${error.message}`);
      setAiAnalysis(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground flex items-center gap-2">
            <Shield className="w-5 h-5 md:w-6 md:h-6 text-primary" />
            Diagnostics
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-0.5">
            Reconciliación y calidad de datos
          </p>
        </div>
        <Button 
          onClick={async () => {
            await refetchChecks();
            toast.success("Actualizado");
          }} 
          variant="outline" 
          size="sm"
          disabled={loadingChecks}
          className="self-start sm:self-auto touch-feedback"
        >
          <RefreshCw className={`w-4 h-4 ${loadingChecks ? 'animate-spin' : ''}`} />
          <span className="ml-2 hidden sm:inline">Actualizar</span>
        </Button>
      </div>

      {/* Critical Alert Banner */}
      {hasCriticalIssues && (
        <Alert variant="destructive" className="py-3">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="text-sm">Problemas detectados</AlertTitle>
          <AlertDescription className="text-xs">
            Las métricas pueden no ser precisas.
          </AlertDescription>
        </Alert>
      )}

      {/* Summary Cards - 2x2 on mobile */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card className={hasCriticalIssues ? 'border-red-500/50' : hasWarnings ? 'border-yellow-500/50' : 'border-green-500/50'}>
          <CardContent className="p-3 md:pt-4 md:p-4">
            <div className="flex items-center gap-1.5 md:gap-2 mb-1.5 md:mb-2">
              <Database className="w-4 h-4 md:w-5 md:h-5" />
              <span className="font-medium text-xs md:text-sm">Data</span>
            </div>
            <div className="flex items-center gap-1.5">
              {hasCriticalIssues ? (
                <Badge className="bg-red-500/20 text-red-400 text-[10px] md:text-xs">Crítico</Badge>
              ) : hasWarnings ? (
                <Badge className="bg-yellow-500/20 text-yellow-400 text-[10px] md:text-xs">Warn</Badge>
              ) : (
                <Badge className="bg-green-500/20 text-green-400 text-[10px] md:text-xs">OK</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3 md:pt-4 md:p-4">
            <div className="flex items-center gap-1.5 md:gap-2 mb-1.5 md:mb-2">
              <ArrowRightLeft className="w-4 h-4 md:w-5 md:h-5" />
              <span className="font-medium text-xs md:text-sm">Recon</span>
            </div>
            {reconciliationRuns[0] ? (
              <div className="flex flex-col gap-1">
                {getStatusBadge(reconciliationRuns[0].status)}
                <span className="text-[10px] text-muted-foreground">
                  {format(new Date(reconciliationRuns[0].created_at), 'dd/MM')}
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">N/A</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3 md:pt-4 md:p-4">
            <div className="flex items-center gap-1.5 md:gap-2 mb-1.5 md:mb-2">
              <BarChart3 className="w-4 h-4 md:w-5 md:h-5" />
              <span className="font-medium text-xs md:text-sm">Rebuild</span>
            </div>
            {rebuildLogs[0] ? (
              <div className="flex flex-col gap-1">
                {getStatusBadge(rebuildLogs[0].status)}
                <span className="text-[10px] text-muted-foreground">
                  {rebuildLogs[0].rows_processed} filas
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">N/A</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3 md:pt-4 md:p-4">
            <div className="flex items-center gap-1.5 md:gap-2 mb-1.5 md:mb-2">
              <Calendar className="w-4 h-4 md:w-5 md:h-5" />
              <span className="font-medium text-xs md:text-sm">TZ</span>
            </div>
            <Badge variant="outline" className="text-[10px] md:text-xs">MX City</Badge>
          </CardContent>
        </Card>
      </div>

      {/* Tabs - Scrollable on mobile */}
      <Tabs defaultValue="sync-health" className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <TabsList className="inline-flex min-w-max md:min-w-0">
            <TabsTrigger value="sync-health" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <RefreshCw className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Sync</span>
            </TabsTrigger>
            <TabsTrigger value="quality" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <Database className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Quality</span>
            </TabsTrigger>
            <TabsTrigger value="reconciliation" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <ArrowRightLeft className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Recon</span>
            </TabsTrigger>
            <TabsTrigger value="rebuild" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <BarChart3 className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Rebuild</span>
            </TabsTrigger>
            <TabsTrigger value="ai-audit" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <Brain className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">AI</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Sync Health Tab */}
        <TabsContent value="sync-health">
          <SyncHealthPanel />
        </TabsContent>

        {/* Data Quality Tab */}
        <TabsContent value="quality">
          <Card>
            <CardHeader className="p-4 md:p-6">
              <CardTitle className="text-base md:text-lg">Calidad de Datos</CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Integridad y consistencia
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0">
              {loadingChecks ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : (
                <div className="space-y-2">
                  {qualityChecks.map((check) => (
                    <div key={check.check_name} className="flex items-center justify-between p-2.5 rounded-lg border border-border/30 bg-muted/20">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-xs md:text-sm">
                          {CHECK_LABELS[check.check_name] || check.check_name}
                        </span>
                        {getStatusBadge(check.status)}
                      </div>
                      <div className="flex items-center gap-2 md:gap-4 text-right">
                        <span className="text-xs md:text-sm font-medium">{check.count}</span>
                        <span className="text-[10px] md:text-xs text-muted-foreground w-10 md:w-12">
                          {check.percentage > 0 ? `${check.percentage}%` : '-'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reconciliation Tab */}
        <TabsContent value="reconciliation">
          <Card>
            <CardHeader className="p-4 md:p-6">
              <CardTitle className="text-base md:text-lg">Reconciliación</CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Compara con Stripe/PayPal
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-4">
              {/* Controls - Stack on mobile */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 p-3 md:p-4 rounded-lg bg-muted/50">
                <div className="flex gap-2">
                  <Select value={reconcileSource} onValueChange={setReconcileSource}>
                    <SelectTrigger className="w-24 md:w-32 text-xs md:text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stripe">Stripe</SelectItem>
                      <SelectItem value="paypal">PayPal</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={reconcileRange} onValueChange={setReconcileRange}>
                    <SelectTrigger className="w-20 md:w-32 text-xs md:text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="today">Hoy</SelectItem>
                      <SelectItem value="7d">7d</SelectItem>
                      <SelectItem value="30d">30d</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button onClick={runReconciliation} disabled={isReconciling} size="sm" className="touch-feedback">
                  {isReconciling ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  <span className="ml-2">Ejecutar</span>
                </Button>
              </div>

              {loadingReconciliation ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : reconciliationRuns.length === 0 ? (
                <p className="text-center text-muted-foreground py-8 text-sm">
                  Sin reconciliaciones
                </p>
              ) : (
                <div className="space-y-2">
                  {reconciliationRuns.slice(0, 10).map((run) => (
                    <div key={run.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-2.5 rounded-lg border border-border/30 bg-muted/20 gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-xs capitalize w-12">{run.source}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {format(new Date(run.period_start), 'dd/MM')} - {format(new Date(run.period_end), 'dd/MM')}
                        </span>
                        {getStatusBadge(run.status)}
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-muted-foreground">Ext: ${(run.external_total / 100).toLocaleString()}</span>
                        <span className="text-muted-foreground">Int: ${(run.internal_total / 100).toLocaleString()}</span>
                        <span className={run.difference !== 0 ? 'text-yellow-400 font-medium' : ''}>
                          Δ ${(run.difference / 100).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Rebuild Tab */}
        <TabsContent value="rebuild">
          <Card>
            <CardHeader className="p-4 md:p-6">
              <CardTitle className="text-base md:text-lg">Rebuild Metrics</CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Recalcula métricas determinísticas
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 p-3 md:p-4 rounded-lg bg-muted/50">
                <Button 
                  onClick={() => rebuildMetrics.mutate()} 
                  disabled={rebuildMetrics.isPending}
                  size="sm"
                  className="touch-feedback"
                >
                  {rebuildMetrics.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  <span className="ml-2">Rebuild</span>
                </Button>

                <Button 
                  onClick={() => promoteStaging.mutate()} 
                  disabled={promoteStaging.isPending}
                  variant="secondary"
                  size="sm"
                  className="touch-feedback"
                >
                  {promoteStaging.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  <span className="ml-2">Promote</span>
                </Button>
              </div>

              <div className="p-3 rounded-lg border border-border/50 bg-muted/30">
                <h4 className="font-medium text-sm mb-2">📋 Proceso</h4>
                <ol className="list-decimal list-inside text-xs text-muted-foreground space-y-1">
                  <li>Click "Rebuild" → staging</li>
                  <li>Revisa el diff</li>
                  <li>Click "Promote" → current</li>
                </ol>
              </div>

              {loadingRebuilds ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : rebuildLogs.length === 0 ? (
                <p className="text-center text-muted-foreground py-8 text-sm">
                  Sin rebuilds
                </p>
              ) : (
                <div className="space-y-2">
                  {rebuildLogs.map((log) => (
                    <div key={log.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border/30 bg-muted/20">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(log.started_at), 'dd/MM HH:mm')}
                        </span>
                        {getStatusBadge(log.status)}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs">{log.rows_processed} filas</span>
                        {log.promoted ? (
                          <Badge className="bg-green-500/20 text-green-400 text-[10px]">✓</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">—</Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Audit Tab */}
        <TabsContent value="ai-audit">
          <Card>
            <CardHeader className="p-4 md:p-6">
              <CardTitle className="flex items-center gap-2 text-base md:text-lg">
                <Brain className="w-4 h-4 md:w-5 md:h-5" />
                AI Audit
              </CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Diagnóstico inteligente (no calcula)
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-4">
              <Button onClick={runAIAudit} disabled={isAnalyzing} size="sm" className="touch-feedback">
                {isAnalyzing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Brain className="w-4 h-4" />
                )}
                <span className="ml-2">Ejecutar AI</span>
              </Button>

              {aiAnalysis && (
                <div className="p-3 md:p-4 rounded-lg border border-primary/20 bg-primary/5">
                  <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                    <Brain className="w-4 h-4" />
                    Análisis
                  </h4>
                  <pre className="whitespace-pre-wrap text-xs text-muted-foreground overflow-x-auto">
                    {aiAnalysis}
                  </pre>
                </div>
              )}

              <Alert className="py-2">
                <AlertTriangle className="h-3.5 w-3.5" />
                <AlertTitle className="text-xs">Nota</AlertTitle>
                <AlertDescription className="text-[10px] md:text-xs">
                  La IA diagnostica. KPIs = SQL determinístico.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Documentation Link */}
      <Card className="bg-muted/30">
        <CardContent className="p-3 md:pt-4 md:p-4">
          <div className="flex items-center gap-2 md:gap-3">
            <FileText className="w-4 h-4 md:w-5 md:h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <h4 className="font-medium text-sm">Docs</h4>
              <p className="text-[10px] md:text-xs text-muted-foreground truncate">
                /docs/metrics_definition.md
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

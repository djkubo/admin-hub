import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  'payments_without_email': 'Pagos sin Email',
  'clients_without_phone': 'Clientes sin Teléfono',
  'duplicate_phones': 'Teléfonos Duplicados',
  'non_normalized_emails': 'Emails No Normalizados',
  'mixed_currencies': 'Monedas Mezcladas',
  'clients_without_source': 'Clientes sin Fuente',
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

  // Group sync runs by source
  const syncBySource = syncRuns.reduce((acc, run) => {
    if (!acc[run.source]) acc[run.source] = [];
    acc[run.source].push(run);
    return acc;
  }, {} as Record<string, SyncRun[]>);

  const getStatusBadge = (status: string) => {
    if (status === 'completed') return <Badge className="bg-green-500/20 text-green-400"><CheckCircle className="w-3 h-3 mr-1" /> OK</Badge>;
    if (status === 'running') return <Badge className="bg-blue-500/20 text-blue-400"><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Running</Badge>;
    return <Badge className="bg-red-500/20 text-red-400"><XCircle className="w-3 h-3 mr-1" /> Error</Badge>;
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync Health Monitor</CardTitle>
        <CardDescription>
          Historial de sincronizaciones, webhooks procesados y estado de dedupe
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Last Sync by Source */}
        <div className="grid gap-4 md:grid-cols-3">
          {['stripe', 'paypal', 'csv'].map(source => {
            const runs = syncBySource[source] || [];
            const lastRun = runs[0];
            const last7dRuns = runs.filter(r => new Date(r.started_at) > subDays(new Date(), 7));
            const totalInserted = last7dRuns.reduce((sum, r) => sum + (r.total_inserted || 0), 0);
            
            return (
              <div key={source} className="p-4 rounded-lg border border-border/50 bg-muted/30">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium capitalize">{source}</span>
                  {lastRun ? getStatusBadge(lastRun.status) : <Badge variant="outline">Sin datos</Badge>}
                </div>
                {lastRun ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Último: {format(new Date(lastRun.started_at), 'dd/MM HH:mm')}
                    </p>
                    <p className="text-sm text-foreground">
                      {lastRun.total_inserted || 0} insertados, {lastRun.total_skipped || 0} omitidos
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      7d: {last7dRuns.length} syncs, {totalInserted} filas
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No hay sincronizaciones</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Webhook Stats */}
        {webhookStats.length > 0 && (
          <div className="p-4 rounded-lg border border-border/50 bg-muted/30">
            <h4 className="font-medium mb-2">Webhooks Procesados (últimos 100)</h4>
            <div className="flex gap-4 flex-wrap">
              {webhookStats.map(stat => (
                <div key={stat.source} className="text-sm">
                  <span className="font-medium capitalize">{stat.source}:</span>{' '}
                  <span className="text-muted-foreground">{stat.count} eventos</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Sync Runs Table */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fuente</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Fetched</TableHead>
              <TableHead className="text-right">Inserted</TableHead>
              <TableHead className="text-right">Skipped</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {syncRuns.slice(0, 15).map(run => (
              <TableRow key={run.id}>
                <TableCell className="font-medium capitalize">{run.source}</TableCell>
                <TableCell className="text-muted-foreground">
                  {format(new Date(run.started_at), 'dd/MM HH:mm')}
                </TableCell>
                <TableCell>{getStatusBadge(run.status)}</TableCell>
                <TableCell className="text-right">{run.total_fetched || 0}</TableCell>
                <TableCell className="text-right">{run.total_inserted || 0}</TableCell>
                <TableCell className="text-right">{run.total_skipped || 0}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

  // Fetch data quality checks
  const { data: qualityChecks = [], isLoading: loadingChecks, refetch: refetchChecks } = useQuery({
    queryKey: ['data-quality-checks'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('data_quality_checks');
      if (error) throw error;
      return data as DataQualityCheck[];
    }
  });

  // Fetch reconciliation runs
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

  // Fetch rebuild logs
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

  // Check if there are critical issues
  const hasCriticalIssues = qualityChecks.some(c => c.status === 'critical');
  const hasWarnings = qualityChecks.some(c => c.status === 'warning');

  // Reconcile mutation
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
        toast.success(`Reconciliación OK: diferencia ${data.difference_pct}%`);
      } else if (data.status === 'warning') {
        toast.warning(`Reconciliación WARNING: diferencia $${(data.difference / 100).toFixed(2)}`);
      } else {
        toast.error(`Reconciliación FAIL: diferencia $${(data.difference / 100).toFixed(2)}`);
      }
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    } finally {
      setIsReconciling(false);
    }
  };

  // Rebuild metrics mutation
  const rebuildMetrics = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('rebuild_metrics_staging');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rebuild-logs'] });
      toast.success('Métricas recalculadas en staging');
    },
    onError: (error: any) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  // Promote staging mutation
  const promoteStaging = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('promote_metrics_staging');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rebuild-logs'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      toast.success('Staging promovido a current');
    },
    onError: (error: any) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  // AI Audit
  const runAIAudit = async () => {
    setIsAnalyzing(true);
    try {
      // Get current metrics summary for AI analysis
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
      toast.error(`Error en análisis AI: ${error.message}`);
      setAiAnalysis(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ok':
        return <Badge className="bg-green-500/20 text-green-400"><CheckCircle className="w-3 h-3 mr-1" /> OK</Badge>;
      case 'warning':
        return <Badge className="bg-yellow-500/20 text-yellow-400"><AlertTriangle className="w-3 h-3 mr-1" /> Warning</Badge>;
      case 'critical':
      case 'fail':
        return <Badge className="bg-red-500/20 text-red-400"><XCircle className="w-3 h-3 mr-1" /> Crítico</Badge>;
      case 'info':
        return <Badge variant="outline">Info</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            Diagnostics Center
          </h1>
          <p className="text-muted-foreground">
            Reconciliación, calidad de datos y auditoría de métricas
          </p>
        </div>
        <div className="flex gap-2">
          <Button 
            onClick={async () => {
              await refetchChecks();
              toast.success("Datos de calidad actualizados");
            }} 
            variant="outline" 
            size="sm"
            disabled={loadingChecks}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loadingChecks ? 'animate-spin' : ''}`} />
            Actualizar
          </Button>
        </div>
      </div>

      {/* Critical Alert Banner */}
      {hasCriticalIssues && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Métricas en Warning</AlertTitle>
          <AlertDescription>
            Se detectaron problemas críticos en la calidad de datos. Las métricas pueden no ser precisas.
          </AlertDescription>
        </Alert>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className={hasCriticalIssues ? 'border-red-500/50' : hasWarnings ? 'border-yellow-500/50' : 'border-green-500/50'}>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-5 h-5" />
              <span className="font-medium">Data Quality</span>
            </div>
            <div className="flex items-center gap-2">
              {hasCriticalIssues ? (
                <Badge className="bg-red-500/20 text-red-400">Crítico</Badge>
              ) : hasWarnings ? (
                <Badge className="bg-yellow-500/20 text-yellow-400">Warnings</Badge>
              ) : (
                <Badge className="bg-green-500/20 text-green-400">OK</Badge>
              )}
              <span className="text-sm text-muted-foreground">
                {qualityChecks.filter(c => c.status !== 'ok' && c.status !== 'info').length} issues
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <ArrowRightLeft className="w-5 h-5" />
              <span className="font-medium">Última Reconciliación</span>
            </div>
            {reconciliationRuns[0] ? (
              <div className="flex items-center gap-2">
                {getStatusBadge(reconciliationRuns[0].status)}
                <span className="text-xs text-muted-foreground">
                  {format(new Date(reconciliationRuns[0].created_at), 'dd/MM HH:mm')}
                </span>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Sin datos</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-5 h-5" />
              <span className="font-medium">Último Rebuild</span>
            </div>
            {rebuildLogs[0] ? (
              <div className="flex items-center gap-2">
                {getStatusBadge(rebuildLogs[0].status)}
                <span className="text-xs text-muted-foreground">
                  {rebuildLogs[0].rows_processed} filas
                </span>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Sin rebuilds</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-5 h-5" />
              <span className="font-medium">Timezone</span>
            </div>
            <Badge variant="outline">America/Mexico_City</Badge>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="sync-health" className="space-y-4">
        <TabsList>
          <TabsTrigger value="sync-health" className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Sync Health
          </TabsTrigger>
          <TabsTrigger value="quality" className="gap-2">
            <Database className="w-4 h-4" />
            Data Quality
          </TabsTrigger>
          <TabsTrigger value="reconciliation" className="gap-2">
            <ArrowRightLeft className="w-4 h-4" />
            Reconciliación
          </TabsTrigger>
          <TabsTrigger value="rebuild" className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Rebuild Metrics
          </TabsTrigger>
          <TabsTrigger value="ai-audit" className="gap-2">
            <Brain className="w-4 h-4" />
            AI Audit
          </TabsTrigger>
        </TabsList>

        {/* Sync Health Tab - NEW */}
        <TabsContent value="sync-health">
          <SyncHealthPanel />
        </TabsContent>

        {/* Data Quality Tab */}
        <TabsContent value="quality">
          <Card>
            <CardHeader>
              <CardTitle>Checks de Calidad de Datos</CardTitle>
              <CardDescription>
                Verifica integridad y consistencia de la base de datos
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingChecks ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Check</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Cantidad</TableHead>
                      <TableHead className="text-right">Porcentaje</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {qualityChecks.map((check) => (
                      <TableRow key={check.check_name}>
                        <TableCell className="font-medium">
                          {CHECK_LABELS[check.check_name] || check.check_name}
                        </TableCell>
                        <TableCell>{getStatusBadge(check.status)}</TableCell>
                        <TableCell className="text-right">{check.count}</TableCell>
                        <TableCell className="text-right">
                          {check.percentage > 0 ? `${check.percentage}%` : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reconciliation Tab */}
        <TabsContent value="reconciliation">
          <Card>
            <CardHeader>
              <CardTitle>Reconciliación con Fuentes Externas</CardTitle>
              <CardDescription>
                Compara totales internos vs Stripe/PayPal
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-muted/50">
                <Select value={reconcileSource} onValueChange={setReconcileSource}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stripe">Stripe</SelectItem>
                    <SelectItem value="paypal">PayPal</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={reconcileRange} onValueChange={setReconcileRange}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Hoy</SelectItem>
                    <SelectItem value="7d">7 días</SelectItem>
                    <SelectItem value="30d">30 días</SelectItem>
                  </SelectContent>
                </Select>

                <Button onClick={runReconciliation} disabled={isReconciling}>
                  {isReconciling ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-2" />
                  )}
                  Ejecutar Reconciliación
                </Button>
              </div>

              {loadingReconciliation ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : reconciliationRuns.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No hay reconciliaciones ejecutadas
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fuente</TableHead>
                      <TableHead>Período</TableHead>
                      <TableHead className="text-right">Externo</TableHead>
                      <TableHead className="text-right">Interno</TableHead>
                      <TableHead className="text-right">Diferencia</TableHead>
                      <TableHead>Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliationRuns.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="font-medium capitalize">{run.source}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(run.period_start), 'dd/MM')} - {format(new Date(run.period_end), 'dd/MM')}
                        </TableCell>
                        <TableCell className="text-right">
                          ${(run.external_total / 100).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ${(run.internal_total / 100).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className={run.difference !== 0 ? 'text-yellow-400' : ''}>
                            ${(run.difference / 100).toLocaleString()} ({run.difference_pct}%)
                          </span>
                        </TableCell>
                        <TableCell>{getStatusBadge(run.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Rebuild Tab */}
        <TabsContent value="rebuild">
          <Card>
            <CardHeader>
              <CardTitle>Rebuild Metrics</CardTitle>
              <CardDescription>
                Recalcula todas las métricas de forma determinística
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-muted/50">
                <Button 
                  onClick={() => rebuildMetrics.mutate()} 
                  disabled={rebuildMetrics.isPending}
                >
                  {rebuildMetrics.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-2" />
                  )}
                  Rebuild a Staging
                </Button>

                <Button 
                  onClick={() => promoteStaging.mutate()} 
                  disabled={promoteStaging.isPending}
                  variant="secondary"
                >
                  {promoteStaging.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-2" />
                  )}
                  Promote Staging → Current
                </Button>
              </div>

              <div className="p-4 rounded-lg border border-border/50 bg-muted/30">
                <h4 className="font-medium mb-2">📋 Proceso de Rebuild</h4>
                <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                  <li>Click "Rebuild a Staging" para recalcular en tablas temporales</li>
                  <li>Revisa el diff de cambios en los logs</li>
                  <li>Si todo está correcto, click "Promote Staging → Current"</li>
                  <li>Las métricas del dashboard se actualizarán</li>
                </ol>
              </div>

              {loadingRebuilds ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : rebuildLogs.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No hay rebuilds ejecutados
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Filas</TableHead>
                      <TableHead>Promovido</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rebuildLogs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>
                          {format(new Date(log.started_at), 'dd/MM/yyyy HH:mm')}
                        </TableCell>
                        <TableCell>{getStatusBadge(log.status)}</TableCell>
                        <TableCell className="text-right">{log.rows_processed}</TableCell>
                        <TableCell>
                          {log.promoted ? (
                            <Badge className="bg-green-500/20 text-green-400">Sí</Badge>
                          ) : (
                            <Badge variant="outline">No</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Audit Tab */}
        <TabsContent value="ai-audit">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Brain className="w-5 h-5" />
                AI Audit (Solo Diagnóstico)
              </CardTitle>
              <CardDescription>
                La IA analiza patrones y sugiere mejoras. NO calcula números.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={runAIAudit} disabled={isAnalyzing}>
                {isAnalyzing ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Brain className="w-4 h-4 mr-2" />
                )}
                Ejecutar AI Audit
              </Button>

              {aiAnalysis && (
                <div className="p-4 rounded-lg border border-primary/20 bg-primary/5">
                  <h4 className="font-medium mb-2 flex items-center gap-2">
                    <Brain className="w-4 h-4" />
                    Análisis AI
                  </h4>
                  <div className="prose prose-sm prose-invert max-w-none">
                    <pre className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {aiAnalysis}
                    </pre>
                  </div>
                </div>
              )}

              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Importante</AlertTitle>
                <AlertDescription>
                  La IA solo diagnostica y sugiere. Todos los KPIs se calculan con SQL determinístico.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Documentation Link */}
      <Card className="bg-muted/30">
        <CardContent className="pt-4">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-primary" />
            <div>
              <h4 className="font-medium">Documentación de Métricas</h4>
              <p className="text-sm text-muted-foreground">
                Ver definiciones exactas en <code>/docs/metrics_definition.md</code>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

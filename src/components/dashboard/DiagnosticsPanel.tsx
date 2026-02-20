import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { buildInfo } from "@/lib/buildInfo";
import { env } from "@/lib/env";
import { APP_PATHS } from "@/config/appPaths";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { 
  Shield, 
  AlertTriangle, 
  CheckCircle, 
  PauseCircle,
  XCircle, 
  RefreshCw, 
  Play,
  FileText,
  Database,
  Loader2,
  ArrowRightLeft,
  Brain,
  BarChart3,
  Calendar,
  Copy,
  Wrench,
  ArrowRight
} from "lucide-react";
import { format, subDays } from "date-fns";

interface DataQualityCheck {
  check_name: string;
  status: string;
  count: number;
  percentage: number;
  details: any;
  /** mapped aliases */
  severity: string;
  affected_count: number;
}

interface RawDataQualityCheck {
  check_name?: string;
  status?: string;
  severity?: string;
  count?: number;
  affected_count?: number;
  percentage?: number;
  details?: any;
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
      return <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px] md:text-xs"><CheckCircle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> OK</Badge>;
    case 'running':
      return <Badge className="bg-zinc-800 text-foreground text-[10px] md:text-xs"><Loader2 className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1 animate-spin" /> En progreso</Badge>;
    case 'paused':
      return <Badge className="bg-amber-500/20 text-amber-400 text-[10px] md:text-xs"><PauseCircle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> Pausado</Badge>;
    case 'skipped':
      return <Badge className="bg-zinc-800 text-muted-foreground text-[10px] md:text-xs">Omitido</Badge>;
    case 'cancelled':
    case 'canceled':
      return <Badge className="bg-zinc-800 text-muted-foreground text-[10px] md:text-xs">Cancelado</Badge>;
    case 'warning':
      return <Badge className="bg-amber-500/20 text-amber-400 text-[10px] md:text-xs"><AlertTriangle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> Advertencia</Badge>;
    case 'critical':
    case 'fail':
    case 'error':
      return <Badge className="bg-red-500/20 text-red-400 text-[10px] md:text-xs"><XCircle className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1" /> Error</Badge>;
    case 'info':
      return <Badge variant="outline" className="bg-zinc-800 text-foreground text-[10px] md:text-xs">Info</Badge>;
    default:
      return <Badge variant="outline" className="bg-zinc-800 text-foreground text-[10px] md:text-xs">{status}</Badge>;
  }
};

function normalizeQualityChecks(rows: RawDataQualityCheck[] | null | undefined): DataQualityCheck[] {
  return (rows || []).map((row) => ({
    check_name: row.check_name || "unknown_check",
    status: row.status || row.severity || "info",
    count: typeof row.count === "number" ? row.count : (row.affected_count || 0),
    percentage: typeof row.percentage === "number" ? row.percentage : 0,
    details: row.details ?? {},
  }));
}

// Sync Health Panel Component
function SyncHealthPanel({ enabled, autoRefresh }: { enabled: boolean; autoRefresh: boolean }) {
  const { data: syncRuns = [], isLoading, error: syncRunsError } = useQuery({
    queryKey: ['sync-runs-health'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_runs')
        .select('id, source, status, started_at, completed_at, total_fetched, total_inserted, total_skipped, error_message')
        .order('started_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as SyncRun[];
    },
    enabled,
    refetchInterval: enabled && autoRefresh ? 30000 : false
  });

  const { data: webhookStats = [], error: webhookError } = useQuery({
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
    },
    enabled,
  });

  const syncBySource = syncRuns.reduce((acc, run) => {
    if (!acc[run.source]) acc[run.source] = [];
    acc[run.source].push(run);
    return acc;
  }, {} as Record<string, SyncRun[]>);

  if (!enabled) {
    return (
      <Card>
        <CardHeader className="p-4 md:p-6">
          <CardTitle className="text-base md:text-lg">Salud de sincronización</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Requiere permisos de administrador.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <Card>
      <CardHeader className="p-4 md:p-6">
        <CardTitle className="text-base md:text-lg">Salud de sincronización</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Historial de sincronizaciones y webhooks
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-4 md:space-y-6">
        {(syncRunsError || webhookError) && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            No se pudo cargar el estado de sincronización. Revisa permisos admin (RLS) y vuelve a intentar.
          </div>
        )}

        {/* Last Sync by Source - Cards */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
          {['stripe', 'paypal', 'ghl', 'manychat', 'csv'].map(source => {
            const runs = syncBySource[source] || [];
            const lastRun = runs[0];
            const last7dRuns = runs.filter(r => new Date(r.started_at) > subDays(new Date(), 7));
            
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
                      {lastRun.total_inserted || 0} insertados • {lastRun.total_skipped || 0} omitidos
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      7d: {last7dRuns.length} sincronizaciones
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
          <h4 className="font-medium text-sm">Últimas sincronizaciones</h4>
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
  const navigate = useNavigate();
  const [reconcileSource, setReconcileSource] = useState<string>('stripe');
  const [reconcileRange, setReconcileRange] = useState<string>('7d');
  const [isReconciling, setIsReconciling] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const copyToClipboard = async (text: string, okMessage = "Copiado") => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(okMessage);
    } catch {
      toast.error("No se pudo copiar");
    }
  };

  const supabaseHost = (() => {
    try {
      return new URL(env.VITE_SUPABASE_URL).host;
    } catch {
      return env.VITE_SUPABASE_URL || "—";
    }
  })();

  const { data: isAdmin, isLoading: loadingAdmin, error: adminError } = useQuery({
    queryKey: ['is-admin'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('is_admin');
      if (error) throw error;
      return Boolean(data);
    },
    staleTime: 60_000,
  });

  const { data: timezoneSetting, isLoading: loadingTimezone } = useQuery({
    queryKey: ['system-timezone'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'timezone')
        .maybeSingle();
      if (error) throw error;
      return (data?.value as string | null) ?? null;
    },
    enabled: isAdmin === true,
    staleTime: 60_000,
  });

  const timezoneLabel = useMemo(() => {
    const raw = timezoneSetting || "";
    const map: Record<string, string> = {
      "America/Mexico_City": "CDMX (CST)",
      "America/New_York": "NY (EST)",
      "America/Los_Angeles": "LA (PST)",
      "America/Chicago": "Chicago (CST)",
      "America/Bogota": "Bogotá (COT)",
      "America/Lima": "Lima (PET)",
      "America/Buenos_Aires": "Buenos Aires (ART)",
      "Europe/Madrid": "Madrid (CET)",
      "UTC": "UTC",
    };

    if (raw) return map[raw] || raw;

    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "—";
    } catch {
      return "—";
    }
  }, [timezoneSetting]);

  const repairApp = async () => {
    const confirmed = window.confirm(
      "Esto limpiará el cache (PWA/Service Worker) y recargará la app.\n\nNo borra tu sesión, pero puede tomar unos segundos."
    );
    if (!confirmed) return;

    setIsRepairing(true);
    try {
      // Unregister service workers
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      }

      // Clear caches
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
      }

      // Reload into a clean state
      window.location.reload();
    } catch (e) {
      console.error("[Diagnostics] Repair failed:", e);
      toast.error("No se pudo reparar la app", {
        description: e instanceof Error ? e.message : "Error desconocido",
      });
      setIsRepairing(false);
    }
  };

  const { data: qualityChecks = [], isLoading: loadingChecks, error: checksError, refetch: refetchChecks } = useQuery({
    queryKey: ['data-quality-checks'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('data_quality_checks');
      if (error) {
        // Degrade gracefully when the RPC is temporarily broken in production.
        console.warn('[Diagnostics] data_quality_checks RPC failed:', error.message);
        return [];
      }
      return normalizeQualityChecks(data as RawDataQualityCheck[]);
    },
    enabled: isAdmin === true,
    retry: false,
  });

  const { data: reconciliationRuns = [], isLoading: loadingReconciliation, error: reconciliationError } = useQuery({
    queryKey: ['reconciliation-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reconciliation_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as ReconciliationRun[];
    },
    enabled: isAdmin === true,
  });

  const { data: rebuildLogs = [], isLoading: loadingRebuilds, error: rebuildsError } = useQuery({
    queryKey: ['rebuild-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rebuild_logs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data as RebuildLog[];
    },
    enabled: isAdmin === true,
  });

  const checksLoaded = isAdmin === true && !loadingChecks && !checksError;
  const hasCriticalIssues = checksLoaded ? qualityChecks.some(c => c.severity === 'critical') : false;
  const hasWarnings = checksLoaded ? qualityChecks.some(c => c.severity === 'warning') : false;

  const refreshAll = async () => {
    if (isAdmin !== true) {
      toast.error("No autorizado", { description: "Se requieren permisos de administrador." });
      return;
    }

    const res = await refetchChecks();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reconciliation-runs'] }),
      queryClient.invalidateQueries({ queryKey: ['rebuild-logs'] }),
      queryClient.invalidateQueries({ queryKey: ['sync-runs-health'] }),
      queryClient.invalidateQueries({ queryKey: ['webhook-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['system-timezone'] }),
    ]);

    if (res.error) {
      toast.error("No se pudo actualizar", {
        description: res.error instanceof Error ? res.error.message : "Error desconocido",
      });
    } else {
      toast.success("Actualizado");
    }
  };

  const runReconciliation = async () => {
    setIsReconciling(true);
    try {
      if (isAdmin !== true) {
        throw new Error('No autorizado (se requieren permisos de admin)');
      }

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

      const data = await invokeWithAdminKey<{ status: string; difference: number; difference_pct: number }>('reconcile-metrics', {
        source: reconcileSource,
        start_date: format(startDate, 'yyyy-MM-dd'),
        end_date: format(endDate, 'yyyy-MM-dd')
      });

      if (!data || (data as any)?.ok === false || (data as any)?.success === false) {
        const msg = (data as any)?.error || (data as any)?.message || 'No se pudo ejecutar la reconciliación';
        throw new Error(msg);
      }

      if (
        typeof (data as any)?.status !== 'string' ||
        typeof (data as any)?.difference !== 'number' ||
        typeof (data as any)?.difference_pct !== 'number'
      ) {
        throw new Error('Respuesta inesperada de reconcile-metrics');
      }

      queryClient.invalidateQueries({ queryKey: ['reconciliation-runs'] });
      
      if (data.status === 'ok') {
        toast.success(`OK: diferencia ${data.difference_pct}%`);
      } else if (data.status === 'warning') {
        toast.warning(`Warning: $${(data.difference / 100).toFixed(2)}`);
      } else {
        toast.error(`Fail: $${(data.difference / 100).toFixed(2)}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error(`Error: ${message}`);
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
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error(`Error: ${message}`);
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
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error(`Error: ${message}`);
    }
  });

  const runAIAudit = async () => {
    setIsAnalyzing(true);
    try {
      if (isAdmin !== true) {
        throw new Error('No autorizado (se requieren permisos de admin)');
      }

      const [salesData, qualityData] = await Promise.all([
        supabase.rpc('kpi_sales', { p_range: '30d' }),
        supabase.rpc('data_quality_checks'),
      ]);

      if (salesData.error) throw salesData.error;
      const normalizedQualityChecks = qualityData.error
        ? []
        : normalizeQualityChecks(qualityData.data as RawDataQualityCheck[]);

      const prompt = `Analiza estos datos de métricas y calidad de datos de un SaaS:

MÉTRICAS DE VENTAS (30 días):
${JSON.stringify(salesData.data, null, 2)}

CHECKS DE CALIDAD:
${JSON.stringify(normalizedQualityChecks, null, 2)}

${qualityData.error ? `NOTA: El RPC data_quality_checks falló con: ${qualityData.error.message}` : ''}

Por favor:
1. Detecta anomalías o patrones sospechosos
2. Sugiere posibles causas de problemas
3. Recomienda acciones correctivas
4. NO recalcules números, solo diagnostica

Responde en español, de forma concisa.`;

      const data = await invokeWithAdminKey<{ analysis?: string; message?: string }>('analyze-business', { prompt, context: 'diagnostics' });
      if (!data || (data as any)?.ok === false || (data as any)?.success === false) {
        const msg = (data as any)?.error || (data as any)?.message || 'No se pudo generar análisis';
        throw new Error(msg);
      }
      setAiAnalysis(data.analysis || data.message || 'No se pudo generar análisis');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error(`Error AI: ${message}`);
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
            Diagnóstico
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-0.5">
            Estado operativo, calidad y herramientas de reparación
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              id="diag-auto-refresh"
              disabled={loadingAdmin}
            />
            <Label htmlFor="diag-auto-refresh" className="text-xs text-muted-foreground">
              Auto-actualizar
              <span className="hidden sm:inline"> (30s)</span>
            </Label>
          </div>
          <Button
            onClick={refreshAll}
            variant="outline"
            size="sm"
            disabled={loadingChecks || loadingAdmin || isAdmin !== true}
            className="self-start sm:self-auto touch-feedback"
          >
            <RefreshCw className={`w-4 h-4 ${loadingChecks ? 'animate-spin' : ''}`} />
            <span className="ml-2 hidden sm:inline">Actualizar</span>
          </Button>
        </div>
      </div>

      {/* Quick Guidance */}
      <Card className="border-border/50">
        <CardContent className="p-4 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Qué hacer aquí</p>
              <p className="text-xs text-muted-foreground">
                Si algo no cuadra: revisa Calidad, valida Reconciliación y, si hace falta, vuelve a Sincronizar.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(APP_PATHS.sync)}
                className="gap-2"
              >
                <ArrowRight className="h-4 w-4" />
                Ir a Sincronizar
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(buildInfo.gitSha, "Build copiado")}
                className="gap-2"
              >
                <Copy className="h-4 w-4" />
                Copiar build
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={repairApp}
                disabled={isRepairing}
                className="gap-2"
              >
                <Wrench className={`h-4 w-4 ${isRepairing ? "animate-pulse" : ""}`} />
                Reparar app
              </Button>
            </div>
          </div>

          {(adminError || (isAdmin === false && !loadingAdmin)) && (
            <div className="mt-3 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs text-orange-300">
              Este panel muestra más información con permisos de administrador (RPC `is_admin()`).
            </div>
          )}

          {isAdmin === true && hasCriticalIssues && (
            <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              Hay checks en estado <span className="font-medium">Crítico</span>. Revisa la pestaña <span className="font-medium">Datos</span> antes de reconstruir o promover métricas.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="p-4 md:p-6">
          <CardTitle className="text-base md:text-lg">Versión y entorno</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Para confirmar que estás viendo el build correcto (y diagnosticar PWA/cache).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 md:p-6 pt-0 md:pt-0">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Build</p>
              <p className="mt-1 font-mono text-sm text-foreground">{buildInfo.gitSha}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {new Date(buildInfo.buildTime).toLocaleString()}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => copyToClipboard(buildInfo.gitSha, "Build copiado")}
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span className="ml-2">Copiar</span>
                </Button>
              </div>
            </div>
            <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Supabase</p>
              <p className="mt-1 font-mono text-sm text-foreground">{supabaseHost}</p>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>Anon key:</span>
                {env.VITE_SUPABASE_PUBLISHABLE_KEY ? (
                  <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px]">OK</Badge>
                ) : (
                  <Badge className="bg-red-500/20 text-red-400 text-[10px]">Falta</Badge>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>Admin:</span>
                {loadingAdmin ? (
                  <Badge className="bg-zinc-800 text-foreground text-[10px]">
                    <Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin" /> Verificando
                  </Badge>
                ) : isAdmin ? (
                  <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px]">OK</Badge>
                ) : (
                  <Badge className="bg-amber-500/20 text-amber-400 text-[10px]">No</Badge>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-foreground">Reparar app (cache/PWA)</p>
              <p className="text-[10px] text-muted-foreground">
                Si te aparece pantalla en blanco, versión vieja o errores raros, limpia el cache y recarga.
              </p>
            </div>
            <Button
              onClick={repairApp}
              variant="outline"
              size="sm"
              disabled={isRepairing}
              className="gap-2 self-start sm:self-auto"
            >
              <RefreshCw className={`h-4 w-4 ${isRepairing ? "animate-spin" : ""}`} />
              Reparar
            </Button>
          </div>
        </CardContent>
      </Card>

      {(adminError || (isAdmin === false && !loadingAdmin)) && (
        <Alert className="border-orange-500/50 bg-orange-500/10 py-3">
          <AlertTriangle className="h-4 w-4 text-orange-400" />
          <AlertTitle className="text-sm text-orange-400">
            {adminError ? "No se pudieron verificar permisos" : "Permisos insuficientes"}
          </AlertTitle>
          <AlertDescription className="text-xs text-orange-300">
            {adminError
              ? (adminError instanceof Error ? adminError.message : "Error desconocido")
              : "Este panel requiere un usuario administrador (is_admin())."}
          </AlertDescription>
        </Alert>
      )}

      {isAdmin === true && (
        <>
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

      {/* Sync Required Alert - Show when reconciliation has high difference */}
      {reconciliationRuns[0] && reconciliationRuns[0].status === 'fail' && reconciliationRuns[0].difference_pct >= 50 && (
        <Alert className="border-orange-500/50 bg-orange-500/10 py-3">
          <RefreshCw className="h-4 w-4 text-orange-400" />
          <AlertTitle className="text-sm text-orange-400">Sincronización Requerida</AlertTitle>
          <AlertDescription className="text-xs text-orange-300">
            La última reconciliación de {reconciliationRuns[0].source} detectó {reconciliationRuns[0].difference_pct.toFixed(1)}% de diferencia.
            Ejecuta "Sincronizar {reconciliationRuns[0].source === 'stripe' ? 'Stripe' : 'PayPal'}" desde Importar/Sincronizar antes de reconciliar.
          </AlertDescription>
        </Alert>
      )}

      {/* Summary Cards - 2x2 on mobile */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card className={
          checksError
            ? 'border-red-500/50'
            : loadingChecks
              ? 'border-border/50'
              : hasCriticalIssues
                ? 'border-red-500/50'
                : hasWarnings
                  ? 'border-amber-500/50'
                  : 'border-emerald-500/50'
        }>
          <CardContent className="p-3 md:pt-4 md:p-4">
            <div className="flex items-center gap-1.5 md:gap-2 mb-1.5 md:mb-2">
              <Database className="w-4 h-4 md:w-5 md:h-5 text-primary" />
              <span className="font-medium text-xs md:text-sm">Datos</span>
            </div>
            <div className="flex items-center gap-1.5">
              {loadingChecks ? (
                <Badge className="bg-zinc-800 text-foreground text-[10px] md:text-xs">
                  <Loader2 className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5 md:mr-1 animate-spin" /> Cargando
                </Badge>
              ) : checksError ? (
                <Badge className="bg-red-500/20 text-red-400 text-[10px] md:text-xs">Error</Badge>
              ) : hasCriticalIssues ? (
                <Badge className="bg-red-500/20 text-red-400 text-[10px] md:text-xs">Crítico</Badge>
              ) : hasWarnings ? (
                <Badge className="bg-amber-500/20 text-amber-400 text-[10px] md:text-xs">Advertencia</Badge>
              ) : (
                <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px] md:text-xs">OK</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3 md:pt-4 md:p-4">
            <div className="flex items-center gap-1.5 md:gap-2 mb-1.5 md:mb-2">
              <ArrowRightLeft className="w-4 h-4 md:w-5 md:h-5" />
              <span className="font-medium text-xs md:text-sm">Reconc.</span>
            </div>
            {reconciliationRuns[0] ? (
              <div className="flex flex-col gap-1">
                {getStatusBadge(reconciliationRuns[0].status)}
                <span className="text-[10px] text-muted-foreground">
                  {format(new Date(reconciliationRuns[0].created_at), 'dd/MM')}
                </span>
              </div>
            ) : reconciliationError ? (
              <div className="flex flex-col gap-1">
                {getStatusBadge('error')}
                <span className="text-[10px] text-muted-foreground">Sin acceso</span>
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
              <span className="font-medium text-xs md:text-sm">Reconstrucción</span>
            </div>
            {rebuildLogs[0] ? (
              <div className="flex flex-col gap-1">
                {getStatusBadge(rebuildLogs[0].status)}
                <span className="text-[10px] text-muted-foreground">
                  {rebuildLogs[0].rows_processed} filas
                </span>
              </div>
            ) : rebuildsError ? (
              <div className="flex flex-col gap-1">
                {getStatusBadge('error')}
                <span className="text-[10px] text-muted-foreground">Sin acceso</span>
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
              <span className="font-medium text-xs md:text-sm">Zona</span>
            </div>
            <Badge variant="outline" className="text-[10px] md:text-xs">
              {loadingTimezone ? '...' : timezoneLabel}
            </Badge>
          </CardContent>
        </Card>
      </div>

      {/* Tabs - Scrollable on mobile */}
      <Tabs defaultValue="overview" className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <TabsList className="inline-flex min-w-max md:min-w-0">
            <TabsTrigger value="overview" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <Shield className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Resumen</span>
            </TabsTrigger>
            <TabsTrigger value="sync-health" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <RefreshCw className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Sincronización</span>
            </TabsTrigger>
            <TabsTrigger value="quality" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <Database className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Datos</span>
            </TabsTrigger>
            <TabsTrigger value="reconciliation" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <ArrowRightLeft className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Pagos</span>
            </TabsTrigger>
            <TabsTrigger value="rebuild" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <BarChart3 className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Métricas</span>
            </TabsTrigger>
            <TabsTrigger value="ai-audit" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
              <Brain className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">AI</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Overview Tab */}
        <TabsContent value="overview">
          <Card>
            <CardHeader className="p-4 md:p-6">
              <CardTitle className="text-base md:text-lg">Resumen</CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Lectura rápida para decidir el siguiente paso
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-3">
              <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
                <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
                  <p className="text-xs font-medium text-foreground">Si ves diferencias grandes en pagos</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Primero sincroniza Stripe/PayPal en <span className="font-mono">/ops/sync</span>, luego corre Reconciliación.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2 gap-2"
                    onClick={() => navigate(APP_PATHS.sync)}
                  >
                    <ArrowRight className="h-4 w-4" />
                    Abrir Sincronizar
                  </Button>
                </div>

                <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
                  <p className="text-xs font-medium text-foreground">Si la app se ve “vieja” o rara</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Es casi siempre cache/PWA. Usa “Reparar app” y valida el build.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 gap-2"
                    onClick={repairApp}
                    disabled={isRepairing}
                  >
                    <Wrench className="h-4 w-4" />
                    Reparar app
                  </Button>
                </div>

                <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
                  <p className="text-xs font-medium text-foreground">Si no puedes ver datos aquí</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Falta permiso admin. Confirma que tu usuario pasa <span className="font-mono">is_admin()</span>.
                  </p>
                  <div className="mt-2">{getStatusBadge(isAdmin ? 'ok' : 'warning')}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Sync Health Tab */}
        <TabsContent value="sync-health">
          <SyncHealthPanel enabled={isAdmin === true} autoRefresh={autoRefresh} />
        </TabsContent>

        {/* Data Quality Tab */}
        <TabsContent value="quality">
          <Card>
            <CardHeader className="p-4 md:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base md:text-lg">Calidad de Datos</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Integridad y consistencia
                  </CardDescription>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  Actualizado: {format(new Date(), 'HH:mm')}
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0">
              {checksError && (
                <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  No se pudieron cargar los checks de calidad. Revisa permisos admin (RLS) y vuelve a intentar.
                </div>
              )}
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
                        {getStatusBadge(check.severity)}
                      </div>
                      <div className="flex items-center gap-2 md:gap-4 text-right">
                        <span className="text-xs md:text-sm font-medium">{check.affected_count}</span>
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
              {reconciliationError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  No se pudieron cargar las reconciliaciones. Revisa permisos admin (RLS) y vuelve a intentar.
                </div>
              )}
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
              <CardTitle className="text-base md:text-lg">Reconstrucción de métricas</CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Recalcula métricas determinísticas
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 md:p-6 pt-0 md:pt-0 space-y-4">
              {rebuildsError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  No se pudieron cargar los logs de reconstrucción. Revisa permisos admin (RLS) y vuelve a intentar.
                </div>
              )}
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
                  <span className="ml-2">Reconstruir</span>
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
                  <span className="ml-2">Promover</span>
                </Button>
              </div>

              <div className="p-3 rounded-lg border border-border/50 bg-muted/30">
                <h4 className="font-medium text-sm mb-2">📋 Proceso</h4>
                <ol className="list-decimal list-inside text-xs text-muted-foreground space-y-1">
                  <li>Click "Reconstruir" → staging</li>
                  <li>Revisa el diff</li>
                  <li>Click "Promover" → current</li>
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
                Auditoría IA
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
                <span className="ml-2">Ejecutar auditoría</span>
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
              <h4 className="font-medium text-sm">Documentación</h4>
              <p className="text-[10px] md:text-xs text-muted-foreground truncate">
                /docs/metrics_definition.md
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
        </>
      )}
    </div>
  );
}

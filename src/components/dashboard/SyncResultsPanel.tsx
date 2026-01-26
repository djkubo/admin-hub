import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  CreditCard,
  FileText,
  Users
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Json } from "@/integrations/supabase/types";

interface SyncRun {
  id: string;
  source: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_fetched: number | null;
  total_inserted: number | null;
  total_updated: number | null;
  error_message: string | null;
  checkpoint: Json | null;
  dry_run: boolean | null;
}

const SOURCE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  stripe: { label: "Stripe", icon: CreditCard, color: "text-purple-400" },
  paypal: { label: "PayPal", icon: CreditCard, color: "text-blue-400" },
  subscriptions: { label: "Suscripciones", icon: RefreshCw, color: "text-green-400" },
  invoices: { label: "Facturas", icon: FileText, color: "text-amber-400" },
  ghl: { label: "GoHighLevel", icon: Users, color: "text-cyan-400" },
  manychat: { label: "ManyChat", icon: Users, color: "text-pink-400" },
};

export function SyncResultsPanel() {
  const [recentRuns, setRecentRuns] = useState<SyncRun[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeSyncs, setActiveSyncs] = useState<SyncRun[]>([]);

  const fetchRuns = async () => {
    // Active/running syncs
    const { data: active } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["running", "continuing"])
      .order("started_at", { ascending: false });

    setActiveSyncs((active || []) as SyncRun[]);

    // Recent completed/failed syncs (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("sync_runs")
      .select("*")
      .in("status", ["completed", "failed"])
      .gte("completed_at", oneHourAgo)
      .order("completed_at", { ascending: false })
      .limit(10);

    setRecentRuns((recent || []) as SyncRun[]);
  };

  useEffect(() => {
    fetchRuns();
    const interval = setInterval(fetchRuns, 3000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to realtime changes
  useEffect(() => {
    const channel = supabase
      .channel('sync_runs_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sync_runs' },
        () => {
          fetchRuns();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getSourceConfig = (source: string) => {
    return SOURCE_CONFIG[source] || {
      label: source,
      icon: RefreshCw,
      color: "text-muted-foreground"
    };
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
            <CheckCircle className="h-3 w-3 mr-1" />
            OK
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30">
            <XCircle className="h-3 w-3 mr-1" />
            Error
          </Badge>
        );
      case "running":
      case "continuing":
        return (
          <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/30">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            En progreso
          </Badge>
        );
      default:
        return (
          <Badge variant="outline">
            {status}
          </Badge>
        );
    }
  };

  const getProgressPercent = (sync: SyncRun): number => {
    const checkpoint = (typeof sync.checkpoint === 'object' && sync.checkpoint !== null)
      ? sync.checkpoint as Record<string, unknown>
      : null;

    // If we have runningTotal, estimate based on typical patterns
    const runningTotal = checkpoint?.runningTotal as number || sync.total_fetched || 0;

    // Estimate progress - cap at 95% until actually complete
    if (sync.status === 'completed') return 100;
    if (runningTotal === 0) return 5;

    // Rough estimate: assume ~1000 transactions max for most syncs
    const estimated = Math.min(95, Math.round((runningTotal / 1000) * 100));
    return Math.max(estimated, 10);
  };

  const formatDuration = (start: string, end: string | null) => {
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const diffMs = endDate.getTime() - startDate.getTime();
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  };

  const hasAnySyncs = activeSyncs.length > 0 || recentRuns.length > 0;

  // Always show panel
  // if (!hasAnySyncs) return null;

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <RefreshCw className={`h-4 w-4 text-primary ${activeSyncs.length > 0 ? 'animate-spin' : ''}`} />
          <span className="text-sm font-medium text-foreground">
            Estado de Sincronización
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={async (e) => {
                e.stopPropagation();
                setActiveSyncs([]); // Limpiar UI inmediatamente
                toast.loading('Limpiando procesos...', { id: 'reset-toast' });

                const { error } = await supabase.rpc('reset_stuck_syncs', { p_timeout_minutes: 0 });

                if (!error) {
                  toast.success('Sistema reiniciado. Recargando...', { id: 'reset-toast' });
                  setTimeout(() => {
                    window.location.reload();
                  }, 1000);
                } else {
                  toast.error('Error: ' + error.message, { id: 'reset-toast' });
                  fetchRuns();
                }
              }}
              className="h-6 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1 mr-2"
            >
              <XCircle className="h-3 w-3" />
              {activeSyncs.length > 0 ? "Forzar Detención" : "Limpiar Estado"}
            </Button>

            {activeSyncs.length > 0 && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/30 text-xs">
                {activeSyncs.length} activo{activeSyncs.length > 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-border/50">
          {/* Active syncs */}
          {activeSyncs.length > 0 && (
            <div className="p-4 space-y-3 bg-blue-500/5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">En progreso</p>
              {activeSyncs.map((sync) => {
                const config = getSourceConfig(sync.source);
                const Icon = config.icon;
                const progress = getProgressPercent(sync);

                return (
                  <div key={sync.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className={`h-4 w-4 ${config.color}`} />
                        <span className="text-sm font-medium">{config.label}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{sync.total_fetched?.toLocaleString() || 0} registros</span>
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </div>
                    </div>
                    <Progress value={progress} className="h-1.5" />
                    <p className="text-xs text-muted-foreground">
                      Iniciado {formatDistanceToNow(new Date(sync.started_at), { addSuffix: true, locale: es })}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent completed/failed */}
          {recentRuns.length > 0 && (
            <div className="divide-y divide-border/30">
              {recentRuns.map((sync) => {
                const config = getSourceConfig(sync.source);
                const Icon = config.icon;

                return (
                  <div key={sync.id} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Icon className={`h-4 w-4 ${config.color} flex-shrink-0`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{config.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {sync.completed_at && format(new Date(sync.completed_at), "HH:mm", { locale: es })}
                          {' • '}
                          {formatDuration(sync.started_at, sync.completed_at)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="text-right">
                        <p className="text-sm font-medium">
                          {sync.total_fetched?.toLocaleString() || 0}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {sync.total_inserted ? `${sync.total_inserted.toLocaleString()} nuevos` : 'sincronizados'}
                        </p>
                      </div>
                      {getStatusBadge(sync.status)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Error messages */}
          {recentRuns.filter(r => r.error_message).map((sync) => (
            <div key={`error-${sync.id}`} className="px-4 py-2 bg-red-500/5 text-xs text-red-400 border-t border-red-500/20">
              <span className="font-medium">{getSourceConfig(sync.source).label}:</span>{' '}
              {sync.error_message}
            </div>
          ))}
        </div>
      )
      }
    </div >
  );
}

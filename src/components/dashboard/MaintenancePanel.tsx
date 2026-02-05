import { useState } from "react";
import { Trash2, Database, Clock, CheckCircle2, AlertCircle, Loader2, HardDrive, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { supabase } from "@/integrations/supabase/client";

interface CleanupResult {
  success: boolean;
  message: string;
  details: {
    sync_runs_deleted: number;
    csv_import_runs_deleted: number;
    csv_imports_raw_deleted: number;
    ghl_contacts_raw_deleted: number;
    manychat_contacts_raw_deleted: number;
    merge_conflicts_deleted: number;
    errors: string[];
  };
  preserved_sources?: string[];
}

export default function MaintenancePanel() {
  const { toast } = useToast();
  const [isRunning, setIsRunning] = useState(false);
  const [isClearingFailed, setIsClearingFailed] = useState(false);
  const [lastResult, setLastResult] = useState<CleanupResult | null>(null);
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);

  const handleClearFailedSyncs = async () => {
    setIsClearingFailed(true);
    try {
      // Delete all failed, canceled, and stuck syncs
      const { data, error } = await supabase
        .from("sync_runs")
        .delete()
        .in("status", ["failed", "canceled", "paused"])
        .select("id");

      if (error) throw error;

      const count = data?.length || 0;
      toast({
        title: "Syncs limpiados",
        description: `Se eliminaron ${count} registros de sincronizaciones fallidas/canceladas`,
      });
    } catch (error: any) {
      console.error("Clear failed syncs error:", error);
      toast({
        title: "Error",
        description: error.message || "No se pudieron limpiar los syncs",
        variant: "destructive",
      });
    } finally {
      setIsClearingFailed(false);
    }
  };

  const handleRunCleanup = async () => {
    setIsRunning(true);
    try {
      const result = await invokeWithAdminKey("cleanup-logs", {}) as CleanupResult;
      setLastResult(result);
      setLastRunAt(new Date());

      if (result.success) {
        toast({
          title: "Limpieza completada",
          description: result.message,
        });
      } else {
        toast({
          title: "Limpieza parcial",
          description: `Se completó con ${result.details.errors.length} errores`,
          variant: "destructive",
        });
      }
    } catch (error: any) {
      console.error("Cleanup error:", error);
      toast({
        title: "Error de limpieza",
        description: error.message || "No se pudo ejecutar la limpieza",
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  const totalDeleted = lastResult
    ? lastResult.details.sync_runs_deleted +
      lastResult.details.csv_import_runs_deleted +
      lastResult.details.csv_imports_raw_deleted +
      lastResult.details.ghl_contacts_raw_deleted +
      lastResult.details.manychat_contacts_raw_deleted +
      lastResult.details.merge_conflicts_deleted
    : 0;

  return (
    <Card className="card-base">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <HardDrive className="h-5 w-5 text-primary" />
          Mantenimiento de Base de Datos
        </CardTitle>
        <CardDescription>
          Limpieza automática de registros antiguos para optimizar el rendimiento
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick Actions - Clear Failed Syncs */}
        <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-sm text-foreground flex items-center gap-2">
                <XCircle className="h-4 w-4 text-destructive" />
                Limpiar Syncs Fallidos
              </h4>
              <p className="text-xs text-muted-foreground mt-1">
                Elimina todos los registros de syncs fallidos, cancelados o pausados
              </p>
            </div>
            <Button
              onClick={handleClearFailedSyncs}
              disabled={isClearingFailed}
              variant="destructive"
              size="sm"
              className="gap-2"
            >
              {isClearingFailed ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Limpiando...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  Borrar Fallidos
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Cleanup Policy Info */}
        <div className="rounded-lg bg-muted/30 border border-border/50 p-4 space-y-2">
          <h4 className="font-medium text-sm text-foreground flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            Política de Retención
          </h4>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>• <strong>sync_runs:</strong> 7 días (conserva última ejecución exitosa por fuente)</li>
            <li>• <strong>csv_imports_raw:</strong> 30 días (solo procesados)</li>
            <li>• <strong>ghl_contacts_raw:</strong> 30 días (solo procesados)</li>
            <li>• <strong>manychat_contacts_raw:</strong> 30 días (solo procesados)</li>
            <li>• <strong>merge_conflicts:</strong> 30 días (solo resueltos)</li>
          </ul>
        </div>

        {/* Action Button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {lastRunAt
                ? `Última limpieza: ${formatDistanceToNow(lastRunAt, { addSuffix: true, locale: es })}`
                : "La limpieza automática se ejecuta diariamente"}
            </span>
          </div>
          <Button
            onClick={handleRunCleanup}
            disabled={isRunning}
            variant="outline"
            size="sm"
            className="gap-2"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Limpiando...
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Ejecutar Limpieza Manual
              </>
            )}
          </Button>
        </div>

        {/* Results Display */}
        {lastResult && (
          <div className={`rounded-lg border p-4 ${
            lastResult.success 
              ? "bg-primary/10 border-primary/30" 
              : "bg-destructive/10 border-destructive/30"
          }`}>
            <div className="flex items-center gap-2 mb-3">
              {lastResult.success ? (
                <CheckCircle2 className="h-4 w-4 text-primary" />
              ) : (
                <AlertCircle className="h-4 w-4 text-destructive" />
              )}
              <span className="font-medium text-sm">
                {totalDeleted.toLocaleString()} registros eliminados
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="flex justify-between p-2 bg-background/50 rounded">
                <span className="text-muted-foreground">sync_runs</span>
                <span className="font-mono">{lastResult.details.sync_runs_deleted}</span>
              </div>
              <div className="flex justify-between p-2 bg-background/50 rounded">
                <span className="text-muted-foreground">csv_import_runs</span>
                <span className="font-mono">{lastResult.details.csv_import_runs_deleted}</span>
              </div>
              <div className="flex justify-between p-2 bg-background/50 rounded">
                <span className="text-muted-foreground">csv_imports_raw</span>
                <span className="font-mono">{lastResult.details.csv_imports_raw_deleted}</span>
              </div>
              <div className="flex justify-between p-2 bg-background/50 rounded">
                <span className="text-muted-foreground">ghl_contacts_raw</span>
                <span className="font-mono">{lastResult.details.ghl_contacts_raw_deleted}</span>
              </div>
              <div className="flex justify-between p-2 bg-background/50 rounded">
                <span className="text-muted-foreground">manychat_raw</span>
                <span className="font-mono">{lastResult.details.manychat_contacts_raw_deleted}</span>
              </div>
              <div className="flex justify-between p-2 bg-background/50 rounded">
                <span className="text-muted-foreground">merge_conflicts</span>
                <span className="font-mono">{lastResult.details.merge_conflicts_deleted}</span>
              </div>
            </div>

            {lastResult.preserved_sources && lastResult.preserved_sources.length > 0 && (
              <div className="mt-3 text-xs text-muted-foreground">
                <span className="font-medium">Fuentes preservadas:</span>{" "}
                {lastResult.preserved_sources.join(", ")}
              </div>
            )}

            {lastResult.details.errors.length > 0 && (
              <div className="mt-3 text-xs text-destructive">
                <span className="font-medium">Errores:</span>
                <ul className="mt-1 space-y-1">
                  {lastResult.details.errors.map((err, i) => (
                    <li key={i}>• {err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

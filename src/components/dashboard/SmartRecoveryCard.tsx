import { 
  Zap, 
  Download, 
  Loader2, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle,
  Rocket,
  RefreshCw,
  StopCircle,
  Clock,
  Activity,
  AlertOctagon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { 
  useSmartRecovery, 
  RECOVERY_RANGES, 
  type HoursLookback 
} from "@/hooks/useSmartRecovery";

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function SmartRecoveryCard() {
  const { 
    isRunning, 
    progress,
    selectedRange,
    error,
    runRecovery,
    cancelRecovery,
    forceCancelStale,
    clearProgress,
    exportToCSV, 
  } = useSmartRecovery();

  const handleRunRecovery = (hours: HoursLookback) => {
    runRecovery(hours);
  };

  const isCompleted = progress?.status === "completed";
  const isFailed = progress?.status === "failed";
  const showResults = progress && (isCompleted || isFailed || isRunning);

  return (
    <div className="rounded-xl border border-primary/30 bg-card p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/20">
            <Rocket className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Smart Recovery</h2>
            <p className="text-sm text-muted-foreground">
              Recuperación automática en segundo plano
            </p>
          </div>
        </div>
        {showResults && !isRunning && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearProgress}
            className="text-muted-foreground hover:text-white"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Limpiar
          </Button>
        )}
      </div>

      {/* Range Buttons */}
      <div className="mb-6 flex flex-wrap gap-2">
        {RECOVERY_RANGES.map(({ hours, label }) => (
          <Button
            key={hours}
            variant={selectedRange === hours ? "default" : "outline"}
            size="sm"
            onClick={() => handleRunRecovery(hours)}
            disabled={isRunning}
            className={
              selectedRange === hours 
                ? "bg-primary hover:bg-primary/90 text-white border-primary" 
                : "border-zinc-700 text-white hover:bg-zinc-800"
            }
          >
            {isRunning && selectedRange === hours ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-2" />
            )}
            {label}
          </Button>
        ))}
      </div>

      {/* Error State */}
      {error && !isRunning && (
        <div className="mb-6 rounded-lg bg-red-500/10 border border-red-500/30 p-4">
          <div className="flex items-center gap-3">
            <XCircle className="h-6 w-6 text-red-400 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-300">Error en el proceso</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Running State with Real-time Progress */}
      {isRunning && progress && (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <div className="relative">
            <Loader2 className="h-16 w-16 text-primary animate-spin" />
            <Zap className="h-6 w-6 text-white absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          
          <p className="mt-4 text-lg font-medium text-white">
            Ejecutando en Segundo Plano...
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Puedes cerrar esta pestaña. El proceso continuará.
          </p>
          
          {/* Time Info */}
          <div className="flex items-center gap-4 mt-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              <span>Tiempo: {formatElapsed(progress.elapsedSeconds)}</span>
            </div>
            <div className="flex items-center gap-1">
              <Activity className="h-4 w-4" />
              <span>Procesados: {progress.checkpoint.processed}</span>
            </div>
          </div>

          {/* Stale Warning */}
          {progress.isStale && (
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 w-full max-w-md">
              <div className="flex items-center gap-2 text-amber-400">
                <AlertOctagon className="h-5 w-5" />
                <span className="font-medium">Proceso posiblemente atascado</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                No ha habido actividad en los últimos 5 minutos.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={forceCancelStale}
                className="mt-2 border-amber-500/50 text-amber-400 hover:bg-amber-500/10"
              >
                Forzar Cancelación
              </Button>
            </div>
          )}

          {/* Progress Bar */}
          <div className="mt-4 w-full max-w-md">
            <Progress value={undefined} className="h-2 bg-zinc-800" />
          </div>

          {/* Real-time Stats */}
          <div className="mt-4 grid grid-cols-3 gap-4 w-full max-w-lg">
            <div className="text-center p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <p className="text-2xl font-bold text-green-400">
                ${progress.checkpoint.recovered_amount.toFixed(0)}
              </p>
              <p className="text-xs text-muted-foreground">Recuperado</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-2xl font-bold text-red-400">
                ${progress.checkpoint.failed_amount.toFixed(0)}
              </p>
              <p className="text-xs text-muted-foreground">Fallido</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-2xl font-bold text-amber-400">
                ${progress.checkpoint.skipped_amount.toFixed(0)}
              </p>
              <p className="text-xs text-muted-foreground">Omitido</p>
            </div>
          </div>

          {/* Cancel Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={cancelRecovery}
            className="mt-6 border-red-500/50 text-red-400 hover:bg-red-500/10"
          >
            <StopCircle className="h-4 w-4 mr-2" />
            Cancelar Proceso
          </Button>
        </div>
      )}

      {/* Completed/Failed Results */}
      {showResults && !isRunning && progress && (
        <>
          {/* Status Banner */}
          <div className={`mb-6 rounded-lg p-4 ${
            isCompleted 
              ? "bg-green-500/10 border border-green-500/30" 
              : "bg-red-500/10 border border-red-500/30"
          }`}>
            <div className="flex items-center gap-3">
              {isCompleted ? (
                <CheckCircle2 className="h-6 w-6 text-green-400" />
              ) : (
                <XCircle className="h-6 w-6 text-red-400" />
              )}
              <div>
                <p className={`font-medium ${isCompleted ? "text-green-300" : "text-red-300"}`}>
                  {isCompleted ? "Proceso Completado" : "Proceso Finalizado con Errores"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Tiempo total: {formatElapsed(progress.elapsedSeconds)} | 
                  Facturas procesadas: {progress.checkpoint.processed}
                </p>
              </div>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-5 w-5 text-green-400" />
                <span className="text-sm font-medium text-green-400">Recuperado</span>
              </div>
              <p className="text-2xl font-bold text-green-300">
                ${progress.checkpoint.recovered_amount.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {progress.checkpoint.succeeded_count} facturas cobradas
              </p>
            </div>

            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <XCircle className="h-5 w-5 text-red-400" />
                <span className="text-sm font-medium text-red-400">Fallido</span>
              </div>
              <p className="text-2xl font-bold text-red-300">
                ${progress.checkpoint.failed_amount.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {progress.checkpoint.failed_count} sin cobrar
              </p>
            </div>

            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <span className="text-sm font-medium text-amber-400">Omitido</span>
              </div>
              <p className="text-2xl font-bold text-amber-300">
                ${progress.checkpoint.skipped_amount.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {progress.checkpoint.skipped_count} omitidas
              </p>
            </div>

            <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium text-white">Total</span>
              </div>
              <p className="text-2xl font-bold text-white">
                {progress.checkpoint.processed}
              </p>
              <p className="text-xs text-muted-foreground">
                facturas procesadas
              </p>
            </div>
          </div>

          {/* Export Button */}
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              className="gap-2 border-zinc-700 text-white hover:bg-zinc-800"
            >
              <Download className="h-4 w-4" />
              Descargar Reporte CSV
            </Button>
          </div>
        </>
      )}

      {/* Empty State */}
      {!showResults && !isRunning && !error && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Rocket className="h-8 w-8 text-primary" />
          </div>
          <p className="text-lg font-medium text-white mb-2">
            Selecciona un rango para iniciar
          </p>
          <p className="text-sm text-muted-foreground max-w-md">
            Smart Recovery procesa facturas en <strong className="text-white">segundo plano</strong>.
            Puedes cerrar la pestaña y el proceso continuará automáticamente.
          </p>
        </div>
      )}
    </div>
  );
}

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { 
  Rocket, 
  CheckCircle, 
  AlertCircle, 
  Clock, 
  RefreshCw, 
  XCircle,
  CreditCard,
  Users,
  MessageSquare,
  Merge,
  Trash2,
  Play,
  Pause
} from "lucide-react";
import { useSyncQueue, SyncStep, SyncQueueStep } from "@/hooks/useSyncQueue";

const STEP_ICONS: Record<SyncStep, React.ReactNode> = {
  paypal: <CreditCard className="h-4 w-4" />,
  ghl: <Users className="h-4 w-4" />,
  manychat: <MessageSquare className="h-4 w-4" />,
  unify: <Merge className="h-4 w-4" />,
  cleanup: <Trash2 className="h-4 w-4" />,
};

function StepStatusIcon({ status }: { status: SyncQueueStep['status'] }) {
  switch (status) {
    case 'running':
      return <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'error':
      return <AlertCircle className="h-4 w-4 text-red-500" />;
    case 'skipped':
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

function StepBadge({ status }: { status: SyncQueueStep['status'] }) {
  switch (status) {
    case 'running':
      return <Badge className="bg-blue-600 text-xs">En progreso</Badge>;
    case 'completed':
      return <Badge className="bg-green-600 text-xs">Completado</Badge>;
    case 'error':
      return <Badge variant="destructive" className="text-xs">Error</Badge>;
    case 'skipped':
      return <Badge variant="secondary" className="text-xs">Omitido</Badge>;
    default:
      return <Badge variant="outline" className="text-xs">Pendiente</Badge>;
  }
}

function formatDuration(start: Date | null): string {
  if (!start) return '-';
  const seconds = Math.floor((Date.now() - start.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function FullRecoveryPanel() {
  const {
    isRunning,
    currentStep,
    steps,
    overallProgress,
    startedAt,
    estimatedTotalTime,
    startFullRecovery,
    cancelRecovery,
    resetQueue,
  } = useSyncQueue();

  const completedSteps = steps.filter(s => s.status === 'completed').length;
  const hasErrors = steps.some(s => s.status === 'error');
  const isComplete = completedSteps === steps.length && !isRunning;

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-card to-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/20">
              <Rocket className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Recuperación Completa</CardTitle>
              <CardDescription>
                Ejecuta todos los syncs en secuencia óptima
              </CardDescription>
            </div>
          </div>
          {isRunning && (
            <Badge className="bg-blue-600 animate-pulse">
              <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
              Ejecutando
            </Badge>
          )}
          {isComplete && !hasErrors && (
            <Badge className="bg-green-600">
              <CheckCircle className="h-3 w-3 mr-1" />
              Completado
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Overall Progress */}
        {(isRunning || overallProgress > 0) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Progreso total: {completedSteps}/{steps.length} pasos
              </span>
              <span className="font-medium text-primary">{Math.round(overallProgress)}%</span>
            </div>
            <Progress value={overallProgress} className="h-2" />
            {startedAt && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Tiempo transcurrido: {formatDuration(startedAt)}</span>
                <span>Estimado: ~{estimatedTotalTime} min</span>
              </div>
            )}
          </div>
        )}

        <Separator />

        {/* Steps List */}
        <div className="space-y-2">
          {steps.map((step, index) => (
            <div 
              key={step.id}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                step.status === 'running' 
                  ? 'bg-blue-500/10 border-blue-500/30' 
                  : step.status === 'completed'
                  ? 'bg-green-500/10 border-green-500/30'
                  : step.status === 'error'
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-muted/30 border-border/50'
              }`}
            >
              {/* Step Number */}
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                step.status === 'completed' ? 'bg-green-600 text-white' :
                step.status === 'running' ? 'bg-blue-600 text-white' :
                step.status === 'error' ? 'bg-red-600 text-white' :
                'bg-muted text-muted-foreground'
              }`}>
                {step.status === 'completed' ? '✓' : index + 1}
              </div>

              {/* Icon */}
              <div className="text-muted-foreground">
                {STEP_ICONS[step.id]}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{step.label}</span>
                  {step.processed !== undefined && step.processed > 0 && (
                    <span className="text-xs text-muted-foreground">
                      ({step.processed.toLocaleString()} registros)
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {step.error || step.description}
                </p>
              </div>

              {/* Status */}
              <div className="flex items-center gap-2">
                <StepStatusIcon status={step.status} />
                <StepBadge status={step.status} />
              </div>
            </div>
          ))}
        </div>

        <Separator />

        {/* Action Buttons */}
        <div className="flex gap-3">
          {!isRunning && !isComplete ? (
            <Button 
              onClick={startFullRecovery} 
              className="flex-1 bg-primary hover:bg-primary/90"
              size="lg"
            >
              <Play className="h-4 w-4 mr-2" />
              Iniciar Recuperación Completa
            </Button>
          ) : isRunning ? (
            <>
              <Button 
                variant="destructive"
                onClick={cancelRecovery}
                size="lg"
                className="flex-1"
              >
                <Pause className="h-4 w-4 mr-2" />
                Cancelar
              </Button>
            </>
          ) : (
            <Button 
              variant="outline"
              onClick={resetQueue}
              size="lg"
              className="flex-1"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Reiniciar
            </Button>
          )}
        </div>

        {/* Info Text */}
        {!isRunning && !isComplete && (
          <p className="text-xs text-muted-foreground text-center">
            Este proceso sincronizará PayPal → GHL → ManyChat → Unificará identidades → Limpieza
          </p>
        )}
      </CardContent>
    </Card>
  );
}

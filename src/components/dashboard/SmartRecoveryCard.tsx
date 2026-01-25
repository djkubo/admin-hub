import { useState } from "react";
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
  Layers,
  PlayCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  useSmartRecovery, 
  RECOVERY_RANGES, 
  type HoursLookback 
} from "@/hooks/useSmartRecovery";

export function SmartRecoveryCard() {
  const { 
    isRunning, 
    result, 
    selectedRange,
    progress,
    hasPendingResume,
    runRecovery,
    resumeRecovery,
    cancelRecovery,
    dismissPendingResume,
    exportToCSV, 
    clearResult 
  } = useSmartRecovery();
  const [activeTab, setActiveTab] = useState<"succeeded" | "failed" | "skipped">("succeeded");

  const handleRunRecovery = (hours: HoursLookback) => {
    runRecovery(hours, false);
  };

  return (
    <div className="rounded-xl border border-red-500/20 bg-gradient-to-br from-[#1a1f36] to-[#1a1f36]/80 p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-red-500/30 to-orange-500/20">
            <Rocket className="h-6 w-6 text-red-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Smart Recovery</h2>
            <p className="text-sm text-muted-foreground">
              Recuperación automática multi-tarjeta con procesamiento por lotes
            </p>
          </div>
        </div>
        {result && !isRunning && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearResult}
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
                ? "bg-red-600 hover:bg-red-700 text-white border-red-600" 
                : "border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
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

      {/* Loading State with Progress */}
      {isRunning && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="relative">
            <Loader2 className="h-16 w-16 text-red-500 animate-spin" />
            <Zap className="h-6 w-6 text-yellow-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          <p className="mt-4 text-lg font-medium text-white">Ejecutando Smart Recovery...</p>
          
          {/* Progress Info */}
          {progress && (
            <div className="mt-4 w-full max-w-md">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Layers className="h-4 w-4 text-red-400" />
                <span className="text-sm text-muted-foreground">{progress.message}</span>
              </div>
              <Progress value={undefined} className="h-2 bg-red-500/20" />
            </div>
          )}

          {/* Real-time partial results */}
          {result && (
            <div className="mt-4 grid grid-cols-3 gap-4 w-full max-w-lg">
              <div className="text-center p-2 rounded bg-green-500/10">
                <p className="text-lg font-bold text-green-400">
                  ${(result.summary.total_recovered / 100).toFixed(0)}
                </p>
                <p className="text-xs text-muted-foreground">Recuperado</p>
              </div>
              <div className="text-center p-2 rounded bg-red-500/10">
                <p className="text-lg font-bold text-red-400">
                  {result.failed.length}
                </p>
                <p className="text-xs text-muted-foreground">Fallidos</p>
              </div>
              <div className="text-center p-2 rounded bg-amber-500/10">
                <p className="text-lg font-bold text-amber-400">
                  {result.summary.batches_processed}
                </p>
                <p className="text-xs text-muted-foreground">Lotes</p>
              </div>
            </div>
          )}

          {/* Cancel Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={cancelRecovery}
            className="mt-6 border-red-500/50 text-red-400 hover:bg-red-500/10"
          >
            <StopCircle className="h-4 w-4 mr-2" />
            Cancelar (mantener resultados parciales)
          </Button>
        </div>
      )}

      {/* Results */}
      {result && !isRunning && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-5 w-5 text-green-400" />
                <span className="text-sm font-medium text-green-400">Recuperado</span>
              </div>
              <p className="text-2xl font-bold text-green-300">
                ${(result.summary.total_recovered / 100).toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {result.succeeded.length} facturas cobradas
              </p>
            </div>

            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <XCircle className="h-5 w-5 text-red-400" />
                <span className="text-sm font-medium text-red-400">Fallido</span>
              </div>
              <p className="text-2xl font-bold text-red-300">
                ${(result.summary.total_failed_amount / 100).toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {result.failed.length} facturas sin cobrar
              </p>
            </div>

            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <span className="text-sm font-medium text-amber-400">Omitido</span>
              </div>
              <p className="text-2xl font-bold text-amber-300">
                ${(result.summary.total_skipped_amount / 100).toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {result.skipped.length} por suscripción cancelada
              </p>
            </div>

            <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Layers className="h-5 w-5 text-blue-400" />
                <span className="text-sm font-medium text-blue-400">Lotes</span>
              </div>
              <p className="text-2xl font-bold text-blue-300">
                {result.summary.batches_processed}
              </p>
              <p className="text-xs text-muted-foreground">
                {result.summary.total_invoices} facturas procesadas
              </p>
            </div>
          </div>

          {/* Export Button */}
          <div className="mb-4 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              className="gap-2 border-green-500/30 text-green-400 hover:bg-green-500/10"
            >
              <Download className="h-4 w-4" />
              Descargar Reporte CSV
            </Button>
          </div>

          {/* Detailed Results Tabs */}
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList className="grid w-full grid-cols-3 bg-muted/20">
              <TabsTrigger 
                value="succeeded" 
                className="data-[state=active]:bg-green-500/20 data-[state=active]:text-green-400"
              >
                Recuperados ({result.succeeded.length})
              </TabsTrigger>
              <TabsTrigger 
                value="failed"
                className="data-[state=active]:bg-red-500/20 data-[state=active]:text-red-400"
              >
                Fallidos ({result.failed.length})
              </TabsTrigger>
              <TabsTrigger 
                value="skipped"
                className="data-[state=active]:bg-amber-500/20 data-[state=active]:text-amber-400"
              >
                Omitidos ({result.skipped.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="succeeded" className="mt-4">
              {result.succeeded.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No se recuperaron facturas en este rango
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-green-300/80">Invoice</TableHead>
                      <TableHead className="text-green-300/80">Email</TableHead>
                      <TableHead className="text-green-300/80">Monto</TableHead>
                      <TableHead className="text-green-300/80">Método</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.succeeded.map((item) => (
                      <TableRow key={item.invoice_id} className="hover:bg-green-500/5 border-green-500/10">
                        <TableCell className="font-mono text-xs">
                          {item.invoice_id.slice(0, 20)}...
                        </TableCell>
                        <TableCell>{item.customer_email || "N/A"}</TableCell>
                        <TableCell className="font-bold text-green-400">
                          ${(item.amount_recovered / 100).toFixed(2)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="border-green-500/50 text-green-400">
                            {item.payment_method_used}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="failed" className="mt-4">
              {result.failed.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No hubo facturas fallidas 🎉
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-red-300/80">Invoice</TableHead>
                      <TableHead className="text-red-300/80">Email</TableHead>
                      <TableHead className="text-red-300/80">Monto</TableHead>
                      <TableHead className="text-red-300/80">Error</TableHead>
                      <TableHead className="text-red-300/80">Intentos</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.failed.map((item) => (
                      <TableRow key={item.invoice_id} className="hover:bg-red-500/5 border-red-500/10">
                        <TableCell className="font-mono text-xs">
                          {item.invoice_id.slice(0, 20)}...
                        </TableCell>
                        <TableCell>{item.customer_email || "N/A"}</TableCell>
                        <TableCell className="font-bold text-red-400">
                          ${(item.amount_due / 100).toFixed(2)}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                          {item.error}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="border-red-500/50 text-red-400">
                            {item.cards_tried} tarjetas
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="skipped" className="mt-4">
              {result.skipped.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No se omitió ninguna factura
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-amber-300/80">Invoice</TableHead>
                      <TableHead className="text-amber-300/80">Email</TableHead>
                      <TableHead className="text-amber-300/80">Monto</TableHead>
                      <TableHead className="text-amber-300/80">Razón</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.skipped.map((item) => (
                      <TableRow key={item.invoice_id} className="hover:bg-amber-500/5 border-amber-500/10">
                        <TableCell className="font-mono text-xs">
                          {item.invoice_id.slice(0, 20)}...
                        </TableCell>
                        <TableCell>{item.customer_email || "N/A"}</TableCell>
                        <TableCell className="font-bold text-amber-400">
                          ${(item.amount_due / 100).toFixed(2)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="border-amber-500/50 text-amber-400">
                            {item.subscription_status || item.reason}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* Resume Banner */}
      {hasPendingResume && !isRunning && (
        <div className="mb-6 rounded-lg bg-amber-500/10 border border-amber-500/30 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <PlayCircle className="h-6 w-6 text-amber-400" />
              <div>
                <p className="font-medium text-amber-300">
                  Proceso interrumpido - {selectedRange && RECOVERY_RANGES.find(r => r.hours === selectedRange)?.label}
                </p>
                <p className="text-sm text-muted-foreground">
                  Tienes {result?.summary.batches_processed || 0} lotes procesados. Puedes continuar donde te quedaste.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={dismissPendingResume}
                className="text-muted-foreground hover:text-white"
              >
                Descartar
              </Button>
              <Button
                size="sm"
                onClick={resumeRecovery}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                <PlayCircle className="h-4 w-4 mr-2" />
                Reanudar
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!result && !isRunning && !hasPendingResume && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
            <Rocket className="h-8 w-8 text-red-400" />
          </div>
          <p className="text-lg font-medium text-white mb-2">
            Selecciona un rango para iniciar
          </p>
          <p className="text-sm text-muted-foreground max-w-md">
            Smart Recovery procesa facturas en <strong className="text-white">lotes automáticos</strong> de 15 
            para evitar timeouts. Puedes cancelar en cualquier momento y conservar los resultados parciales.
          </p>
        </div>
      )}
    </div>
  );
}

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";

export default function UpdateCardSuccess() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20">
            <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-500" />
          </div>
          <CardTitle>¡Listo!</CardTitle>
          <CardDescription>
            Tu método de pago ha sido actualizado exitosamente. Procesaremos tu próximo cobro con la nueva tarjeta.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="text-center text-sm text-muted-foreground">
            <p>Puedes cerrar esta página de forma segura.</p>
          </div>
          <Button variant="outline" onClick={() => window.close()}>
            Cerrar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

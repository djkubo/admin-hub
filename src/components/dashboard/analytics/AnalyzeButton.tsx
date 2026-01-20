import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";

export function AnalyzeButton() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    setShowSuccess(false);

    try {
      await invokeWithAdminKey("analyze-business", {});

      // Refresh AI insights
      await queryClient.invalidateQueries({ queryKey: ["ai-insights-latest"] });

      setShowSuccess(true);
      toast({
        title: "Análisis completado",
        description: "El Oráculo ha generado un nuevo análisis de tu negocio.",
      });

      // Reset success state after 3 seconds
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (error) {
      console.error("Error analyzing business:", error);
      toast({
        title: "Error al analizar",
        description: error instanceof Error ? error.message : "No se pudo completar el análisis",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <Button
      onClick={handleAnalyze}
      disabled={isAnalyzing}
      className={`gap-2 transition-all ${
        showSuccess
          ? "bg-emerald-500 hover:bg-emerald-600"
          : "bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
      }`}
      size="lg"
    >
      {isAnalyzing ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin" />
          Analizando...
        </>
      ) : showSuccess ? (
        <>
          <CheckCircle2 className="h-5 w-5" />
          ¡Análisis Listo!
        </>
      ) : (
        <>
          <Sparkles className="h-5 w-5" />
          Analizar Ahora
        </>
      )}
    </Button>
  );
}

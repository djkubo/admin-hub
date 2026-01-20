import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export function AnalyzeButton() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const queryClient = useQueryClient();

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    setShowSuccess(false);

    try {
      // Get the current session token
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        throw new Error("No hay sesión activa. Por favor, inicia sesión de nuevo.");
      }

      // Call the edge function directly with fetch for better error handling
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-business`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            'x-admin-key': 'vrp_admin_2026_K8p3dQ7xN2v9Lm5R1s0T4u6Yh8Gf3Jk',
          },
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Refresh AI insights
      await queryClient.invalidateQueries({ queryKey: ["ai-insights-latest"] });

      setShowSuccess(true);
      
      const segmentsCount = data.segments?.length || 0;
      toast.success("Análisis completado", {
        description: `El Oráculo analizó ${segmentsCount} segmentos de tu negocio.`,
      });

      // Reset success state after 3 seconds
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (error) {
      console.error("Error analyzing business:", error);
      
      const errorMessage = error instanceof Error ? error.message : "No se pudo completar el análisis";
      
      toast.error("Error al analizar", {
        description: errorMessage,
        action: {
          label: "Reintentar",
          onClick: handleAnalyze,
        },
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

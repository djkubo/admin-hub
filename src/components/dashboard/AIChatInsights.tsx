import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Clock, Calendar, CalendarDays, History, Loader2, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

type TimeRange = "24h" | "7d" | "30d" | "all";

interface SummaryStats {
  totalMessages: number;
  totalContacts: number;
  totalUserMessages: number;
  leads: number;
  customers: number;
  abandonedLeads: number;
  totalRevenue: number;
  timeRange: string;
}

export default function AIChatInsights() {
  const [selectedRange, setSelectedRange] = useState<TimeRange>("7d");
  const [isLoading, setIsLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [stats, setStats] = useState<SummaryStats | null>(null);
  const { toast } = useToast();

  const timeRanges: { value: TimeRange; label: string; icon: React.ReactNode }[] = [
    { value: "24h", label: "24 Horas", icon: <Clock className="h-3.5 w-3.5" /> },
    { value: "7d", label: "7 Días", icon: <Calendar className="h-3.5 w-3.5" /> },
    { value: "30d", label: "30 Días", icon: <CalendarDays className="h-3.5 w-3.5" /> },
    { value: "all", label: "Histórico", icon: <History className="h-3.5 w-3.5" /> },
  ];

  const handleGenerateReport = async () => {
    setIsLoading(true);
    setSummary(null);
    setStats(null);

    try {
      const { data, error } = await supabase.functions.invoke("generate-chat-summary", {
        body: { timeRange: selectedRange },
      });

      if (error) {
        throw new Error(error.message || "Error al generar reporte");
      }

      if (data.error) {
        throw new Error(data.error);
      }

      setSummary(data.summary);
      setStats(data.stats);
      
      toast({
        title: "🎯 Inteligencia de Ventas Generada",
        description: `Análisis de ${data.stats?.totalContacts || 0} contactos · $${(data.stats?.totalRevenue || 0).toLocaleString()} en revenue`,
      });
    } catch (err) {
      console.error("Error generating report:", err);
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "No se pudo generar el reporte",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Enhanced markdown renderer
  const renderMarkdown = (text: string) => {
    return text
      .split("\n")
      .map((line, i) => {
        // Headers
        if (line.startsWith("## ")) {
          return (
            <h2 key={i} className="text-lg font-bold mt-6 mb-3 pb-2 border-b border-border flex items-center gap-2">
              {line.replace("## ", "")}
            </h2>
          );
        }
        if (line.startsWith("### ")) {
          return (
            <h3 key={i} className="text-md font-semibold mt-4 mb-2">
              {line.replace("### ", "")}
            </h3>
          );
        }
        // Bold sections (like **Objeción #1:**)
        if (line.startsWith("**") && line.includes(":**")) {
          const content = line.replace(/\*\*/g, "");
          return (
            <div key={i} className="font-semibold mt-3 mb-1 text-foreground">
              {content}
            </div>
          );
        }
        // Regular bold text
        if (line.includes("**")) {
          const parts = line.split(/\*\*(.*?)\*\*/g);
          return (
            <p key={i} className="my-1">
              {parts.map((part, j) => (j % 2 === 1 ? <strong key={j} className="text-foreground">{part}</strong> : part))}
            </p>
          );
        }
        // Quote lines (starting with - Ejemplo:)
        if (line.trim().startsWith("- Ejemplo")) {
          return (
            <p key={i} className="ml-4 my-1 text-sm italic text-muted-foreground border-l-2 border-primary/30 pl-3">
              {line.replace("- ", "")}
            </p>
          );
        }
        // Action lines
        if (line.trim().startsWith("- Acción") || line.trim().startsWith("- Impacto")) {
          return (
            <p key={i} className="ml-4 my-1 text-sm text-primary">
              {line.replace("- ", "→ ")}
            </p>
          );
        }
        // Frase ganadora
        if (line.includes("💬 Frase Ganadora")) {
          return (
            <div key={i} className="ml-4 my-2 p-2 bg-green-500/10 border border-green-500/30 rounded text-sm">
              {line}
            </div>
          );
        }
        // List items
        if (line.startsWith("- ") || line.match(/^\d+\.\s/)) {
          return (
            <li key={i} className="ml-4 my-1 text-muted-foreground">
              {line.replace(/^-\s|^\d+\.\s/, "")}
            </li>
          );
        }
        // Horizontal rule
        if (line.startsWith("---")) {
          return <hr key={i} className="my-4 border-border" />;
        }
        // Empty lines
        if (line.trim() === "") {
          return <div key={i} className="h-2" />;
        }
        // Regular paragraph
        return (
          <p key={i} className="my-1 text-muted-foreground">
            {line}
          </p>
        );
      });
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Sales Intelligence
          <span className="text-xs font-normal text-muted-foreground ml-2">
            Powered by Lovable AI
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4 overflow-hidden">
        {/* Time Range Filters */}
        <div className="flex flex-wrap gap-2">
          {timeRanges.map((range) => (
            <Button
              key={range.value}
              variant={selectedRange === range.value ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedRange(range.value)}
              className="gap-1.5"
            >
              {range.icon}
              <span className="hidden sm:inline">{range.label}</span>
              <span className="sm:hidden">{range.value}</span>
            </Button>
          ))}
        </div>

        {/* Generate Button */}
        <Button
          onClick={handleGenerateReport}
          disabled={isLoading}
          size="lg"
          className="w-full gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Analizando conversaciones y ventas...
            </>
          ) : (
            <>
              <TrendingUp className="h-4 w-4" />
              Generar Inteligencia de Ventas
            </>
          )}
        </Button>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="p-3 bg-muted/50 rounded-lg text-center">
              <div className="text-2xl font-bold">{stats.totalContacts}</div>
              <div className="text-xs text-muted-foreground">Contactos</div>
            </div>
            <div className="p-3 bg-blue-500/10 rounded-lg text-center">
              <div className="text-2xl font-bold text-blue-600">{stats.leads}</div>
              <div className="text-xs text-muted-foreground">Leads</div>
            </div>
            <div className="p-3 bg-green-500/10 rounded-lg text-center">
              <div className="text-2xl font-bold text-green-600">{stats.customers}</div>
              <div className="text-xs text-muted-foreground">Clientes</div>
            </div>
            <div className="p-3 bg-primary/10 rounded-lg text-center">
              <div className="text-2xl font-bold text-primary">${stats.totalRevenue.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Revenue</div>
            </div>
          </div>
        )}

        {/* Summary Content */}
        <div className="flex-1 overflow-auto pr-2">
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-10 w-10 animate-spin mb-4" />
              <p className="font-medium">Analizando inteligencia de ventas...</p>
              <p className="text-sm mt-2">Cruzando chat_events con clients</p>
              <p className="text-xs mt-1 opacity-70">Esto puede tomar 10-20 segundos</p>
            </div>
          )}

          {!isLoading && !summary && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <div className="flex gap-4 mb-4">
                <div className="p-3 bg-red-500/10 rounded-full">
                  <span className="text-2xl">🛑</span>
                </div>
                <div className="p-3 bg-green-500/10 rounded-full">
                  <span className="text-2xl">🏆</span>
                </div>
                <div className="p-3 bg-yellow-500/10 rounded-full">
                  <span className="text-2xl">💡</span>
                </div>
              </div>
              <p className="font-medium">Inteligencia de Ventas con IA</p>
              <p className="text-sm mt-2 text-center max-w-md">
                Descubre objeciones de venta, patrones de éxito y oportunidades ocultas cruzando datos de chat con historial de compras.
              </p>
            </div>
          )}

          {!isLoading && summary && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              {renderMarkdown(summary)}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

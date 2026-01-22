import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Clock, Calendar, CalendarDays, History, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

type TimeRange = "24h" | "7d" | "30d" | "all";

interface SummaryStats {
  totalMessages: number;
  totalContacts: number;
  totalUserMessages: number;
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
        title: "Reporte generado",
        description: `Análisis de ${data.stats?.totalContacts || 0} contactos completado.`,
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

  // Simple markdown renderer for the summary
  const renderMarkdown = (text: string) => {
    return text
      .split("\n")
      .map((line, i) => {
        // Headers
        if (line.startsWith("## ")) {
          return (
            <h2 key={i} className="text-lg font-semibold mt-4 mb-2 flex items-center gap-2">
              {line.replace("## ", "")}
            </h2>
          );
        }
        if (line.startsWith("### ")) {
          return (
            <h3 key={i} className="text-md font-medium mt-3 mb-1">
              {line.replace("### ", "")}
            </h3>
          );
        }
        // Bold text
        if (line.includes("**")) {
          const parts = line.split(/\*\*(.*?)\*\*/g);
          return (
            <p key={i} className="my-1">
              {parts.map((part, j) => (j % 2 === 1 ? <strong key={j}>{part}</strong> : part))}
            </p>
          );
        }
        // List items
        if (line.startsWith("- ") || line.match(/^\d+\.\s/)) {
          return (
            <li key={i} className="ml-4 my-0.5">
              {line.replace(/^-\s|^\d+\.\s/, "")}
            </li>
          );
        }
        // Horizontal rule
        if (line.startsWith("---")) {
          return <hr key={i} className="my-3 border-border" />;
        }
        // Empty lines
        if (line.trim() === "") {
          return <br key={i} />;
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
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Chat Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4">
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
          className="w-full gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Analizando conversaciones...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Generar Reporte
            </>
          )}
        </Button>

        {/* Stats Badge */}
        {stats && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 bg-muted rounded-full">
              📨 {stats.totalMessages} mensajes
            </span>
            <span className="px-2 py-1 bg-muted rounded-full">
              👥 {stats.totalContacts} contactos
            </span>
            <span className="px-2 py-1 bg-muted rounded-full">
              💬 {stats.totalUserMessages} de usuarios
            </span>
          </div>
        )}

        {/* Summary Content */}
        <div className="flex-1 overflow-auto">
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin mb-3" />
              <p className="text-sm">Analizando {selectedRange === "all" ? "todo el" : `últimos ${selectedRange}`} historial...</p>
              <p className="text-xs mt-1">Esto puede tomar unos segundos</p>
            </div>
          )}

          {!isLoading && !summary && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Sparkles className="h-8 w-8 mb-3 opacity-50" />
              <p className="text-sm">Selecciona un período y genera el reporte</p>
              <p className="text-xs mt-1">La IA analizará las conversaciones del chat</p>
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

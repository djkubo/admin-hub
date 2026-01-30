import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type HealthStatus = 'loading' | 'healthy' | 'slow' | 'error';

export function SystemHealthIndicator() {
  const [status, setStatus] = useState<HealthStatus>('loading');
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      const start = Date.now();
      try {
        // Simple lightweight query to check database connectivity
        const { error } = await supabase
          .from('sync_runs')
          .select('id', { count: 'exact', head: true })
          .limit(1);

        const elapsed = Date.now() - start;
        setLatency(elapsed);

        if (error) {
          setStatus('error');
        } else if (elapsed > 3000) {
          setStatus('slow');
        } else {
          setStatus('healthy');
        }
      } catch {
        setStatus('error');
        setLatency(null);
      }
    };

    checkHealth();
    // Check every 60 seconds to reduce load
    const interval = setInterval(checkHealth, 60000);
    return () => clearInterval(interval);
  }, []);

  const getStatusDisplay = () => {
    switch (status) {
      case 'loading':
        return {
          icon: <Loader2 className="h-3 w-3 animate-spin" />,
          text: 'Conectando...',
          className: 'bg-zinc-800/50 text-muted-foreground border-zinc-700'
        };
      case 'healthy':
        return {
          icon: <CheckCircle className="h-3 w-3" />,
          text: latency ? `${latency}ms` : 'OK',
          className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
        };
      case 'slow':
        return {
          icon: <AlertTriangle className="h-3 w-3" />,
          text: latency ? `${latency}ms (lento)` : 'Lento',
          className: 'bg-amber-500/10 text-amber-400 border-amber-500/30'
        };
      case 'error':
        return {
          icon: <XCircle className="h-3 w-3" />,
          text: 'Error',
          className: 'bg-red-500/10 text-red-400 border-red-500/30'
        };
    }
  };

  const display = getStatusDisplay();

  return (
    <Badge variant="outline" className={`text-[10px] gap-1 ${display.className}`}>
      {display.icon}
      {display.text}
    </Badge>
  );
}

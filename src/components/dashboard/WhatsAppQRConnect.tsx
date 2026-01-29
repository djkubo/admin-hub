import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Smartphone, Loader2, CheckCircle2, XCircle, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";

const RENDER_API_URL = "https://vrp-bot-1.onrender.com";

interface WhatsAppStatus {
  is_connected: boolean;
  phone_number: string | null;
  qr_code: string | null;
  session_exists: boolean;
}

export function WhatsAppQRConnect() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${RENDER_API_URL}/whatsapp/status`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (error) {
      console.error("Error fetching WhatsApp status:", error);
    }
  }, []);

  // Polling cuando hay QR o está conectando
  useEffect(() => {
    fetchStatus();
    
    const interval = setInterval(() => {
      if (connecting || status?.qr_code) {
        fetchStatus();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [connecting, status?.qr_code, fetchStatus]);

  // Detectar conexión exitosa
  useEffect(() => {
    if (status?.is_connected && connecting) {
      setConnecting(false);
      toast.success("¡WhatsApp conectado exitosamente!");
    }
  }, [status?.is_connected, connecting]);

  const handleConnect = async () => {
    setConnecting(true);
    setLoading(true);
    try {
      const res = await fetch(`${RENDER_API_URL}/whatsapp/connect`, {
        method: "POST",
      });
      if (res.ok) {
        toast.info("Generando código QR...");
        // Polling se encargará de actualizar el estado
      } else {
        throw new Error("Error al conectar");
      }
    } catch (error) {
      toast.error("Error al iniciar conexión");
      setConnecting(false);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${RENDER_API_URL}/whatsapp/disconnect`, {
        method: "POST",
      });
      if (res.ok) {
        setStatus(null);
        toast.success("WhatsApp desconectado");
      }
    } catch (error) {
      toast.error("Error al desconectar");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/10">
              <Smartphone className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <CardTitle className="text-lg">Conexión WhatsApp</CardTitle>
              <CardDescription>
                Conecta tu cuenta personal de WhatsApp
              </CardDescription>
            </div>
          </div>
          
          {status?.is_connected ? (
            <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Conectado
            </Badge>
          ) : status?.qr_code ? (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Esperando escaneo
            </Badge>
          ) : (
            <Badge variant="outline" className="text-zinc-400 border-zinc-700">
              <XCircle className="h-3 w-3 mr-1" />
              Desconectado
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {status?.is_connected ? (
          // Estado conectado
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 rounded-lg bg-zinc-800/50 border border-zinc-700">
              <div>
                <p className="text-sm text-zinc-400">Número conectado</p>
                <p className="text-lg font-medium text-foreground">
                  +{status.phone_number}
                </p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
            
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchStatus}
                className="flex-1"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Actualizar
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDisconnect}
                disabled={loading}
                className="flex-1"
              >
                <Unplug className="h-4 w-4 mr-2" />
                Desconectar
              </Button>
            </div>
          </div>
        ) : status?.qr_code ? (
          // Mostrar QR
          <div className="space-y-4">
            <div className="flex flex-col items-center p-4 rounded-lg bg-white">
              <img
                src={`data:image/png;base64,${status.qr_code}`}
                alt="WhatsApp QR Code"
                className="w-64 h-64"
              />
            </div>
            
            <div className="text-center space-y-2">
              <p className="text-sm text-zinc-400">
                Abre WhatsApp en tu teléfono
              </p>
              <ol className="text-xs text-zinc-500 space-y-1">
                <li>1. Ve a Configuración → Dispositivos vinculados</li>
                <li>2. Toca "Vincular un dispositivo"</li>
                <li>3. Escanea este código QR</li>
              </ol>
            </div>
            
            <Button
              variant="outline"
              size="sm"
              onClick={handleConnect}
              className="w-full"
              disabled={loading}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Generar nuevo QR
            </Button>
          </div>
        ) : (
          // Estado desconectado
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-zinc-800/50 border border-zinc-700 text-center">
              <Smartphone className="h-12 w-12 mx-auto text-zinc-600 mb-3" />
              <p className="text-sm text-zinc-400 mb-1">
                No hay ninguna cuenta de WhatsApp conectada
              </p>
              <p className="text-xs text-zinc-500">
                Conecta tu cuenta para recibir y enviar mensajes directamente
              </p>
            </div>
            
            <Button
              onClick={handleConnect}
              disabled={loading || connecting}
              className="w-full bg-green-600 hover:bg-green-700"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Smartphone className="h-4 w-4 mr-2" />
              )}
              Conectar WhatsApp
            </Button>
          </div>
        )}
        
        <p className="text-xs text-zinc-500 text-center">
          ⚠️ Esta conexión usa la API no oficial de WhatsApp. 
          Úsala con moderación para evitar bloqueos.
        </p>
      </CardContent>
    </Card>
  );
}

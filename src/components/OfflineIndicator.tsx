import { useState, useEffect } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      toast.success('Conexión restaurada', {
        description: 'Ya puedes continuar trabajando normalmente.',
        duration: 3000,
      });
    };

    const handleOffline = () => {
      setIsOnline(false);
      toast.error('Sin conexión a internet', {
        description: 'Algunas funciones pueden no estar disponibles.',
        duration: 5000,
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      // Try to fetch a small resource to check connectivity
      await fetch('/favicon.ico', { cache: 'no-store' });
      // If successful, force refresh
      window.location.reload();
    } catch {
      toast.error('Aún sin conexión', {
        description: 'Por favor verifica tu conexión a internet.',
      });
    } finally {
      setIsRetrying(false);
    }
  };

  if (isOnline) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-destructive text-destructive-foreground px-4 py-2 flex items-center justify-center gap-3 text-sm">
      <WifiOff className="h-4 w-4" />
      <span>Sin conexión a internet</span>
      <Button
        size="sm"
        variant="secondary"
        onClick={handleRetry}
        disabled={isRetrying}
        className="h-7 gap-1.5"
      >
        <RefreshCw className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`} />
        Reintentar
      </Button>
    </div>
  );
}

export function OfflineOverlay() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed inset-0 z-[90] bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-6 h-20 w-20 rounded-full bg-muted flex items-center justify-center">
          <WifiOff className="h-10 w-10 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Sin conexión</h2>
        <p className="text-muted-foreground mb-6">
          Parece que has perdido la conexión a internet. Verifica tu red y vuelve a intentarlo.
        </p>
        <Button
          onClick={() => window.location.reload()}
          className="gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Reintentar conexión
        </Button>
      </div>
    </div>
  );
}

import { Settings, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GHLSettingsPanel } from './GHLSettingsPanel';
import { useAuth } from '@/hooks/useAuth';

interface SettingsPageProps {
  onLogout?: () => void;
}

export function SettingsPage({ onLogout }: SettingsPageProps) {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Settings className="h-8 w-8 text-primary" />
            Ajustes
          </h1>
          <p className="text-muted-foreground mt-1">
            Configuración e integraciones del sistema
          </p>
        </div>
        {user && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user.email}</span>
            <Button variant="outline" size="sm" onClick={onLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              Cerrar Sesión
            </Button>
          </div>
        )}
      </div>

      {/* GHL Integration */}
      <GHLSettingsPanel />
    </div>
  );
}

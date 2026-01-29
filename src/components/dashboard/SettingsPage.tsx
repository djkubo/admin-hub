import { Settings, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GHLSettingsPanel } from './GHLSettingsPanel';
import { IntegrationsStatusPanel } from './IntegrationsStatusPanel';
import { SystemTogglesPanel } from './SystemTogglesPanel';
import { useAuth } from '@/hooks/useAuth';

interface SettingsPageProps {
  onLogout?: () => void;
}

export function SettingsPage({ onLogout }: SettingsPageProps) {
  const { user } = useAuth();

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2 md:gap-3">
            <Settings className="h-6 w-6 md:h-8 md:w-8 text-primary" />
            Ajustes
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            Configuración e integraciones
          </p>
        </div>
        {user && (
          <div className="flex items-center gap-3 justify-between sm:justify-end">
            <span className="text-xs md:text-sm text-muted-foreground truncate max-w-[150px] md:max-w-none">{user.email}</span>
            <Button variant="outline" size="sm" onClick={onLogout} className="gap-2 touch-feedback shrink-0">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Cerrar Sesión</span>
              <span className="sm:hidden">Salir</span>
            </Button>
          </div>
        )}
      </div>

      {/* System Toggles - New */}
      <SystemTogglesPanel />

      {/* Integrations Status - New */}
      <IntegrationsStatusPanel />

      {/* GHL Integration - Existing */}
      <GHLSettingsPanel />
    </div>
  );
}

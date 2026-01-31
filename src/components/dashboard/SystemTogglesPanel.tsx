import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Settings2, Loader2, Save, Bell, Pause, Clock, Building } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface SystemSettings {
  auto_dunning_enabled: boolean;
  sync_paused: boolean;
  ghl_paused: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  company_name: string;
  timezone: string;
}

const defaultSettings: SystemSettings = {
  auto_dunning_enabled: true,
  sync_paused: false,
  ghl_paused: false,
  quiet_hours_start: '21:00',
  quiet_hours_end: '08:00',
  company_name: '',
  timezone: 'America/Mexico_City',
};

const timezones = [
  { value: 'America/Mexico_City', label: 'Ciudad de México (CST)' },
  { value: 'America/New_York', label: 'Nueva York (EST)' },
  { value: 'America/Los_Angeles', label: 'Los Ángeles (PST)' },
  { value: 'America/Chicago', label: 'Chicago (CST)' },
  { value: 'America/Bogota', label: 'Bogotá (COT)' },
  { value: 'America/Lima', label: 'Lima (PET)' },
  { value: 'America/Buenos_Aires', label: 'Buenos Aires (ART)' },
  { value: 'Europe/Madrid', label: 'Madrid (CET)' },
  { value: 'UTC', label: 'UTC' },
];

// Skeleton de carga para mejor UX
function SettingsSkeleton() {
  return (
    <Card className="card-base">
      <CardHeader className="pb-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64 mt-2" />
      </CardHeader>
      <CardContent className="space-y-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/30">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-5 rounded" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
            <Skeleton className="h-6 w-12 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function SystemTogglesPanel() {
  const [settings, setSettings] = useState<SystemSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('key, value');

      if (error) throw error;

      const loaded = { ...defaultSettings };
      for (const row of data || []) {
        if (row.key in loaded) {
          const value = row.value;
          if (row.key === 'auto_dunning_enabled' || row.key === 'sync_paused' || row.key === 'ghl_paused') {
            (loaded as Record<string, boolean | string>)[row.key] = value === 'true';
          } else {
            (loaded as Record<string, boolean | string>)[row.key] = value || '';
          }
        }
      }

      setSettings(loaded);
    } catch (error) {
      console.error('Error loading settings:', error);
      toast.error('Error cargando configuración');
    } finally {
      setIsLoading(false);
    }
  };

  const saveSettings = async () => {
    setIsSaving(true);
    try {
      const entries = Object.entries(settings).map(([key, value]) => ({
        key,
        value: String(value),
        updated_at: new Date().toISOString(),
      }));

      for (const entry of entries) {
        const { error } = await supabase
          .from('system_settings')
          .upsert(entry, { onConflict: 'key' });

        if (error) throw error;
      }

      toast.success('Configuración guardada');
      setHasChanges(false);
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Error guardando configuración');
    } finally {
      setIsSaving(false);
    }
  };

  const updateSetting = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  if (isLoading) {
    return <SettingsSkeleton />;
  }

  return (
    <Card className="card-base">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          Configuración del Sistema
        </CardTitle>
        <CardDescription>
          Controles globales de la aplicación
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Auto Dunning Toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/30">
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-zinc-400" />
            <div>
              <Label className="font-medium">Auto-Dunning</Label>
              <p className="text-xs text-muted-foreground">
                Envía recordatorios automáticos de pago
              </p>
            </div>
          </div>
          <Switch
            checked={settings.auto_dunning_enabled}
            onCheckedChange={(checked) => updateSetting('auto_dunning_enabled', checked)}
          />
        </div>

        {/* Sync Paused Toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/30">
          <div className="flex items-center gap-3">
            <Pause className="h-5 w-5 text-zinc-400" />
            <div>
              <Label className="font-medium">Pausar Sincronización</Label>
              <p className="text-xs text-muted-foreground">
                Detiene todas las sincronizaciones automáticas
              </p>
            </div>
          </div>
          <Switch
            checked={settings.sync_paused}
            onCheckedChange={(checked) => updateSetting('sync_paused', checked)}
          />
        </div>

        {/* GHL Paused Toggle - EMERGENCY KILL SWITCH */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-destructive/10 border border-destructive/30">
          <div className="flex items-center gap-3">
            <Pause className="h-5 w-5 text-destructive" />
            <div>
              <Label className="font-medium text-destructive">🛑 Pausar GoHighLevel</Label>
              <p className="text-xs text-muted-foreground">
                Detiene TODOS los webhooks y syncs de GHL
              </p>
            </div>
          </div>
          <Switch
            checked={settings.ghl_paused}
            onCheckedChange={(checked) => updateSetting('ghl_paused', checked)}
          />
        </div>

        {/* Quiet Hours */}
        <div className="p-3 rounded-lg bg-muted/30 border border-border/30 space-y-3">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-zinc-400" />
            <div>
              <Label className="font-medium">Horario Silencioso</Label>
              <p className="text-xs text-muted-foreground">
                No enviar mensajes en este rango
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-8">
            <Input
              type="time"
              value={settings.quiet_hours_start}
              onChange={(e) => updateSetting('quiet_hours_start', e.target.value)}
              className="w-28 input-base"
            />
            <span className="text-muted-foreground">—</span>
            <Input
              type="time"
              value={settings.quiet_hours_end}
              onChange={(e) => updateSetting('quiet_hours_end', e.target.value)}
              className="w-28 input-base"
            />
          </div>
        </div>

        {/* Company Name */}
        <div className="p-3 rounded-lg bg-muted/30 border border-border/30 space-y-3">
          <div className="flex items-center gap-3">
            <Building className="h-5 w-5 text-zinc-400" />
            <div>
              <Label className="font-medium">Nombre de Empresa</Label>
              <p className="text-xs text-muted-foreground">
                Se usa en mensajes y reportes
              </p>
            </div>
          </div>
          <Input
            value={settings.company_name}
            onChange={(e) => updateSetting('company_name', e.target.value)}
            placeholder="Mi Empresa S.A."
            className="ml-8 w-auto input-base"
          />
        </div>

        {/* Timezone */}
        <div className="p-3 rounded-lg bg-muted/30 border border-border/30 space-y-3">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-zinc-400" />
            <div>
              <Label className="font-medium">Zona Horaria</Label>
              <p className="text-xs text-muted-foreground">
                Para reportes y métricas
              </p>
            </div>
          </div>
          <Select
            value={settings.timezone}
            onValueChange={(value) => updateSetting('timezone', value)}
          >
            <SelectTrigger className="ml-8 w-64 input-base">
              <SelectValue placeholder="Selecciona zona horaria" />
            </SelectTrigger>
            <SelectContent>
              {timezones.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Save Button */}
        <div className="flex justify-end pt-2">
          <Button
            onClick={saveSettings}
            disabled={!hasChanges || isSaving}
            className="btn-primary gap-2"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Guardar Cambios
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Named export for backwards compatibility
export { SystemTogglesPanel };

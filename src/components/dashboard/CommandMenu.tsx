import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LogOut, Shield, Upload } from "lucide-react";

import { APP_PATHS } from "@/config/appPaths";
import { NAVIGATION_GROUPS } from "@/config/appNavigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout?: () => void;
};

export function CommandMenu({ open, onOpenChange, onLogout }: Props) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isK = e.key.toLowerCase() === "k";
      if (!isK) return;
      if (!e.metaKey && !e.ctrlKey) return;

      e.preventDefault();
      onOpenChange(!open);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const go = (path: string) => {
    onOpenChange(false);
    if (location.pathname !== path) navigate(path);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Buscar secciones o acciones…" />
      <CommandList>
        <CommandEmpty>No hay resultados.</CommandEmpty>

        <CommandGroup heading="Acciones">
          <CommandItem value="sync importar sincronizar" onSelect={() => go(APP_PATHS.sync)}>
            <Upload className="mr-2 h-4 w-4" />
            <span>Ir a Importar / Sincronizar</span>
          </CommandItem>
          <CommandItem value="diagnostico reparar pwa cache" onSelect={() => go(APP_PATHS.diagnostics)}>
            <Shield className="mr-2 h-4 w-4" />
            <span>Ir a Diagnóstico</span>
          </CommandItem>
          {onLogout && (
            <CommandItem value="cerrar sesion logout" onSelect={onLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              <span>Cerrar sesión</span>
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        {NAVIGATION_GROUPS.map((group) => (
          <CommandGroup key={group.id} heading={group.label}>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.id}
                  value={`${group.label} ${item.label}`}
                  onSelect={() => go(item.path)}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <span>{item.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

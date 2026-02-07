import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/sonner";

// Dynamically import PWA register to avoid build errors when vite-plugin-pwa isn't active
let registerSW: ((options: {
  immediate?: boolean;
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: Error) => void;
}) => (reloadPage?: boolean) => Promise<void>) | undefined;

try {
  // @ts-ignore - virtual module from vite-plugin-pwa
  registerSW = (await import("virtual:pwa-register")).registerSW;
} catch {
  // PWA plugin not active, skip registration
}

export function PwaUpdater() {
  const shownNeedRefresh = useRef(false);
  const shownOfflineReady = useRef(false);
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!registerSW) return;

    let updateCheckInterval: number | undefined;

    const updateSW = registerSW({
      immediate: true,
      onRegistered(registration) {
        if (!registration) return;
        // Proactively check for updates (helps when users keep tabs open for hours).
        registration.update().catch(() => {});
        updateCheckInterval = window.setInterval(() => {
          registration.update().catch(() => {});
        }, 30 * 60 * 1000);
      },
      onNeedRefresh() {
        if (shownNeedRefresh.current) return;
        shownNeedRefresh.current = true;

        toast("Nueva versión disponible", {
          description: "Actualiza para aplicar mejoras y correcciones.",
          action: {
            label: "Actualizar ahora",
            onClick: () => void updateSWRef.current?.(true),
          },
          duration: Infinity,
        });
      },
      onOfflineReady() {
        if (shownOfflineReady.current) return;
        shownOfflineReady.current = true;

        toast("Modo sin conexión listo", {
          description: "La app quedó cacheada en tu dispositivo.",
          duration: 4000,
        });
      },
      onRegisterError(error) {
        console.error("[PWA] Error registrando Service Worker", error);
      },
    });

    updateSWRef.current = updateSW;

    return () => {
      if (updateCheckInterval) window.clearInterval(updateCheckInterval);
    };
  }, []);

  return null;
}


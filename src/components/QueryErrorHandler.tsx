import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { refreshSessionLocked } from '@/lib/authSession';
import { formatUnknownError } from '@/lib/errorUtils';

// Friendly error messages for common scenarios
const getErrorMessage = (error: unknown): { title: string; description: string } => {
  // Use a longer, detail-rich string for classification, but keep user-facing text short.
  const errorMessage = formatUnknownError(error, { maxLen: 800, includeDetails: true });
  const lowerMessage = errorMessage.toLowerCase();

  // Network errors
  if (lowerMessage.includes('fetch') || lowerMessage.includes('network') || lowerMessage.includes('load failed')) {
    return {
      title: 'Error de conexión',
      description: 'No se pudo conectar con el servidor. Verifica tu conexión a internet.',
    };
  }

  // Timeout errors
  if (lowerMessage.includes('timeout') || lowerMessage.includes('aborted')) {
    return {
      title: 'Tiempo de espera agotado',
      description: 'La operación tardó demasiado. Por favor, inténtalo de nuevo.',
    };
  }

  // Auth errors
  if (lowerMessage.includes('unauthorized') || lowerMessage.includes('401') || lowerMessage.includes('jwt')) {
    return {
      title: 'Sesión expirada',
      description: 'Tu sesión ha expirado. Por favor, inicia sesión nuevamente.',
    };
  }

  // Permission errors
  if (lowerMessage.includes('forbidden') || lowerMessage.includes('403') || lowerMessage.includes('rls')) {
    return {
      title: 'Acceso denegado',
      description: 'No tienes permisos para realizar esta acción.',
    };
  }

  // Not found
  if (lowerMessage.includes('not found') || lowerMessage.includes('404')) {
    return {
      title: 'No encontrado',
      description: 'El recurso solicitado no existe o fue eliminado.',
    };
  }

  // Server errors
  if (lowerMessage.includes('500') || lowerMessage.includes('internal server')) {
    return {
      title: 'Error del servidor',
      description: 'Ocurrió un error en el servidor. Nuestro equipo ha sido notificado.',
    };
  }

  // Default
  return {
    title: 'Error inesperado',
    // Don't hide the message just because it's long; truncate it for the toast.
    // Also avoid leaking deep details by default.
    description: formatUnknownError(error, {
      fallback: 'Ocurrió un problema. Por favor, inténtalo de nuevo.',
      maxLen: 180,
      includeDetails: false,
    }),
  };
};

export function QueryErrorHandler() {
  const queryClient = useQueryClient();
  const lastToastAt = useRef<Record<string, number>>({});
  const lastAuthRecoveryAtMs = useRef(0);

  useEffect(() => {
    // Global error handler for React Query
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.state.status === 'error') {
        const error = event.query.state.error;
        if (import.meta.env.DEV) {
          // Helpful for identifying which query is failing without spamming users with raw errors.
          // eslint-disable-next-line no-console
          console.error('[react-query] error', { queryKey: event.query.queryKey, error });
        }
        // Only show toast for queries that don't have their own error handling
        const meta = event.query.options.meta as { suppressErrorToast?: boolean } | undefined;
        if (!meta?.suppressErrorToast) {
          const errorMessage = formatUnknownError(error, { maxLen: 400, includeDetails: true });
          const lowerMessage = errorMessage.toLowerCase();

          // Helper: simple per-title throttle to avoid toast spam.
          const now = Date.now();
          const key = lowerMessage.includes('jwt') || lowerMessage.includes('401') ? 'auth' : getErrorMessage(error).title;
          const last = lastToastAt.current[key] ?? 0;
          if (now - last < 6_000) return;
          lastToastAt.current[key] = now;

          // Auth errors: try a best-effort recovery before forcing re-login.
          if (lowerMessage.includes('unauthorized') || lowerMessage.includes('401') || lowerMessage.includes('jwt')) {
            if (now - lastAuthRecoveryAtMs.current > 30_000) {
              lastAuthRecoveryAtMs.current = now;

              refreshSessionLocked()
                .then((session) => {
                  if (session) {
                    toast.success('Sesión revalidada', {
                      description: 'Tu sesión se recuperó automáticamente. Reintentando…',
                      duration: 4000,
                    });
                    queryClient.invalidateQueries();
                    return;
                  }

                  toast.error('Sesión expirada', {
                    description: navigator.onLine
                      ? 'No se pudo revalidar automáticamente. Reintenta o inicia sesión.'
                      : 'Parece que no hay conexión. En cuanto vuelvas a estar online, reintentamos.',
                    duration: 10_000,
                    action: {
                      label: 'Reintentar',
                      onClick: () => {
                        refreshSessionLocked()
                          .then((s) => {
                            if (s) queryClient.invalidateQueries();
                          })
                          .catch(() => {});
                      },
                    },
                  });
                })
                .catch(() => {
                  toast.error('Sesión expirada', {
                    description: navigator.onLine
                      ? 'No se pudo revalidar automáticamente. Reintenta o inicia sesión.'
                      : 'Parece que no hay conexión. En cuanto vuelvas a estar online, reintentamos.',
                    duration: 10_000,
                    action: {
                      label: 'Reintentar',
                      onClick: () => {
                        refreshSessionLocked()
                          .then((s) => {
                            if (s) queryClient.invalidateQueries();
                          })
                          .catch(() => {});
                      },
                    },
                  });
                });

              return;
            }

            toast.error('Sesión expirada', {
              description: navigator.onLine
                ? 'Reintenta. Si sigue fallando, inicia sesión de nuevo.'
                : 'Sin conexión. Reintenta cuando vuelvas a estar online.',
              duration: 10_000,
              action: {
                label: 'Reintentar',
                onClick: () => {
                  refreshSessionLocked()
                    .then((s) => {
                      if (s) queryClient.invalidateQueries();
                    })
                    .catch(() => {});
                },
              },
            });
            return;
          }

          const { title, description } = getErrorMessage(error);
          toast.error(title, { description, duration: 5000 });
        }
      }
    });

    return () => unsubscribe();
  }, [queryClient]);

  return null;
}

// Export the error message utility for use in components
export { getErrorMessage };

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

// Friendly error messages for common scenarios
const getErrorMessage = (error: unknown): { title: string; description: string } => {
  const errorMessage = error instanceof Error ? error.message : String(error);
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
    description: errorMessage.length > 100 ? 'Ocurrió un problema. Por favor, inténtalo de nuevo.' : errorMessage,
  };
};

export function QueryErrorHandler() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Global error handler for React Query
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.state.status === 'error') {
        const error = event.query.state.error;
        // Only show toast for queries that don't have their own error handling
        const meta = event.query.options.meta as { suppressErrorToast?: boolean } | undefined;
        if (!meta?.suppressErrorToast) {
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

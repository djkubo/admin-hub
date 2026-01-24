import { supabase } from "@/integrations/supabase/client";

/**
 * SECURE: No hardcoded API keys. Uses authenticated Supabase session.
 * Edge functions verify JWT + is_admin() server-side.
 */

/**
 * Generic wrapper for invoking Edge Functions with type safety.
 * Uses the active Supabase session JWT for authentication.
 * 
 * @template T - Response type (defaults to Record<string, unknown> for compatibility)
 * @template B - Body type (defaults to Record<string, unknown>)
 */
export async function invokeWithAdminKey<
  T = Record<string, unknown>,
  B extends Record<string, unknown> = Record<string, unknown>
>(
  functionName: string,
  body?: B
): Promise<T> {
  // Get current session - the SDK automatically includes the JWT in requests
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    throw new Error('No hay sesión activa. Por favor, inicia sesión.');
  }

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    // JWT is automatically included via the session
  });

  if (error) {
    throw error;
  }

  return data as T;
}

// Helper to get admin headers (for compatibility - now just returns empty since JWT is automatic)
export const getAdminHeaders = (): Record<string, string> => {
  return {
    'Content-Type': 'application/json',
  };
};

export default invokeWithAdminKey;

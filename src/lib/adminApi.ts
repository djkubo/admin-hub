import { supabase } from "@/integrations/supabase/client";

/**
 * SECURE: No hardcoded API keys. Uses authenticated Supabase session.
 * Edge functions verify JWT + is_admin() server-side.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const invokeWithAdminKey = async (
  functionName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
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

  return data;
};

// Helper to get admin headers (for compatibility - now just returns empty since JWT is automatic)
export const getAdminHeaders = (): Record<string, string> => {
  return {
    'Content-Type': 'application/json',
  };
};

export default invokeWithAdminKey;

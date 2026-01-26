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
): Promise<T | null> {
  try {
    console.log(`[AdminAPI] Invoking ${functionName}`, body ? 'with body' : 'without body');
    
    // Get current session - the SDK automatically includes the JWT in requests
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError) {
      console.error('[AdminAPI] Session error:', sessionError);
      return { success: false, error: `Session error: ${sessionError.message}` } as T;
    }
    
    if (!session) {
      console.error('[AdminAPI] No active session');
      return { success: false, error: 'No active session. Please log in again.' } as T;
    }

    // SOLUCIÓN: Pasar explícitamente el Authorization header
    console.log(`[AdminAPI] Session valid, token length: ${session.access_token.length}`);
    
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: {
        Authorization: `Bearer ${session.access_token}`
      }
    });

    console.log(`[AdminAPI] ${functionName} response:`, {
      hasData: !!data,
      hasError: !!error,
      errorMessage: error?.message,
      dataKeys: data ? Object.keys(data) : [],
      dataType: data ? typeof data : 'null',
      dataOk: (data as any)?.ok,
      dataSuccess: (data as any)?.success
    });

    if (error) {
      console.error(`[AdminAPI] ${functionName} error:`, error);
      // Return the error as part of the response instead of throwing
      return { ok: false, success: false, error: error.message } as T;
    }

    // Edge Functions return { ok: true, result } or { ok: false, error }
    // Return as-is so frontend can handle both formats
    return data as T;
  } catch (e) {
    console.error(`[AdminAPI] ${functionName} fatal:`, e);
    return { success: false, error: e instanceof Error ? e.message : 'Unknown error' } as T;
  }
}

// Helper to get admin headers (for compatibility - now just returns empty since JWT is automatic)
export const getAdminHeaders = (): Record<string, string> => {
  return {
    'Content-Type': 'application/json',
  };
};

export default invokeWithAdminKey;

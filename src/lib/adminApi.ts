import { supabase } from "@/integrations/supabase/client";
import { getValidSession } from "@/lib/authSession";

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

    // Important: avoid aggressive refreshSession() calls to prevent refresh-token rotation races.
    // Only refresh if the session is missing or expiring soon.
    const session = await getValidSession({ refreshIfExpiringWithinMs: 60_000 });

    if (!session) {
      console.error('[AdminAPI] No active session');
      return { success: false, error: 'No active session. Please log in again.' } as T;
    }
    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
    console.log(`[AdminAPI] Session valid, token length: ${session.access_token.length}, expires: ${new Date(expiresAt).toISOString()}`);
    
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

      // Supabase functions-js wraps non-2xx responses as FunctionsHttpError with a Response in `context`.
      // Surfacing status + JSON body here makes the UI actionable (e.g. 404 "function not found").
      const ctx = (error as any)?.context as unknown;
      const status = typeof (ctx as any)?.status === "number" ? ((ctx as any).status as number) : null;
      let ctxBody: any = null;
      if (ctx && typeof (ctx as any)?.text === "function") {
        try {
          const res: Response =
            typeof (ctx as any)?.clone === "function" ? ((ctx as any).clone() as Response) : (ctx as Response);
          const text = await res.text();
          try {
            ctxBody = JSON.parse(text);
          } catch {
            ctxBody = text;
          }
        } catch {
          // ignore parsing errors
        }
      }
      
      // Handle 504 Gateway Timeout specifically
      if (error.message?.includes('504') || error.message?.includes('timeout') || error.message?.includes('Timeout')) {
        console.warn(`[AdminAPI] ${functionName} timeout detected - sync continues in background`);
        return { 
          ok: true, 
          success: true, 
          status: 'background',
          message: 'La sincronización continúa en segundo plano. Por favor espera unos minutos y refresca la página.',
          backgroundProcessing: true
        } as T;
      }
      
      // Return the error as part of the response instead of throwing
      const baseMsg = error.message || "Edge Function error";

      // Prefer platform-provided JSON error details when available.
      const detailMsg =
        typeof ctxBody === "object" && ctxBody
          ? (ctxBody.error as string) || (ctxBody.message as string) || null
          : typeof ctxBody === "string"
            ? ctxBody
            : null;

      // Make common cases obvious in the UI.
      let msg = baseMsg;
      if (status === 404) {
        msg = `Edge Function "${functionName}" no existe (404). Debes desplegarla en Supabase/Lovable Cloud.`;
      } else if (status === 401 || status === 403) {
        msg = `No autorizado (HTTP ${status}) al invocar "${functionName}". Revisa sesión y permisos admin.`;
      } else if (typeof status === "number") {
        msg = `${baseMsg} (HTTP ${status})`;
      }
      if (detailMsg && detailMsg !== baseMsg) {
        msg = `${msg} ${detailMsg}`;
      }

      return { ok: false, success: false, error: msg } as T;
    }

    // Edge Functions return { ok: true, result } or { ok: false, error }
    // Return as-is so frontend can handle both formats
    return data as T;
  } catch (e) {
    console.error(`[AdminAPI] ${functionName} fatal:`, e);
    
    // Handle network timeouts and 504s in catch block too
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    if (errorMessage.includes('504') || errorMessage.includes('timeout') || errorMessage.includes('Timeout') || errorMessage.includes('network')) {
      return { 
        ok: true, 
        success: true, 
        status: 'background',
        message: 'La sincronización continúa en segundo plano. Por favor espera unos minutos y refresca la página.',
        backgroundProcessing: true
      } as T;
    }
    
    return { success: false, error: errorMessage } as T;
  }
}

// Helper to get admin headers (for compatibility - now just returns empty since JWT is automatic)
export const getAdminHeaders = (): Record<string, string> => {
  return {
    'Content-Type': 'application/json',
  };
};

export default invokeWithAdminKey;

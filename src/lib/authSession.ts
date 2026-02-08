import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";

let refreshInFlight: Promise<Session | null> | null = null;
let lastRefreshAtMs = 0;

function isSessionExpiringSoon(session: Session, withinMs: number): boolean {
  const expiresAtMs = session.expires_at ? session.expires_at * 1000 : 0;
  if (!expiresAtMs) return false;
  return expiresAtMs - Date.now() <= withinMs;
}

async function withCrossTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  // Use the Web Locks API when available to avoid refresh-token rotation races across tabs.
  // If unsupported (e.g. some Safari versions) fall back to best-effort in-tab locking.
  const locks = (globalThis as any)?.navigator?.locks as
    | { request?: (name: string, options: any, callback: () => Promise<T>) => Promise<T> }
    | undefined;

  if (locks?.request) {
    try {
      return await locks.request(name, { mode: "exclusive" }, fn);
    } catch {
      // Ignore lock failures and proceed without cross-tab coordination.
    }
  }
  return fn();
}

export async function getSessionSafe(): Promise<Session | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    return data.session ?? null;
  } catch {
    return null;
  }
}

/**
 * Refreshes the current session, but avoids multiple concurrent refreshes which can
 * cause refresh-token rotation races (and unintended sign-outs).
 */
export async function refreshSessionLocked(opts?: { minIntervalMs?: number }): Promise<Session | null> {
  const minIntervalMs = opts?.minIntervalMs ?? 15_000;

  // Avoid hammering refresh if multiple call sites try to recover at once.
  if (Date.now() - lastRefreshAtMs < minIntervalMs) {
    return getSessionSafe();
  }

  if (!refreshInFlight) {
    refreshInFlight = withCrossTabLock("vrp:supabase-refresh-session", async () => {
      try {
        // Another tab may have refreshed while we waited for the lock. Re-check first.
        const existing = await getSessionSafe();
        if (existing && !isSessionExpiringSoon(existing, 60_000)) {
          lastRefreshAtMs = Date.now();
          return existing;
        }

        const { data, error } = await supabase.auth.refreshSession();
        if (error) return null;
        lastRefreshAtMs = Date.now();
        return data.session ?? null;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    });
  }

  return refreshInFlight;
}

/**
 * Returns a session and refreshes only when needed (missing session or expiring soon).
 */
export async function getValidSession(opts?: {
  refreshIfExpiringWithinMs?: number;
}): Promise<Session | null> {
  const refreshIfExpiringWithinMs = opts?.refreshIfExpiringWithinMs ?? 2 * 60 * 1000;

  const session = await getSessionSafe();
  if (!session) {
    return refreshSessionLocked();
  }

  if (isSessionExpiringSoon(session, refreshIfExpiringWithinMs)) {
    return (await refreshSessionLocked()) ?? session;
  }

  return session;
}

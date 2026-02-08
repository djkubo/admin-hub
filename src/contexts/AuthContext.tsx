import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { User, Session } from "@supabase/supabase-js";
import { getValidSession, refreshSessionLocked } from "@/lib/authSession";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<{ error: Error | null }>;
  refreshSession: () => Promise<boolean>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  
  // Use ref to track session for interval/visibility without triggering re-renders
  const sessionRef = useRef<Session | null>(null);

  // Session refresh function to prevent expiration
  const refreshSession = useCallback(async () => {
    try {
      const nextSession = await refreshSessionLocked();
      if (nextSession) {
        sessionRef.current = nextSession;
        setSession(nextSession);
        setUser(nextSession.user);
        return true;
      }
      return false;
    } catch (e) {
      console.error('[Auth] Session refresh failed:', e);
      return false;
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const initializeAuth = async () => {
      try {
        // Check for an existing session FIRST before setting up listener.
        // Use a safe refresh path to avoid false "logged out" states when access token expired.
        const existingSession = await getValidSession({ refreshIfExpiringWithinMs: 10 * 60 * 1000 });

        if (mounted) {
          console.log('[Auth] Initial session check:', existingSession ? 'Found session' : 'No session');
          sessionRef.current = existingSession;
          setSession(existingSession);
          setUser(existingSession?.user ?? null);
          setIsInitialized(true);
          setLoading(false);
        }
      } catch (e) {
        console.error('[Auth] Initialization error:', e);
        if (mounted) {
          setIsInitialized(true);
          setLoading(false);
        }
      }
    };

    // Initialize immediately
    initializeAuth();

    // Set up auth state listener for subsequent changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, newSession) => {
        if (!mounted) return;
        
        console.log('[Auth] State change event:', event);
        
        // CRITICAL: Only accept SIGNED_OUT if it's an explicit user action
        // This prevents edge function errors or network issues from logging out the user
        if (event === 'SIGNED_OUT') {
          // Check if we still have a valid session in storage
          supabase.auth.getSession().then(async ({ data: { session: storedSession } }) => {
            if (storedSession) {
              // We still have a session! Don't log out - this was likely a spurious event
              console.log('[Auth] SIGNED_OUT event ignored - session still valid in storage');
              sessionRef.current = storedSession;
              setSession(storedSession);
              setUser(storedSession.user);
              return;
            }

            const current = sessionRef.current;
            if (!current) {
              // Only log out if we truly have no session anywhere.
              console.log('[Auth] SIGNED_OUT confirmed - no session found');
              sessionRef.current = null;
              setSession(null);
              setUser(null);
              return;
            }

            // If we still have a valid access token in memory, keep the user signed in.
            // (This avoids “random” logouts due to refresh races / flaky network.)
            const expiresAtMs = current.expires_at ? current.expires_at * 1000 : 0;
            if (expiresAtMs && expiresAtMs - Date.now() > 60_000) {
              console.log('[Auth] SIGNED_OUT ignored - access token still valid');
              setSession(current);
              setUser(current.user);
              return;
            }

            // We had a session ref but storage is empty - try to recover before giving up.
            console.log('[Auth] SIGNED_OUT with stale ref - attempting recovery');
            const recovered = await refreshSessionLocked();
            if (recovered) {
              console.log('[Auth] Session recovered after SIGNED_OUT event');
              sessionRef.current = recovered;
              setSession(recovered);
              setUser(recovered.user);
              return;
            }

            sessionRef.current = null;
            setSession(null);
            setUser(null);
          });
          return; // Don't process SIGNED_OUT normally
        }
        
        // For all other events, update state normally
        sessionRef.current = newSession;
        setSession(newSession);
        setUser(newSession?.user ?? null);
        
        // Ensure loading is false after any auth event
        if (isInitialized) {
          setLoading(false);
        }
      }
    );

    // Refresh on visibility change (when user returns to tab after being away)
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        // Best-effort recovery when returning to the app.
        // (No sign-out here; SIGNED_OUT handler will decide.)
        const nextSession = await getValidSession({ refreshIfExpiringWithinMs: 10 * 60 * 1000 });
        if (nextSession) {
          sessionRef.current = nextSession;
          setSession(nextSession);
          setUser(nextSession.user);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Periodic refresh while the tab is visible.
    // With `autoRefreshToken: false` on the Supabase client, we need a single place that
    // refreshes safely (locked) to avoid random logouts from token-rotation races.
    const intervalId = window.setInterval(() => {
      if (!mounted) return;
      if (document.visibilityState !== 'visible') return;

      getValidSession({ refreshIfExpiringWithinMs: 10 * 60 * 1000 }).then((nextSession) => {
        if (!mounted) return;
        if (nextSession) {
          sessionRef.current = nextSession;
          setSession(nextSession);
          setUser(nextSession.user);
        }
      });
    }, 5 * 60 * 1000);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, []); // Empty dependencies - run once on mount

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error };
  };

  const signUp = async (email: string, password: string) => {
    const redirectUrl = `${window.location.origin}/`;
    
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
      },
    });
    return { error };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  };

  const value: AuthContextValue = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    refreshSession,
    isAuthenticated: !!session,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}

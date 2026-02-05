import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { User, Session } from "@supabase/supabase-js";

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
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        console.error('[Auth] Session refresh error:', error);
        return false;
      }
      if (data.session) {
        sessionRef.current = data.session;
        setSession(data.session);
        setUser(data.session.user);
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
        // Check for existing session FIRST before setting up listener
        const { data: { session: existingSession }, error } = await supabase.auth.getSession();
        
        if (error) {
          console.error('[Auth] Error getting session:', error);
        }

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
          supabase.auth.getSession().then(({ data: { session: storedSession } }) => {
            if (storedSession) {
              // We still have a session! Don't log out - this was likely a spurious event
              console.log('[Auth] SIGNED_OUT event ignored - session still valid in storage');
              sessionRef.current = storedSession;
              setSession(storedSession);
              setUser(storedSession.user);
            } else if (!sessionRef.current) {
              // Only log out if we truly have no session anywhere
              console.log('[Auth] SIGNED_OUT confirmed - no session found');
              sessionRef.current = null;
              setSession(null);
              setUser(null);
            } else {
              // We had a session ref but storage is empty - try to recover before giving up
              console.log('[Auth] SIGNED_OUT with stale ref - attempting recovery');
              supabase.auth.refreshSession().then(({ data }) => {
                if (data.session) {
                  console.log('[Auth] Session recovered after SIGNED_OUT event');
                  sessionRef.current = data.session;
                  setSession(data.session);
                  setUser(data.session.user);
                } else {
                  // Truly logged out
                  sessionRef.current = null;
                  setSession(null);
                  setUser(null);
                }
              }).catch(() => {
                sessionRef.current = null;
                setSession(null);
                setUser(null);
              });
            }
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

    // Auto-refresh session every 5 minutes to prevent expiration
    const refreshInterval = setInterval(() => {
      if (sessionRef.current) {
        console.log('[Auth] Auto-refresh interval triggered');
        supabase.auth.refreshSession().catch(console.error);
      }
    }, 5 * 60 * 1000); // 5 minutes (more aggressive)

    // Refresh on visibility change (when user returns to tab after being away)
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        // Always try to recover session when tab becomes visible
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        if (currentSession) {
          console.log('[Auth] Tab visible - session exists, refreshing');
          sessionRef.current = currentSession;
          setSession(currentSession);
          setUser(currentSession.user);
          // Refresh to extend the session
          supabase.auth.refreshSession().catch(console.error);
        } else if (sessionRef.current) {
          // Had session but lost it - try to recover
          console.log('[Auth] Tab visible - attempting session recovery');
          const { data } = await supabase.auth.refreshSession();
          if (data.session) {
            sessionRef.current = data.session;
            setSession(data.session);
            setUser(data.session.user);
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also refresh on window focus
    const handleFocus = () => {
      if (sessionRef.current) {
        supabase.auth.refreshSession().catch(console.error);
      }
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      clearInterval(refreshInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
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

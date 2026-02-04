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
        
        // Only update state after initialization to prevent race conditions
        sessionRef.current = newSession;
        setSession(newSession);
        setUser(newSession?.user ?? null);
        
        // Ensure loading is false after any auth event
        if (isInitialized) {
          setLoading(false);
        }
      }
    );

    // Auto-refresh session every 10 minutes to prevent expiration
    const refreshInterval = setInterval(() => {
      if (sessionRef.current) {
        console.log('[Auth] Auto-refresh interval triggered');
        supabase.auth.refreshSession();
      }
    }, 10 * 60 * 1000); // 10 minutes

    // Also refresh on visibility change (when user returns to tab)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && sessionRef.current) {
        console.log('[Auth] Tab visible - refreshing session');
        supabase.auth.refreshSession();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      clearInterval(refreshInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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

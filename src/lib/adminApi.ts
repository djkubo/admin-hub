import { supabase } from "@/integrations/supabase/client";

// Admin API key for internal edge functions
const ADMIN_API_KEY = 'vrp_admin_2026_K8p3dQ7xN2v9Lm5R1s0T4u6Yh8Gf3Jk';

// Get admin key
const getAdminKey = (): string => {
  return import.meta.env.VITE_ADMIN_API_KEY || ADMIN_API_KEY;
};

// Helper to create headers with admin key
export const getAdminHeaders = (): Record<string, string> => {
  const adminKey = getAdminKey();
  return {
    'x-admin-key': adminKey,
    'Content-Type': 'application/json',
  };
};

// Invoke edge function with admin key
export const invokeWithAdminKey = async (
  functionName: string,
  body?: Record<string, unknown>
) => {
  const adminKey = getAdminKey();
  
  if (!adminKey) {
    throw new Error('ADMIN_API_KEY not configured. Add VITE_ADMIN_API_KEY to your environment.');
  }

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    headers: {
      'x-admin-key': adminKey,
    },
  });

  if (error) {
    throw error;
  }

  return data;
};

export default invokeWithAdminKey;

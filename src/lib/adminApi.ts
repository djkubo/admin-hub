import { supabase } from "@/integrations/supabase/client";

// Get admin key from environment or prompt user
const getAdminKey = (): string => {
  // In production, this should come from a secure source
  // For now, we'll use a placeholder that the admin needs to configure
  return import.meta.env.VITE_ADMIN_API_KEY || '';
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

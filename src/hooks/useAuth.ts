// Re-export from AuthContext for backward compatibility
// All components should use this hook which now uses the shared context
export { useAuthContext as useAuth } from "@/contexts/AuthContext";

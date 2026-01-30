import { Suspense, lazy, useState, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import ErrorBoundary from "@/components/ErrorBoundary";
import { OfflineBanner } from "@/components/OfflineIndicator";
import { QueryErrorHandler } from "@/components/QueryErrorHandler";
import { DashboardLayout } from "@/layouts/DashboardLayout";
import { Skeleton } from "@/components/ui/skeleton";

// Pages - eager load critical auth pages
import Login from "./pages/Login";
import Install from "./pages/Install";
import UpdateCard from "./pages/UpdateCard";
import UpdateCardSuccess from "./pages/UpdateCardSuccess";
import NotFound from "./pages/NotFound";

// Dashboard pages - eager load core pages only
import { DashboardHome } from "@/components/dashboard/DashboardHome";
import { ClientsPage } from "@/components/dashboard/ClientsPage";
import { InvoicesPage } from "@/components/dashboard/InvoicesPage";
import { SubscriptionsPage } from "@/components/dashboard/SubscriptionsPage";
import { RevenueOpsPipeline } from "@/components/dashboard/RevenueOpsPipeline";
import { ImportSyncPage } from "@/components/dashboard/ImportSyncPage";
import { SettingsPage } from "@/components/dashboard/SettingsPage";
import { WhatsAppSettingsPage } from "@/components/dashboard/WhatsAppSettingsPage";
import MessagesPageWrapper from "@/components/dashboard/MessagesPageWrapper";

// Lazy load heavy pages with large dependencies
const MovementsPage = lazy(() => 
  import("@/components/dashboard/MovementsPage").then(m => ({ default: m.MovementsPage }))
);
const CampaignControlCenter = lazy(() => 
  import("@/components/dashboard/CampaignControlCenter").then(m => ({ default: m.CampaignControlCenter }))
);
const FlowsPage = lazy(() => 
  import("@/components/dashboard/FlowsPage").then(m => ({ default: m.FlowsPage }))
);
const BroadcastListsPage = lazy(() => 
  import("@/components/broadcast/BroadcastListsPage").then(m => ({ default: m.BroadcastListsPage }))
);
const DiagnosticsPanel = lazy(() => 
  import("@/components/dashboard/DiagnosticsPanel")
);
const AnalyticsPanel = lazy(() => 
  import("@/components/dashboard/analytics/AnalyticsPanel").then(m => ({ default: m.AnalyticsPanel }))
);

// Generic loading skeleton for lazy-loaded pages
const PageSkeleton = () => (
  <div className="space-y-6 p-6">
    <Skeleton className="h-10 w-48" />
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Skeleton className="h-28" />
      <Skeleton className="h-28" />
      <Skeleton className="h-28" />
    </div>
    <Skeleton className="h-64" />
  </div>
);

// Optimized QueryClient for performance and stability
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry on auth errors
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (message.includes('unauthorized') || message.includes('401') || message.includes('jwt')) {
          return false;
        }
        // Max 2 retries for other errors
        return failureCount < 2;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
      staleTime: 60000, // 60 seconds - reduces redundant fetches
      gcTime: 300000, // 5 minutes garbage collection
      refetchOnWindowFocus: false, // Prevent saturation on tab switch
      refetchOnReconnect: true, // Refresh when back online
    },
    mutations: {
      retry: 1,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center safe-area-top safe-area-bottom">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Cargando...</p>
        </div>
      </div>
    );
  }
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center safe-area-top safe-area-bottom">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Cargando...</p>
        </div>
      </div>
    );
  }
  
  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }
  
  return <>{children}</>;
}

// Deferred components - loaded after initial mount for faster FCP
function DeferredComponents() {
  const [mounted, setMounted] = useState(false);
  
  useEffect(() => {
    // Defer non-critical components to after first paint
    const timer = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(timer);
  }, []);

  if (!mounted) return null;

  return (
    <>
      <Toaster />
      <Sonner />
      <OfflineBanner />
      <QueryErrorHandler />
    </>
  );
}

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DeferredComponents />
        <BrowserRouter>
          <Routes>
            {/* Protected Dashboard Routes */}
            <Route 
              element={
                <ProtectedRoute>
                  <ErrorBoundary>
                    <DashboardLayout />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardHome />} />
              <Route path="movements" element={
                <Suspense fallback={<PageSkeleton />}>
                  <MovementsPage />
                </Suspense>
              } />
              <Route path="analytics" element={
                <Suspense fallback={<PageSkeleton />}>
                  <AnalyticsPanel />
                </Suspense>
              } />
              <Route path="messages" element={<MessagesPageWrapper />} />
              <Route path="campaigns" element={
                <Suspense fallback={<PageSkeleton />}>
                  <CampaignControlCenter />
                </Suspense>
              } />
              <Route path="broadcast" element={
                <Suspense fallback={<PageSkeleton />}>
                  <BroadcastListsPage />
                </Suspense>
              } />
              <Route path="flows" element={
                <Suspense fallback={<PageSkeleton />}>
                  <FlowsPage />
                </Suspense>
              } />
              <Route path="whatsapp" element={<WhatsAppSettingsPage />} />
              <Route path="clients" element={<ClientsPage />} />
              <Route path="invoices" element={<InvoicesPage />} />
              <Route path="subscriptions" element={<SubscriptionsPage />} />
              <Route path="recovery" element={<RevenueOpsPipeline />} />
              <Route path="import" element={<ImportSyncPage />} />
              <Route path="diagnostics" element={
                <Suspense fallback={<PageSkeleton />}>
                  <DiagnosticsPanel />
                </Suspense>
              } />
              <Route path="settings" element={<SettingsPage />} />
            </Route>

            {/* Public Routes */}
            <Route 
              path="/login" 
              element={
                <PublicRoute>
                  <ErrorBoundary>
                    <Login />
                  </ErrorBoundary>
                </PublicRoute>
              } 
            />
            <Route path="/install" element={<Install />} />
            <Route path="/update-card" element={<UpdateCard />} />
            <Route path="/update-card/success" element={<UpdateCardSuccess />} />
            
            {/* Catch-all */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;

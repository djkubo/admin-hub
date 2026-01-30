import { useState, useEffect, lazy, Suspense } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { DashboardHome } from "@/components/dashboard/DashboardHome";

import { InvoicesPage } from "@/components/dashboard/InvoicesPage";
import { ClientsPage } from "@/components/dashboard/ClientsPage";
import { SubscriptionsPage } from "@/components/dashboard/SubscriptionsPage";
import { ImportSyncPage } from "@/components/dashboard/ImportSyncPage";
import { SettingsPage } from "@/components/dashboard/SettingsPage";
import { RevenueOpsPipeline } from "@/components/dashboard/RevenueOpsPipeline";
import { CampaignControlCenter } from "@/components/dashboard/CampaignControlCenter";
import { FlowsPage } from "@/components/dashboard/FlowsPage";
import { BroadcastListsPage } from "@/components/broadcast/BroadcastListsPage";
import { WhatsAppSettingsPage } from "@/components/dashboard/WhatsAppSettingsPage";
import SyncCenter from "@/components/dashboard/SyncCenter";
import DiagnosticsPanel from "@/components/dashboard/DiagnosticsPanel";
import MessagesPageWrapper from "@/components/dashboard/MessagesPageWrapper";
import { SyncStatusBanner } from "@/components/dashboard/SyncStatusBanner";
import { MovementsPage } from "@/components/dashboard/MovementsPage";
import { useAuth } from "@/hooks/useAuth";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

// Lazy load heavy analytics page
const AnalyticsPanel = lazy(() => import("@/components/dashboard/analytics/AnalyticsPanel").then(m => ({ default: m.AnalyticsPanel })));

const AnalyticsSkeleton = () => (
  <div className="space-y-6">
    <Skeleton className="h-12 w-64" />
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
    <Skeleton className="h-64" />
  </div>
);

const Index = () => {
  const [activeMenuItem, setActiveMenuItem] = useState("dashboard");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  
  const { signOut, user } = useAuth();
  const { toast } = useToast();

  // Fetch last sync on mount and subscribe to changes
  useEffect(() => {
    const fetchLastSync = async () => {
      const { data } = await supabase
        .from('sync_runs')
        .select('completed_at')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (data?.completed_at) {
        setLastSync(new Date(data.completed_at));
      }
    };

    fetchLastSync();

    // Subscribe to sync_runs changes for real-time updates
    const channel = supabase
      .channel('sync-status')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'sync_runs' },
        (payload) => {
          if (payload.eventType === 'UPDATE' && (payload.new as any).status === 'completed') {
            setLastSync(new Date((payload.new as any).completed_at));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleLogout = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: "Error al cerrar sesión",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const renderContent = () => {
    switch (activeMenuItem) {
      case "dashboard":
        return <DashboardHome lastSync={lastSync} onNavigate={setActiveMenuItem} />;
      case "movements":
        return <MovementsPage />;
      case "messages":
        return <MessagesPageWrapper />;
      case "recovery":
        return <RevenueOpsPipeline />;
      case "invoices":
        return <InvoicesPage />;
      case "clients":
        return <ClientsPage />;
      case "subscriptions":
        return <SubscriptionsPage />;
      case "import":
        return <ImportSyncPage />;
      case "campaigns":
        return <CampaignControlCenter />;
      case "flows":
        return <FlowsPage />;
      case "broadcast":
        return <BroadcastListsPage />;
      case "whatsapp-direct":
        return <WhatsAppSettingsPage />;
      case "sync-center":
        return <SyncCenter />;
      case "diagnostics":
        return <DiagnosticsPanel />;
      case "analytics":
        return (
          <Suspense fallback={<AnalyticsSkeleton />}>
            <AnalyticsPanel />
          </Suspense>
        );
      case "settings":
        return <SettingsPage onLogout={handleLogout} />;
      default:
        return <DashboardHome lastSync={lastSync} onNavigate={setActiveMenuItem} />;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Sidebar activeItem={activeMenuItem} onItemClick={setActiveMenuItem} />
      
      {/* Main content with responsive padding */}
      <main className="md:pl-64 pt-14 md:pt-0">
        <div className="p-4 md:p-8 safe-area-bottom">
          {renderContent()}
        </div>
      </main>

      {/* Persistent sync status banner */}
      <SyncStatusBanner />
    </div>
  );
};

export default Index;

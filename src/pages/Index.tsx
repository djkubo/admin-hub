import { useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { DashboardHome } from "@/components/dashboard/DashboardHome";
import { RecoveryPage } from "@/components/dashboard/RecoveryPage";
import { InvoicesPage } from "@/components/dashboard/InvoicesPage";
import { ClientsPage } from "@/components/dashboard/ClientsPage";
import { SubscriptionsPage } from "@/components/dashboard/SubscriptionsPage";
import { ImportSyncPage } from "@/components/dashboard/ImportSyncPage";
import { AnalyticsPanel } from "@/components/dashboard/analytics/AnalyticsPanel";
import { SettingsPage } from "@/components/dashboard/SettingsPage";
import { RevenueOpsPipeline } from "@/components/dashboard/RevenueOpsPipeline";
import { CampaignControlCenter } from "@/components/dashboard/CampaignControlCenter";
import SyncCenter from "@/components/dashboard/SyncCenter";
import DiagnosticsPanel from "@/components/dashboard/DiagnosticsPanel";
import MessagesPage from "@/components/dashboard/MessagesPage";
import { SyncStatusBanner } from "@/components/dashboard/SyncStatusBanner";
import { useClients } from "@/hooks/useClients";
import { useTransactions } from "@/hooks/useTransactions";
import { useAuth } from "@/hooks/useAuth";
import { BarChart3, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
const Index = () => {
  const [activeMenuItem, setActiveMenuItem] = useState("dashboard");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  
  const { clients } = useClients();
  const { transactions } = useTransactions();
  const { signOut, user } = useAuth();
  const { toast } = useToast();

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
      case "messages":
        return <MessagesPage />;
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
      case "sync-center":
        return <SyncCenter />;
      case "diagnostics":
        return <DiagnosticsPanel />;
      case "analytics":
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                  <BarChart3 className="h-8 w-8 text-primary" />
                  Analytics
                </h1>
                <p className="text-muted-foreground mt-1">
                  Métricas avanzadas: LTV, MRR, Cohortes
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground">{user?.email}</span>
                <Button variant="outline" size="sm" onClick={handleLogout} className="gap-2">
                  <LogOut className="h-4 w-4" />
                  Salir
                </Button>
              </div>
            </div>
            <AnalyticsPanel transactions={transactions} clients={clients} />
          </div>
        );
      case "settings":
        return <SettingsPage onLogout={handleLogout} />;
      default:
        return <DashboardHome lastSync={lastSync} onNavigate={setActiveMenuItem} />;
    }
  };

  return (
    <div className="min-h-screen bg-[#0f1225]">
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent pointer-events-none" />
      
      <Sidebar activeItem={activeMenuItem} onItemClick={setActiveMenuItem} />
      
      <main className="pl-64">
        <div className="p-8">
          {renderContent()}
        </div>
      </main>

      {/* Persistent sync status banner */}
      <SyncStatusBanner />
    </div>
  );
};

export default Index;

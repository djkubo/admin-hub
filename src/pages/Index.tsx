import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Header } from "@/components/dashboard/Header";
import { StatsCard } from "@/components/dashboard/StatsCard";
import { ClientsTable } from "@/components/dashboard/ClientsTable";
import { TransactionsTable } from "@/components/dashboard/TransactionsTable";
import { AddClientDialog } from "@/components/dashboard/AddClientDialog";
import { CSVUploader } from "@/components/dashboard/CSVUploader";
import { APISyncPanel } from "@/components/dashboard/APISyncPanel";
import { MetricsCards } from "@/components/dashboard/MetricsCards";
import { RecoveryTable } from "@/components/dashboard/RecoveryTable";
import { AnalyticsPanel } from "@/components/dashboard/analytics/AnalyticsPanel";
import { AIInsightsWidget } from "@/components/dashboard/AIInsightsWidget";
import { PendingInvoicesTable } from "@/components/dashboard/PendingInvoicesTable";
import { SmartRecoveryCard } from "@/components/dashboard/SmartRecoveryCard";
import { useClients } from "@/hooks/useClients";
import { useTransactions } from "@/hooks/useTransactions";
import { useMetrics } from "@/hooks/useMetrics";
import { useInvoices } from "@/hooks/useInvoices";
import { useAuth } from "@/hooks/useAuth";
import { Users, UserCheck, UserX, Clock, LogOut, BarChart3 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const Index = () => {
  const queryClient = useQueryClient();
  const [activeMenuItem, setActiveMenuItem] = useState("dashboard");
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  
  const { clients, isLoading, addClient, deleteClient, refetch: refetchClients, totalCount, page, setPage, totalPages, vipOnly, setVipOnly, isVip } = useClients();
  const { transactions, isLoading: isLoadingTransactions, syncStripe, refetch: refetchTransactions } = useTransactions();
  const { metrics, isLoading: _isLoadingMetrics, refetch: refetchMetrics } = useMetrics();
  const { 
    invoices, 
    isLoading: isLoadingInvoices, 
    syncInvoices, 
    totalPending, 
    totalNext72h, 
    invoicesNext72h 
  } = useInvoices();
  const { signOut, user } = useAuth();
  const { toast } = useToast();

  const stats = useMemo(() => {
    // Use totalCount from the count query (not clients.length which is just current page)
    const total = totalCount;
    // For active/pending/inactive, we show from current page as approximation
    // In production, you'd want separate count queries for each status
    const active = clients.filter(c => c.status?.toLowerCase() === "active").length;
    const pending = clients.filter(c => c.status?.toLowerCase() === "pending").length;
    const inactive = clients.filter(c => c.status?.toLowerCase() === "inactive").length;
    
    return { total, active, pending, inactive };
  }, [clients, totalCount]);

  const filteredClients = useMemo(() => {
    if (!searchQuery) return clients;
    
    const query = searchQuery.toLowerCase();
    return clients.filter(
      (client) =>
        client.full_name?.toLowerCase().includes(query) ||
        client.email?.toLowerCase().includes(query) ||
        client.phone?.toLowerCase().includes(query)
    );
  }, [clients, searchQuery]);

  const handleAddClient = (clientData: {
    email: string | null;
    phone: string | null;
    full_name: string | null;
    status: string;
  }) => {
    addClient.mutate(clientData, {
      onSuccess: () => setIsAddDialogOpen(false),
    });
  };

  // Build recovery data for ClientsTable
  const recoveryEmails = useMemo(() => {
    return new Set(metrics.recoveryList.map(r => r.email));
  }, [metrics.recoveryList]);

  const recoveryAmounts = useMemo(() => {
    const amounts: Record<string, number> = {};
    for (const r of metrics.recoveryList) {
      amounts[r.email] = r.amount;
    }
    return amounts;
  }, [metrics.recoveryList]);

  const handleProcessingComplete = () => {
    // Force invalidate ALL related queries to ensure fresh data
    queryClient.invalidateQueries({ queryKey: ["clients"] });
    queryClient.invalidateQueries({ queryKey: ["clients-count"] });
    queryClient.invalidateQueries({ queryKey: ["transactions"] });
    queryClient.invalidateQueries({ queryKey: ["metrics"] });
    
    // Also call refetch for immediate update
    refetchClients();
    refetchTransactions();
    refetchMetrics();
  };

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

  // Render Analytics view
  const renderAnalyticsView = () => (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <BarChart3 className="h-8 w-8 text-primary" />
            Analytics
          </h1>
          <p className="text-muted-foreground mt-1">
            Métricas avanzadas estilo ChartMogul - LTV, MRR, Cohortes y más
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

      {/* Full Analytics Panel */}
      <AnalyticsPanel transactions={transactions} clients={clients} />
    </div>
  );

  // Render Dashboard view (existing content)
  const renderDashboardView = () => (
    <div className="space-y-6">
      {/* User info and logout */}
      <div className="flex items-center justify-between">
        <Header
          title="Dashboard"
          subtitle="Gestiona tus clientes y monitorea el estado de tu SaaS"
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          onAddClient={() => setIsAddDialogOpen(true)}
          onSyncData={() => syncStripe.mutate()}
          isSyncing={syncStripe.isPending}
        />
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {user?.email}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            className="gap-2"
          >
            <LogOut className="h-4 w-4" />
            Salir
          </Button>
        </div>
      </div>

      {/* KPI Metrics Cards with Incoming Revenue */}
      <MetricsCards 
        metrics={metrics} 
        invoiceData={{
          totalNext72h,
          totalPending,
          invoiceCount: invoicesNext72h.length,
          isLoading: isLoadingInvoices,
        }}
      />

      {/* Pending Invoices Table - Cash Flow */}
      <PendingInvoicesTable
        invoices={invoices}
        isLoading={isLoadingInvoices}
        onSync={() => syncInvoices.mutate()}
        isSyncing={syncInvoices.isPending}
      />

      {/* Smart Recovery - Herramienta ofensiva de recuperación */}
      <SmartRecoveryCard />

      {/* AI Insights Widget - El Oráculo */}
      <AIInsightsWidget />

      {/* API Sync Panel - Direct from Stripe/PayPal APIs */}
      <APISyncPanel />

      {/* CSV Uploader - Manual import */}
      <CSVUploader onProcessingComplete={handleProcessingComplete} />

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          title="Total Clientes"
          value={stats.total}
          change="+12% desde el mes pasado"
          changeType="positive"
          icon={Users}
        />
        <StatsCard
          title="Clientes Activos"
          value={stats.active}
          change={`${stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0}% del total`}
          changeType="positive"
          icon={UserCheck}
        />
        <StatsCard
          title="Pendientes"
          value={stats.pending}
          change="Requieren atención"
          changeType="neutral"
          icon={Clock}
        />
        <StatsCard
          title="Inactivos"
          value={stats.inactive}
          change="Sin actividad reciente"
          changeType="negative"
          icon={UserX}
        />
      </div>

      {/* Recovery Table - CRM Action Table */}
      <RecoveryTable clients={metrics.recoveryList} />

      {/* Tabs for Data Tables */}
      <Tabs defaultValue="clients" className="space-y-4">
        <TabsList className="bg-[#1a1f36] border border-gray-700/50">
          <TabsTrigger value="clients" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            Clientes
          </TabsTrigger>
          <TabsTrigger value="transactions" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            Transacciones
          </TabsTrigger>
        </TabsList>

        <TabsContent value="clients">
          <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Clientes Recientes</h2>
              <p className="text-sm text-gray-400">
                {filteredClients.length} {filteredClients.length === 1 ? "cliente" : "clientes"}
              </p>
            </div>
            <ClientsTable
              clients={filteredClients}
              isLoading={isLoading}
              onDelete={(id) => deleteClient.mutate(id)}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              recoveryEmails={recoveryEmails}
              recoveryAmounts={recoveryAmounts}
              vipOnly={vipOnly}
              onVipOnlyChange={setVipOnly}
              isVip={isVip}
            />
          </div>
        </TabsContent>

        <TabsContent value="transactions">
          <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Todas las Transacciones</h2>
              <p className="text-sm text-gray-400">
                {transactions.length} {transactions.length === 1 ? "transacción" : "transacciones"}
              </p>
            </div>
            <TransactionsTable
              transactions={transactions}
              isLoading={isLoadingTransactions}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );

  // Render Clients view
  const renderClientsView = () => (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Users className="h-8 w-8 text-primary" />
            Clientes
          </h1>
          <p className="text-muted-foreground mt-1">
            Gestiona todos tus clientes en un solo lugar
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Button onClick={() => setIsAddDialogOpen(true)} className="gap-2">
            <Users className="h-4 w-4" />
            Agregar Cliente
          </Button>
          <span className="text-sm text-muted-foreground">{user?.email}</span>
          <Button variant="outline" size="sm" onClick={handleLogout} className="gap-2">
            <LogOut className="h-4 w-4" />
            Salir
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Todos los Clientes</h2>
          <p className="text-sm text-gray-400">
            {totalCount} {totalCount === 1 ? "cliente" : "clientes"} en total
          </p>
        </div>
        <ClientsTable
          clients={clients}
          isLoading={isLoading}
          onDelete={(id) => deleteClient.mutate(id)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          recoveryEmails={recoveryEmails}
          recoveryAmounts={recoveryAmounts}
          vipOnly={vipOnly}
          onVipOnlyChange={setVipOnly}
          isVip={isVip}
        />
      </div>
    </div>
  );

  // Main render based on active menu item
  const renderContent = () => {
    switch (activeMenuItem) {
      case "analytics":
        return renderAnalyticsView();
      case "clients":
        return renderClientsView();
      case "dashboard":
      default:
        return renderDashboardView();
    }
  };

  return (
    <div className="min-h-screen bg-[#0f1225]">
      {/* Background glow effect */}
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent pointer-events-none" />
      
      <Sidebar activeItem={activeMenuItem} onItemClick={setActiveMenuItem} />
      
      <main className="pl-64">
        <div className="p-8">
          {renderContent()}
        </div>
      </main>

      <AddClientDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onAdd={handleAddClient}
        isLoading={addClient.isPending}
      />
    </div>
  );
};

export default Index;

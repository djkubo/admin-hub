import { useState, useMemo } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Header } from "@/components/dashboard/Header";
import { StatsCard } from "@/components/dashboard/StatsCard";
import { ClientsTable } from "@/components/dashboard/ClientsTable";
import { TransactionsTable } from "@/components/dashboard/TransactionsTable";
import { AddClientDialog } from "@/components/dashboard/AddClientDialog";
import { CSVUploader } from "@/components/dashboard/CSVUploader";
import { MetricsCards } from "@/components/dashboard/MetricsCards";
import { RecoveryTable } from "@/components/dashboard/RecoveryTable";
import { useClients } from "@/hooks/useClients";
import { useTransactions } from "@/hooks/useTransactions";
import { useMetrics } from "@/hooks/useMetrics";
import { Users, UserCheck, UserX, Clock, AlertTriangle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const Index = () => {
  const [activeMenuItem, setActiveMenuItem] = useState("dashboard");
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  
  const { clients, isLoading, addClient, deleteClient, refetch: refetchClients } = useClients();
  const { transactions, isLoading: isLoadingTransactions, syncStripe, refetch: refetchTransactions } = useTransactions();
  const { metrics, isLoading: isLoadingMetrics, refetch: refetchMetrics } = useMetrics();

  const stats = useMemo(() => {
    const total = clients.length;
    const active = clients.filter(c => c.status?.toLowerCase() === "active").length;
    const pending = clients.filter(c => c.status?.toLowerCase() === "pending").length;
    const inactive = clients.filter(c => c.status?.toLowerCase() === "inactive").length;
    
    return { total, active, pending, inactive };
  }, [clients]);

  const filteredClients = useMemo(() => {
    if (!searchQuery) return clients;
    
    const query = searchQuery.toLowerCase();
    return clients.filter(
      (client) =>
        client.full_name?.toLowerCase().includes(query) ||
        client.email.toLowerCase().includes(query) ||
        client.phone?.toLowerCase().includes(query)
    );
  }, [clients, searchQuery]);

  const handleAddClient = (clientData: {
    email: string;
    phone: string;
    full_name: string;
    status: string;
  }) => {
    addClient.mutate(clientData, {
      onSuccess: () => setIsAddDialogOpen(false),
    });
  };

  const handleProcessingComplete = () => {
    refetchClients();
    refetchTransactions();
    refetchMetrics();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Background glow effect */}
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent pointer-events-none" />
      
      <Sidebar activeItem={activeMenuItem} onItemClick={setActiveMenuItem} />
      
      <main className="pl-64">
        <div className="p-8 space-y-8">
          <Header
            title="Dashboard"
            subtitle="Gestiona tus clientes y monitorea el estado de tu SaaS"
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            onAddClient={() => setIsAddDialogOpen(true)}
            onSyncData={() => syncStripe.mutate()}
            isSyncing={syncStripe.isPending}
          />

          {/* Metrics Cards */}
          <MetricsCards
            salesToday={metrics.salesToday}
            conversionRate={metrics.conversionRate}
            trialCount={metrics.trialCount}
            convertedCount={metrics.convertedCount}
          />

          {/* CSV Uploader */}
          <CSVUploader onProcessingComplete={handleProcessingComplete} />

          {/* Stats Grid */}
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
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

          {/* Tabs for Tables */}
          <Tabs defaultValue="clients" className="space-y-4">
            <TabsList>
              <TabsTrigger value="clients">Clientes</TabsTrigger>
              <TabsTrigger value="transactions">Transacciones</TabsTrigger>
              <TabsTrigger value="recovery">Recuperación</TabsTrigger>
            </TabsList>

            <TabsContent value="clients">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">Clientes Recientes</h2>
                <p className="text-sm text-muted-foreground">
                  {filteredClients.length} {filteredClients.length === 1 ? "cliente" : "clientes"}
                </p>
              </div>
              <ClientsTable
                clients={filteredClients}
                isLoading={isLoading}
                onDelete={(email) => deleteClient.mutate(email)}
              />
            </TabsContent>

            <TabsContent value="transactions">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  <h2 className="text-lg font-semibold text-foreground">Pagos Fallidos</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  {transactions.length} {transactions.length === 1 ? "transacción" : "transacciones"}
                </p>
              </div>
              <TransactionsTable
                transactions={transactions}
                isLoading={isLoadingTransactions}
              />
            </TabsContent>

            <TabsContent value="recovery">
              <RecoveryTable clients={metrics.recoveryList} />
            </TabsContent>
          </Tabs>
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

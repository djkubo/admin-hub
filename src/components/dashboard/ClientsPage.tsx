import { useState, useMemo } from 'react';
import { Users, Search, Crown, Phone, LogOut, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ClientsTable } from './ClientsTable';
import { CustomerDrawer } from './CustomerDrawer';
import { AddClientDialog } from './AddClientDialog';
import { useClients, Client } from '@/hooks/useClients';
import { useMetrics } from '@/hooks/useMetrics';

type ClientFilter = 'all' | 'active' | 'trial' | 'past_due' | 'canceled' | 'vip' | 'no_phone';

export function ClientsPage() {
  const { 
    clients, 
    isLoading, 
    addClient, 
    deleteClient, 
    totalCount, 
    page, 
    setPage, 
    totalPages,
    vipOnly,
    setVipOnly,
    isVip
  } = useClients();
  const { metrics } = useMetrics();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ClientFilter>('all');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const VIP_THRESHOLD = 100000; // $1,000 USD in cents

  // Build recovery data
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

  // Filter clients
  const filteredClients = useMemo(() => {
    let result = clients;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (client: Client) =>
          client.full_name?.toLowerCase().includes(query) ||
          client.email?.toLowerCase().includes(query) ||
          client.phone?.toLowerCase().includes(query)
      );
    }

    // Status filter
    switch (statusFilter) {
      case 'active':
        result = result.filter((c: Client) => c.status?.toLowerCase() === 'active');
        break;
      case 'trial':
        result = result.filter((c: Client) => c.lifecycle_stage === 'TRIAL');
        break;
      case 'past_due':
        result = result.filter((c: Client) => c.is_delinquent);
        break;
      case 'canceled':
        result = result.filter((c: Client) => c.lifecycle_stage === 'CHURN');
        break;
      case 'vip':
        result = result.filter((c: Client) => (c.total_spend || 0) >= VIP_THRESHOLD);
        break;
      case 'no_phone':
        result = result.filter((c: Client) => !c.phone);
        break;
    }

    return result;
  }, [clients, searchQuery, statusFilter]);

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

  const filterCounts = useMemo(() => ({
    all: clients.length,
    active: clients.filter((c: Client) => c.status?.toLowerCase() === 'active').length,
    trial: clients.filter((c: Client) => c.lifecycle_stage === 'TRIAL').length,
    past_due: clients.filter((c: Client) => c.is_delinquent).length,
    canceled: clients.filter((c: Client) => c.lifecycle_stage === 'CHURN').length,
    vip: clients.filter((c: Client) => (c.total_spend || 0) >= VIP_THRESHOLD).length,
    no_phone: clients.filter((c: Client) => !c.phone).length,
  }), [clients]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Users className="h-8 w-8 text-primary" />
            Clientes
          </h1>
          <p className="text-muted-foreground mt-1">
            {totalCount} clientes en total
          </p>
        </div>
        <Button onClick={() => setIsAddDialogOpen(true)} className="gap-2">
          <Users className="h-4 w-4" />
          Agregar Cliente
        </Button>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por email, teléfono o nombre..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Status Filter */}
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ClientFilter)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filtrar por estado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos ({filterCounts.all})</SelectItem>
              <SelectItem value="active">Activos ({filterCounts.active})</SelectItem>
              <SelectItem value="trial">Trial ({filterCounts.trial})</SelectItem>
              <SelectItem value="past_due">Past Due ({filterCounts.past_due})</SelectItem>
              <SelectItem value="canceled">Cancelados ({filterCounts.canceled})</SelectItem>
              <SelectItem value="vip">
                <div className="flex items-center gap-2">
                  <Crown className="h-3 w-3 text-yellow-500" />
                  VIP ({filterCounts.vip})
                </div>
              </SelectItem>
              <SelectItem value="no_phone">
                <div className="flex items-center gap-2">
                  <Phone className="h-3 w-3 text-muted-foreground" />
                  Sin teléfono ({filterCounts.no_phone})
                </div>
              </SelectItem>
            </SelectContent>
          </Select>

          <Badge variant="outline" className="text-muted-foreground">
            {filteredClients.length} resultados
          </Badge>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border/50 bg-card p-6">
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

      {/* Add Client Dialog */}
      <AddClientDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onAdd={handleAddClient}
        isLoading={addClient.isPending}
      />

      {/* Customer 360 Drawer */}
      <CustomerDrawer
        client={selectedClient}
        open={!!selectedClient}
        onOpenChange={(open) => !open && setSelectedClient(null)}
        debtAmount={selectedClient?.email ? recoveryAmounts[selectedClient.email] : 0}
      />
    </div>
  );
}

import { useState, useMemo, useCallback } from 'react';
import { Users, Search, Crown, Phone, LogOut, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import { useClients, Client, ClientFilter } from '@/hooks/useClients';
import { useMetrics } from '@/hooks/useMetrics';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

export function ClientsPage() {
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<ClientFilter>('all');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  // Debounce search to avoid too many queries
  const debouncedSearch = useDebouncedValue(searchInput, 400);

  // Pass filters directly to hook for SERVER-SIDE filtering
  const { 
    clients, 
    isLoading, 
    addClient, 
    deleteClient, 
    totalCount, 
    page, 
    setPage, 
    totalPages,
    pageSize,
    setPageSize,
    isVip,
    VIP_THRESHOLD
  } = useClients({
    searchQuery: debouncedSearch,
    statusFilter: statusFilter,
  });

  const { metrics } = useMetrics();

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

  // Handle filter change - reset to 'all' if clicking same filter
  const handleFilterClick = useCallback((filter: ClientFilter) => {
    setStatusFilter(prev => prev === filter ? 'all' : filter);
  }, []);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2 md:gap-3">
            <Users className="h-6 w-6 md:h-8 md:w-8 text-primary" />
            Clientes
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            {totalCount.toLocaleString()} clientes {statusFilter !== 'all' || debouncedSearch ? 'encontrados' : 'en total'}
          </p>
        </div>
        <Button onClick={() => setIsAddDialogOpen(true)} size="sm" className="gap-2 self-start sm:self-auto touch-feedback">
          <Users className="h-4 w-4" />
          <span className="hidden sm:inline">Agregar Cliente</span>
          <span className="sm:hidden">Agregar</span>
        </Button>
      </div>

      {/* Quick Filter Buttons - Horizontal scroll on mobile */}
      <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
        <div className="flex gap-2 pb-2 md:pb-0 md:flex-wrap min-w-max md:min-w-0">
          <Button
            variant={statusFilter === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('all')}
            className="gap-1.5 text-xs touch-feedback shrink-0"
          >
            <Users className="h-3.5 w-3.5" />
            Todos
          </Button>
          <Button
            variant={statusFilter === 'customer' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('customer')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Clientes
          </Button>
          <Button
            variant={statusFilter === 'lead' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('lead')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-zinc-500" />
            Leads
          </Button>
          <Button
            variant={statusFilter === 'trial' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('trial')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <span className="h-2 w-2 rounded-full bg-zinc-400" />
            Trial
          </Button>
          <Button
            variant={statusFilter === 'past_due' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('past_due')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            Morosos
          </Button>
          <Button
            variant={statusFilter === 'churn' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('churn')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <LogOut className="h-3.5 w-3.5 text-red-500" />
            Cancel
          </Button>
          <Button
            variant={statusFilter === 'vip' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('vip')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <Crown className="h-3.5 w-3.5 text-yellow-500" />
            VIP
          </Button>
          <Button
            variant={statusFilter === 'no_phone' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilterClick('no_phone')}
            className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 touch-feedback shrink-0"
          >
            <Phone className="h-3.5 w-3.5 text-muted-foreground" />
            Sin tel
          </Button>
        </div>
      </div>

      {/* Search and Page Size - Stack on mobile */}
      <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nombre, email o teléfono..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 text-sm"
            />
          </div>
          
          <div className="flex items-center gap-2 justify-between sm:justify-end">
            <Select 
              value={pageSize === 'all' ? 'all' : pageSize.toString()} 
              onValueChange={(v) => setPageSize(v === 'all' ? 'all' : parseInt(v))}
            >
              <SelectTrigger className="w-[100px] md:w-[140px] text-xs md:text-sm">
                <SelectValue placeholder="Por página" />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="200">200</SelectItem>
              </SelectContent>
            </Select>
            
            <Badge variant="outline" className="text-muted-foreground text-xs">
              Pág {page + 1}/{Math.max(1, totalPages)}
            </Badge>
          </div>
        </div>
      </div>

      {/* Table - Horizontal scroll on mobile */}
      <div className="rounded-xl border border-border/50 bg-card p-2 md:p-6 overflow-hidden">
        <ClientsTable
          clients={clients}
          isLoading={isLoading}
          onDelete={(id) => deleteClient.mutate(id)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          recoveryEmails={recoveryEmails}
          recoveryAmounts={recoveryAmounts}
          vipOnly={false}
          onVipOnlyChange={() => {}}
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

import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { MoreHorizontal, Mail, Phone } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface Client {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  status: string | null;
  last_sync: string | null;
}

interface ClientsTableProps {
  clients: Client[];
  isLoading?: boolean;
  onEdit?: (client: Client) => void;
  onDelete?: (id: string) => void;
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

const getStatusBadge = (status: string | null) => {
  const statusLower = status?.toLowerCase() || "unknown";
  
  const statusConfig: Record<string, { label: string; className: string }> = {
    active: { label: "Activo", className: "status-active" },
    pending: { label: "Pendiente", className: "status-pending" },
    inactive: { label: "Inactivo", className: "status-inactive" },
  };

  const config = statusConfig[statusLower] || { label: status || "Desconocido", className: "bg-muted text-muted-foreground" };

  return (
    <Badge variant="outline" className={cn("text-xs font-medium border", config.className)}>
      {config.label}
    </Badge>
  );
};

export function ClientsTable({ clients, isLoading, onEdit, onDelete, page = 0, totalPages = 1, onPageChange }: ClientsTableProps) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-8 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Cargando clientes...</p>
        </div>
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-8 text-center">
          <p className="text-muted-foreground">No hay clientes registrados</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Cliente
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Contacto
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Estado
              </th>
              <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Última sincronización
              </th>
              <th className="px-6 py-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Acciones
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {clients.map((client) => (
              <tr
                key={client.id}
                className="transition-colors hover:bg-muted/20"
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <span className="text-sm font-medium text-primary">
                        {client.full_name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "??"}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{client.full_name || "Sin nombre"}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="space-y-1">
                    {client.email && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Mail className="h-3.5 w-3.5" />
                        {client.email}
                      </div>
                    )}
                    {client.phone && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Phone className="h-3.5 w-3.5" />
                        {client.phone}
                      </div>
                    )}
                    {!client.email && !client.phone && (
                      <span className="text-sm text-muted-foreground">Sin contacto</span>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4">
                  {getStatusBadge(client.status)}
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {client.last_sync
                    ? formatDistanceToNow(new Date(client.last_sync), {
                        addSuffix: true,
                        locale: es,
                      })
                    : "Nunca"}
                </td>
                <td className="px-6 py-4 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit?.(client)}>
                        Editar
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => onDelete?.(client.id)}
                      >
                        Eliminar
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {/* Pagination */}
      {totalPages > 1 && onPageChange && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            Página {page + 1} de {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
            >
              Siguiente
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

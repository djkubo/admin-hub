import { MessageCircle, Phone, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface RecoveryClient {
  email: string;
  full_name: string | null;
  phone: string | null;
  payment_status: string | null;
}

interface RecoveryTableProps {
  clients: RecoveryClient[];
}

export function RecoveryTable({ clients }: RecoveryTableProps) {
  const openWhatsApp = (phone: string, name: string) => {
    const cleanPhone = phone.replace(/\D/g, '');
    const message = encodeURIComponent(
      `Hola ${name || 'usuario'}, notamos que hubo un problema con tu pago. ¿Podemos ayudarte?`
    );
    window.open(`https://wa.me/${cleanPhone}?text=${message}`, '_blank');
  };

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case 'failed':
        return <Badge variant="destructive">Fallido</Badge>;
      case 'canceled':
        return <Badge variant="secondary">Cancelado</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (clients.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Lista de Recuperación
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <MessageCircle className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p>No hay clientes para recuperar hoy</p>
            <p className="text-xs mt-1">Los clientes con pagos fallidos o cancelados aparecerán aquí</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-yellow-500" />
          Lista de Recuperación ({clients.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Teléfono</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acción</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client, index) => (
              <TableRow key={index}>
                <TableCell className="font-medium">
                  {client.full_name || 'Sin nombre'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {client.email}
                </TableCell>
                <TableCell>
                  {client.phone ? (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {client.phone}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-sm">Sin teléfono</span>
                  )}
                </TableCell>
                <TableCell>
                  {getStatusBadge(client.payment_status)}
                </TableCell>
                <TableCell className="text-right">
                  {client.phone ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2 text-green-600 border-green-200 hover:bg-green-50 hover:text-green-700"
                      onClick={() => openWhatsApp(client.phone!, client.full_name || '')}
                    >
                      <MessageCircle className="h-4 w-4" />
                      WhatsApp
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Sin contacto</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

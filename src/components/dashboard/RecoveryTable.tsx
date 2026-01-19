import { MessageCircle, Phone, AlertTriangle, ExternalLink } from 'lucide-react';
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
import { RecoveryClient } from '@/lib/csvProcessor';

interface RecoveryTableProps {
  clients: RecoveryClient[];
}

// Utility function to clean phone number (removes all non-digits)
export const cleanPhoneNumber = (phone: string): string => {
  return phone.replace(/\D/g, '');
};

// Utility function to open WhatsApp with Safari/iOS compatible URL
export const openWhatsApp = (phone: string, _name: string, message: string) => {
  const cleanPhone = cleanPhoneNumber(phone);
  const encodedMessage = encodeURIComponent(message);
  // Using wa.me format for Safari/iOS compatibility
  window.open(`https://wa.me/${cleanPhone}?text=${encodedMessage}`, '_blank');
};

// Pre-built message for recovery/debt collection
export const getRecoveryMessage = (name: string, amount: number): string => {
  return `Hola ${name || 'usuario'}, notamos que hubo un problema con tu pago de $${amount.toFixed(2)}. ¿Podemos ayudarte a completarlo?`;
};

// Pre-built message for general greeting
export const getGreetingMessage = (name: string): string => {
  return `Hola ${name || ''}, ¿cómo podemos ayudarte?`.trim();
};

export function RecoveryTable({ clients }: RecoveryTableProps) {
  const getSourceBadge = (source: string) => {
    switch (source.toLowerCase()) {
      case 'stripe':
        return <Badge className="bg-purple-500/20 text-purple-400 border border-purple-500/30">Stripe</Badge>;
      case 'paypal':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">PayPal</Badge>;
      case 'stripe/paypal':
        return <Badge className="bg-orange-500/20 text-orange-400 border border-orange-500/30">Múltiple</Badge>;
      default:
        return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30">{source}</Badge>;
    }
  };

  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-yellow-500/10">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Recuperación de Pagos</h3>
            <p className="text-sm text-gray-400">Pagos fallidos para recuperar</p>
          </div>
        </div>
        <div className="text-center py-8">
          <MessageCircle className="h-12 w-12 mx-auto mb-3 text-gray-600" />
          <p className="text-gray-400 mb-1">No hay pagos fallidos</p>
          <p className="text-xs text-gray-500">Los clientes con pagos fallidos de Stripe y PayPal aparecerán aquí</p>
        </div>
      </div>
    );
  }

  const totalDebt = clients.reduce((sum, c) => sum + c.amount, 0);

  return (
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] overflow-hidden">
      <div className="p-6 border-b border-gray-700/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/10">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Recuperación de Pagos</h3>
              <p className="text-sm text-gray-400">{clients.length} clientes por recuperar</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-red-400">${totalDebt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-xs text-gray-500">Deuda total</p>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-gray-700/50 hover:bg-transparent">
              <TableHead className="text-gray-400">Nombre</TableHead>
              <TableHead className="text-gray-400">Email</TableHead>
              <TableHead className="text-gray-400">Monto Deuda</TableHead>
              <TableHead className="text-gray-400">Fuente</TableHead>
              <TableHead className="text-right text-gray-400">Acción</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client, index) => (
              <TableRow key={index} className="border-gray-700/50 hover:bg-gray-800/30">
                <TableCell className="font-medium text-white">
                  {client.full_name || <span className="text-gray-500 italic">Sin nombre</span>}
                </TableCell>
                <TableCell className="text-gray-400">
                  {client.email}
                </TableCell>
                <TableCell>
                  <span className="text-red-400 font-semibold">
                    ${client.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </TableCell>
                <TableCell>
                  {getSourceBadge(client.source)}
                </TableCell>
                <TableCell className="text-right">
                  {client.phone ? (
                    <Button
                      size="sm"
                      className="gap-2 bg-[#25D366] hover:bg-[#1da851] text-white border-0"
                      onClick={() => openWhatsApp(
                        client.phone!, 
                        client.full_name || '', 
                        getRecoveryMessage(client.full_name || '', client.amount)
                      )}
                    >
                      <MessageCircle className="h-4 w-4" />
                      WhatsApp
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2 text-gray-500 text-sm">
                      <Phone className="h-4 w-4" />
                      Sin teléfono
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
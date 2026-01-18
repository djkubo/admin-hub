import { DollarSign, TrendingUp, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface MetricsCardsProps {
  salesToday: number;
  conversionRate: number;
  trialCount: number;
  convertedCount: number;
}

export function MetricsCards({ salesToday, conversionRate, trialCount, convertedCount }: MetricsCardsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-800">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-green-800 dark:text-green-300">
            Ventas Hoy
          </CardTitle>
          <DollarSign className="h-4 w-4 text-green-600 dark:text-green-400" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-green-900 dark:text-green-100">
            ${salesToday.toLocaleString('es-MX', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-xs text-green-600 dark:text-green-400">
            Suma de transacciones exitosas de hoy
          </p>
        </CardContent>
      </Card>

      <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-800">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-blue-800 dark:text-blue-300">
            Tasa de Conversión
          </CardTitle>
          <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-blue-900 dark:text-blue-100">
            {conversionRate.toFixed(1)}%
          </div>
          <p className="text-xs text-blue-600 dark:text-blue-400">
            {convertedCount} de {trialCount} trials convertidos
          </p>
        </CardContent>
      </Card>

      <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-800">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-purple-800 dark:text-purple-300">
            Total Trials
          </CardTitle>
          <Users className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-purple-900 dark:text-purple-100">
            {trialCount}
          </div>
          <p className="text-xs text-purple-600 dark:text-purple-400">
            Usuarios en periodo de prueba
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

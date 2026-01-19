import { useState, useRef } from 'react';
import { Upload, FileText, Check, AlertCircle, Loader2, X, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  processWebUsersCSV, 
  processPayPalCSV, 
  processPaymentCSV,
  processSubscriptionsCSV,
  processStripeCustomersCSV,
  ProcessingResult,
  StripeCustomerResult
} from '@/lib/csvProcessor';
import { toast } from 'sonner';

interface CSVFile {
  name: string;
  type: 'web' | 'stripe' | 'paypal' | 'subscriptions' | 'stripe_customers';
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  result?: ProcessingResult | StripeCustomerResult;
  subscriptionCount?: number;
  duplicatesResolved?: number;
}

interface CSVUploaderProps {
  onProcessingComplete: () => void;
}

export function CSVUploader({ onProcessingComplete }: CSVUploaderProps) {
  const [files, setFiles] = useState<CSVFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectFileType = async (file: File): Promise<'web' | 'stripe' | 'paypal' | 'subscriptions' | 'stripe_customers'> => {
    const lowerName = file.name.toLowerCase();
    
    // Read content for column-based detection (more reliable)
    try {
      const text = await file.text();
      const lines = text.split('\n');
      const firstLine = lines[0]?.toLowerCase() || '';
      
      console.log(`[CSV Detection] File: ${file.name}`);
      console.log(`[CSV Detection] Headers: ${firstLine.substring(0, 200)}...`);
      
      // STRIPE CUSTOMERS (unified_customers.csv) - detect by Total Spend or Delinquent columns
      if (firstLine.includes('total spend') || 
          firstLine.includes('total_spend') ||
          firstLine.includes('delinquent') ||
          firstLine.includes('lifetime value') ||
          (firstLine.includes('customer id') && firstLine.includes('email') && !firstLine.includes('amount'))) {
        console.log(`[CSV Detection] Detected as: Stripe Customers (LTV Master)`);
        return 'stripe_customers';
      }
      
      // PayPal detection: unique Spanish column names or "Bruto" column
      if (firstLine.includes('correo electrónico del remitente') || 
          firstLine.includes('from email address') ||
          firstLine.includes('bruto') ||
          firstLine.includes('id. de transacción') ||
          firstLine.includes('transaction id')) {
        console.log(`[CSV Detection] Detected as: PayPal`);
        return 'paypal';
      }
      
      // Stripe transactions: has specific Stripe column patterns
      if (firstLine.includes('payment_intent') ||
          firstLine.includes('created (utc)') ||
          firstLine.includes('created date (utc)') ||
          (firstLine.includes('amount') && firstLine.includes('status') && firstLine.includes('id') && !firstLine.includes('plan'))) {
        console.log(`[CSV Detection] Detected as: Stripe`);
        return 'stripe';
      }
      
      // Subscriptions detection: has Plan Name or Expires At columns
      if (firstLine.includes('plan name') || 
          firstLine.includes('plan_name') ||
          firstLine.includes('plan ') ||
          firstLine.includes('expires at') ||
          firstLine.includes('expiration') ||
          firstLine.includes('subscription')) {
        console.log(`[CSV Detection] Detected as: Subscriptions`);
        return 'subscriptions';
      }
      
      // Web users detection: has typical user columns (email + name/phone but no payment columns)
      if ((firstLine.includes('email') || firstLine.includes('correo')) && 
          (firstLine.includes('nombre') || firstLine.includes('name') || 
           firstLine.includes('telefono') || firstLine.includes('phone') ||
           firstLine.includes('role') || firstLine.includes('usuario'))) {
        console.log(`[CSV Detection] Detected as: Web Users`);
        return 'web';
      }
      
      // Fallback to filename patterns
      if (lowerName.includes('unified_customer') || lowerName.includes('customers')) {
        console.log(`[CSV Detection] Filename fallback: Stripe Customers`);
        return 'stripe_customers';
      }
      if (lowerName.includes('download') || lowerName.includes('paypal')) {
        console.log(`[CSV Detection] Filename fallback: PayPal`);
        return 'paypal';
      }
      if (lowerName.includes('subscription') || lowerName.includes('suscripcion') || lowerName.includes('plan')) {
        console.log(`[CSV Detection] Filename fallback: Subscriptions`);
        return 'subscriptions';
      }
      if (lowerName.includes('stripe') || lowerName.includes('payment') || lowerName.includes('unified')) {
        console.log(`[CSV Detection] Filename fallback: Stripe`);
        return 'stripe';
      }
      if (lowerName.includes('user') || lowerName.includes('usuario')) {
        console.log(`[CSV Detection] Filename fallback: Web Users`);
        return 'web';
      }
      
    } catch (e) {
      console.error('Error reading file for detection:', e);
    }
    
    // Default to web users (safest fallback)
    console.log(`[CSV Detection] Default fallback: Web Users`);
    return 'web';
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    
    const newFiles: CSVFile[] = await Promise.all(
      selectedFiles.map(async (file) => ({
        name: file.name,
        type: await detectFileType(file),
        file,
        status: 'pending' as const
      }))
    );
    
    setFiles(prev => [...prev, ...newFiles]);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const updateFileType = (index: number, type: 'web' | 'stripe' | 'paypal' | 'subscriptions' | 'stripe_customers') => {
    setFiles(prev => prev.map((f, i) => i === index ? { ...f, type } : f));
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processFiles = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    
    // Process in order: Web (for phones) -> Stripe Customers (LTV) -> Subscriptions -> Payments
    const sortedFiles = [...files].sort((a, b) => {
      const priority = { web: 0, stripe_customers: 1, subscriptions: 2, stripe: 3, paypal: 4 };
      return priority[a.type] - priority[b.type];
    });

    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const originalIndex = files.findIndex(f => f.name === file.name);
      
      setFiles(prev => prev.map((f, idx) => 
        idx === originalIndex ? { ...f, status: 'processing' } : f
      ));

      try {
        const text = await file.file.text();

        if (file.type === 'stripe_customers') {
          // Process Stripe Customers (LTV Master Data)
          const customerResult = await processStripeCustomersCSV(text);
          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done', 
              result: customerResult,
              duplicatesResolved: customerResult.duplicatesResolved
            } : f
          ));
          toast.success(
            `${file.name}: ${customerResult.clientsUpdated} clientes actualizados con LTV. ` +
            `${customerResult.duplicatesResolved} duplicados resueltos. ` +
            `Total LTV: $${(customerResult.totalLTV / 100).toFixed(2)}`
          );
          
          if (customerResult.delinquentCount > 0) {
            toast.warning(`⚠️ ${customerResult.delinquentCount} clientes morosos detectados`);
          }
          
          if (customerResult.errors.length > 0) {
            toast.warning(`${file.name}: ${customerResult.errors.length} errores`);
          }
        } else if (file.type === 'subscriptions') {
          const subsResult = await processSubscriptionsCSV(text);
          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done', 
              result: subsResult,
              subscriptionCount: subsResult.clientsCreated + subsResult.clientsUpdated
            } : f
          ));
          toast.success(`${file.name}: ${subsResult.clientsCreated + subsResult.clientsUpdated} suscripciones procesadas`);
          
          if (subsResult.errors.length > 0) {
            toast.warning(`${file.name}: ${subsResult.errors.length} errores`);
          }
        } else {
          let result: ProcessingResult;

          if (file.type === 'web') {
            result = await processWebUsersCSV(text);
          } else if (file.type === 'paypal') {
            result = await processPayPalCSV(text);
          } else {
            result = await processPaymentCSV(text, 'stripe');
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { ...f, status: 'done', result } : f
          ));

          if (result.errors.length > 0) {
            toast.warning(`${file.name}: ${result.errors.length} errores`);
          }
        }
      } catch (error) {
        console.error('Error processing file:', error);
        setFiles(prev => prev.map((f, idx) => 
          idx === originalIndex ? { ...f, status: 'error' } : f
        ));
        toast.error(`Error procesando ${file.name}`);
      }
    }

    setIsProcessing(false);
    toast.success('Procesamiento completado');
    onProcessingComplete();
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'web': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
      case 'stripe': return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
      case 'stripe_customers': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'paypal': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'subscriptions': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'web': return 'Usuarios Web';
      case 'stripe': return 'Stripe Pagos';
      case 'stripe_customers': return 'Clientes LTV';
      case 'paypal': return 'PayPal';
      case 'subscriptions': return 'Suscripciones';
      default: return type;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'processing': return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case 'done': return <Check className="h-4 w-4 text-emerald-500" />;
      case 'error': return <AlertCircle className="h-4 w-4 text-red-500" />;
      default: return null;
    }
  };

  const totalResults = files.reduce((acc, f) => {
    if (f.result) {
      acc.clientsCreated += f.result.clientsCreated;
      acc.clientsUpdated += f.result.clientsUpdated;
      acc.transactionsCreated += f.result.transactionsCreated;
      acc.transactionsSkipped += f.result.transactionsSkipped;
      // Total unique clients = new + updated
      acc.uniqueClients += f.result.clientsCreated + f.result.clientsUpdated;
    }
    if (f.subscriptionCount) {
      acc.subscriptions += f.subscriptionCount;
    }
    if (f.duplicatesResolved) {
      acc.duplicatesResolved += f.duplicatesResolved;
    }
    return acc;
  }, { clientsCreated: 0, clientsUpdated: 0, transactionsCreated: 0, transactionsSkipped: 0, subscriptions: 0, uniqueClients: 0, duplicatesResolved: 0 });

  return (
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10">
          <Upload className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-white">Cargar Archivos CSV</h3>
          <p className="text-sm text-gray-400">PayPal, Stripe, unified_customers.csv (LTV), Suscripciones</p>
        </div>
      </div>

      <div 
        className="border-2 border-dashed border-gray-600 rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer bg-[#0f1225]/50"
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept=".csv"
          multiple
          className="hidden"
        />
        <FileText className="h-10 w-10 mx-auto text-gray-500 mb-3" />
        <p className="text-sm text-gray-400 mb-1">
          Arrastra archivos o haz clic para seleccionar
        </p>
        <p className="text-xs text-gray-500">
          Detecta: unified_customers.csv (LTV), Download-X.csv (PayPal), subscriptions.csv
        </p>
      </div>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between p-3 bg-[#0f1225] rounded-lg border border-gray-700/50">
              <div className="flex items-center gap-3">
                {getStatusIcon(file.status)}
                <span className="text-sm font-medium text-white">{file.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={file.type}
                  onChange={(e) => updateFileType(index, e.target.value as 'web' | 'stripe' | 'paypal' | 'subscriptions' | 'stripe_customers')}
                  disabled={file.status !== 'pending'}
                  className="text-xs border border-gray-600 rounded px-2 py-1 bg-[#1a1f36] text-white"
                >
                  <option value="web">Usuarios Web</option>
                  <option value="paypal">PayPal</option>
                  <option value="stripe">Stripe Pagos</option>
                  <option value="stripe_customers">Clientes LTV</option>
                  <option value="subscriptions">Suscripciones</option>
                </select>
                <Badge className={`${getTypeColor(file.type)} border`}>
                  {getTypeLabel(file.type)}
                </Badge>
                {file.status === 'pending' && (
                  <button 
                    onClick={() => removeFile(index)}
                    className="p-1 hover:bg-gray-700 rounded"
                  >
                    <X className="h-4 w-4 text-gray-400" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {files.some(f => f.status === 'done') && (
        <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
          <h4 className="font-medium text-emerald-400 mb-2">Resumen</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="text-gray-400">
              Clientes únicos: <span className="text-white font-medium ml-1">{totalResults.uniqueClients}</span>
            </div>
            <div className="text-gray-400">
              Nuevos: <span className="text-emerald-400 font-medium ml-1">{totalResults.clientsCreated}</span>
            </div>
            <div className="text-gray-400">
              Actualizados: <span className="text-blue-400 font-medium ml-1">{totalResults.clientsUpdated}</span>
            </div>
            <div className="text-gray-400">
              Transacciones: <span className="text-white font-medium ml-1">{totalResults.transactionsCreated}</span>
            </div>
            <div className="text-gray-400">
              Duplicados TX: <span className="text-yellow-400 font-medium ml-1">{totalResults.transactionsSkipped}</span>
            </div>
            <div className="text-gray-400">
              Suscripciones: <span className="text-white font-medium ml-1">{totalResults.subscriptions}</span>
            </div>
            {totalResults.duplicatesResolved > 0 && (
              <div className="text-gray-400 col-span-2">
                <Users className="inline h-3 w-3 mr-1" />
                Duplicados LTV resueltos: <span className="text-amber-400 font-medium ml-1">{totalResults.duplicatesResolved}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <Button 
        onClick={processFiles} 
        disabled={files.length === 0 || isProcessing || files.every(f => f.status === 'done')}
        className="w-full mt-4 bg-primary hover:bg-primary/90 text-primary-foreground"
      >
        {isProcessing ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Procesando...
          </>
        ) : (
          <>
            <Upload className="mr-2 h-4 w-4" />
            Procesar Archivos ({files.filter(f => f.status === 'pending').length})
          </>
        )}
      </Button>
    </div>
  );
}

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
  processStripePaymentsCSV,
  processGoHighLevelCSV,
  processManyChatCSV,
  ProcessingResult,
  StripeCustomerResult,
  StripePaymentsResult,
  GHLProcessingResult,
  ManyChatProcessingResult
} from '@/lib/csvProcessor';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';

type CSVFileType = 'web' | 'stripe' | 'paypal' | 'subscriptions' | 'stripe_customers' | 'stripe_payments' | 'ghl' | 'manychat';

interface CSVFile {
  name: string;
  type: CSVFileType;
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  result?: ProcessingResult | StripeCustomerResult | StripePaymentsResult | GHLProcessingResult | ManyChatProcessingResult;
  subscriptionCount?: number;
  duplicatesResolved?: number;
  ghlStats?: { withEmail: number; withPhone: number; withTags: number };
  manychatStats?: { withEmail: number; withPhone: number; withTags: number };
  stripePaymentsStats?: { totalAmount: number; uniqueCustomers: number; refundedCount: number };
}

interface CSVUploaderProps {
  onProcessingComplete: () => void;
}

export function CSVUploader({ onProcessingComplete }: CSVUploaderProps) {
  const [files, setFiles] = useState<CSVFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectFileType = async (file: File): Promise<CSVFileType> => {
    const lowerName = file.name.toLowerCase();
    
    // Read content for column-based detection (more reliable)
    try {
      const text = await file.text();
      const lines = text.split('\n');
      const firstLine = lines[0]?.toLowerCase() || '';
      
      console.log(`[CSV Detection] File: ${file.name}`);
      console.log(`[CSV Detection] Headers: ${firstLine.substring(0, 200)}...`);
      
      // STRIPE CUSTOMERS (unified_customers.csv) - detect by Total Spend or Delinquent columns
      // Must check BEFORE Stripe Payments to avoid misclassification
      if ((firstLine.includes('total spend') || 
           firstLine.includes('total_spend') ||
           firstLine.includes('delinquent') ||
           firstLine.includes('lifetime value')) &&
          !firstLine.includes('amount refunded')) {
        console.log(`[CSV Detection] Detected as: Stripe Customers (LTV Master)`);
        return 'stripe_customers';
      }

      // STRIPE PAYMENTS (unified_payments.csv) - detect by specific payment columns
      // Has: id, Amount, Amount Refunded, Currency, Customer Email, Status, Created (UTC)
      if ((firstLine.includes('amount refunded') || firstLine.includes('amount_refunded')) ||
          (firstLine.includes('balance transaction') && firstLine.includes('captured')) ||
          (firstLine.includes('payment method type') && firstLine.includes('customer email')) ||
          (firstLine.includes('invoice id') && firstLine.includes('customer email') && firstLine.includes('amount'))) {
        console.log(`[CSV Detection] Detected as: Stripe Payments (unified_payments.csv)`);
        return 'stripe_payments';
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
      
      // Stripe transactions (legacy): has specific Stripe column patterns
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
      
      // ManyChat detection: has subscriber_id, optin fields, or manychat keywords
      if ((firstLine.includes('subscriber_id') || firstLine.includes('subscriberid')) ||
          (firstLine.includes('optin_email') || firstLine.includes('optin_sms') || firstLine.includes('optin_whatsapp')) ||
          firstLine.includes('manychat')) {
        console.log(`[CSV Detection] Detected as: ManyChat`);
        return 'manychat';
      }

      // GoHighLevel detection: has contactId, firstName/lastName patterns, or dndSettings
      if (firstLine.includes('contactid') ||
          firstLine.includes('contact id') ||
          firstLine.includes('dndsettings') ||
          firstLine.includes('dnd settings') ||
          (firstLine.includes('firstname') && firstLine.includes('lastname')) ||
          (firstLine.includes('first name') && firstLine.includes('last name')) ||
          firstLine.includes('ghl') ||
          firstLine.includes('gohighlevel') ||
          firstLine.includes('locationid')) {
        console.log(`[CSV Detection] Detected as: GoHighLevel`);
        return 'ghl';
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
      if (lowerName.includes('manychat')) {
        console.log(`[CSV Detection] Filename fallback: ManyChat`);
        return 'manychat';
      }
      
      if (lowerName.includes('ghl') || lowerName.includes('gohighlevel') || lowerName.includes('highlevel')) {
        console.log(`[CSV Detection] Filename fallback: GoHighLevel`);
        return 'ghl';
      }
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
      // Filename fallback: unified_payments.csv -> stripe_payments
      if (lowerName.includes('unified_payment') || lowerName.includes('payments')) {
        console.log(`[CSV Detection] Filename fallback: Stripe Payments`);
        return 'stripe_payments';
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

  const updateFileType = (index: number, type: CSVFileType) => {
    setFiles(prev => prev.map((f, i) => i === index ? { ...f, type } : f));
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processFiles = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    
    // Process in order: GHL/Web (for contacts) -> Stripe Customers (LTV) -> Stripe Payments -> Subscriptions -> Legacy Stripe/PayPal
    const sortedFiles = [...files].sort((a, b) => {
      const priority: Record<CSVFileType, number> = { 
        ghl: 0, 
        web: 1, 
        manychat: 2,
        stripe_customers: 3, 
        stripe_payments: 4,
        subscriptions: 5, 
        stripe: 6, 
        paypal: 7 
      };
      return priority[a.type] - priority[b.type];
    });

    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const originalIndex = files.findIndex(f => f.name === file.name);
      
      setFiles(prev => prev.map((f, idx) => 
        idx === originalIndex ? { ...f, status: 'processing' } : f
      ));

      try {
        // Show progress for large files
        const fileSizeMB = file.file.size / (1024 * 1024);
        if (fileSizeMB > 5) {
          toast.info(`Cargando ${file.name} (${fileSizeMB.toFixed(1)}MB)...`, { duration: 3000 });
        }
        
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
        } else if (file.type === 'ghl') {
          // For large GHL CSVs (> 10MB or > 100k lines), use Edge Function
          // For smaller files, use local processing (faster)
          const fileSizeMB = file.file.size / (1024 * 1024);
          const lineCount = text.split('\n').length;
          const useEdgeFunction = fileSizeMB > 10 || lineCount > 100000;

          if (useEdgeFunction) {
            toast.info(`Procesando CSV grande (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas) en servidor...`, { duration: 5000 });
            
            const response = await invokeWithAdminKey<{ ok: boolean; result?: GHLProcessingResult; error?: string }>(
              'process-ghl-csv',
              { csvText: text }
            );

            if (!response || !response.ok || !response.result) {
              const errorMsg = response?.error || 'Error desconocido';
              setFiles(prev => prev.map((f, idx) => 
                idx === originalIndex ? { ...f, status: 'error' } : f
              ));
              toast.error(`Error procesando CSV: ${errorMsg}`);
              continue;
            }

            const ghlResult = response.result;
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { 
                ...f, 
                status: 'done', 
                result: ghlResult,
                ghlStats: {
                  withEmail: ghlResult.withEmail,
                  withPhone: ghlResult.withPhone,
                  withTags: ghlResult.withTags
                }
              } : f
            ));
            toast.success(
              `${file.name}: ${ghlResult.clientsCreated} nuevos, ${ghlResult.clientsUpdated} actualizados. ` +
              `Total: ${ghlResult.totalContacts} contactos GHL`
            );
            
            if (ghlResult.errors.length > 0) {
              toast.warning(`${file.name}: ${ghlResult.errors.length} errores`);
            }
          } else {
            // Process GoHighLevel CSV locally (smaller files)
            const ghlResult = await processGoHighLevelCSV(text);
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { 
                ...f, 
                status: 'done', 
                result: ghlResult,
                ghlStats: {
                  withEmail: ghlResult.withEmail,
                  withPhone: ghlResult.withPhone,
                  withTags: ghlResult.withTags
                }
              } : f
            ));
            toast.success(
              `${file.name}: ${ghlResult.clientsCreated} nuevos, ${ghlResult.clientsUpdated} actualizados. ` +
              `Total: ${ghlResult.totalContacts} contactos GHL`
            );
            
            if (ghlResult.errors.length > 0) {
              toast.warning(`${file.name}: ${ghlResult.errors.length} errores`);
            }
          }
        } else if (file.type === 'manychat') {
          // Process ManyChat CSV
          const manychatResult = await processManyChatCSV(text);
          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done', 
              result: manychatResult,
              manychatStats: {
                withEmail: manychatResult.withEmail,
                withPhone: manychatResult.withPhone,
                withTags: manychatResult.withTags
              }
            } : f
          ));
          
          toast.success(
            `${file.name}: ${manychatResult.clientsCreated} nuevos, ${manychatResult.clientsUpdated} actualizados. ` +
            `Total: ${manychatResult.totalSubscribers} suscriptores ManyChat`
          );
          
          if (manychatResult.errors.length > 0) {
            toast.warning(`${file.name}: ${manychatResult.errors.length} errores`);
          }
        } else if (file.type === 'stripe_payments') {
          // For large Stripe Payments CSVs (> 10MB), use Edge Function
          const fileSizeMB = file.file.size / (1024 * 1024);
          const lineCount = text.split('\n').length;
          const useEdgeFunction = fileSizeMB > 10 || lineCount > 50000;

          if (useEdgeFunction) {
            toast.info(`Procesando CSV grande de Stripe Payments (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas) en servidor...`, { duration: 5000 });
            
            // TODO: Create Edge Function for large Stripe Payments CSV
            // For now, fallback to local processing with warning
            toast.warning('Archivo muy grande. Procesando localmente (puede tardar)...', { duration: 10000 });
          }
          
          // Process Stripe Payments (unified_payments.csv)
          const paymentsResult = await processStripePaymentsCSV(text);
          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done', 
              result: paymentsResult,
              stripePaymentsStats: {
                totalAmount: paymentsResult.totalAmountCents,
                uniqueCustomers: paymentsResult.uniqueCustomers,
                refundedCount: paymentsResult.refundedCount
              }
            } : f
          ));
          toast.success(
            `${file.name}: ${paymentsResult.transactionsCreated} transacciones importadas. ` +
            `${paymentsResult.uniqueCustomers} clientes únicos. ` +
            `Total: $${(paymentsResult.totalAmountCents / 100).toLocaleString()}`
          );
          
          if (paymentsResult.refundedCount > 0) {
            toast.info(`📋 ${paymentsResult.refundedCount} transacciones con reembolsos`);
          }
          
          if (paymentsResult.errors.length > 0) {
            toast.warning(`${file.name}: ${paymentsResult.errors.length} errores`);
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
    
    // Check if there were any errors
    const hasErrors = files.some(f => f.status === 'error');
    const hasSuccess = files.some(f => f.status === 'done');
    
    if (hasErrors && hasSuccess) {
      toast.warning('Procesamiento completado con algunos errores');
    } else if (hasErrors) {
      toast.error('Procesamiento completado con errores');
    } else {
      toast.success('Procesamiento completado');
    }
    
    onProcessingComplete();
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'web': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
      case 'stripe': return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
      case 'stripe_customers': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'stripe_payments': return 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30';
      case 'paypal': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'subscriptions': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      case 'ghl': return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
      case 'manychat': return 'bg-pink-500/20 text-pink-400 border-pink-500/30';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'web': return 'Usuarios Web';
      case 'stripe': return 'Stripe (Legacy)';
      case 'stripe_customers': return 'Clientes LTV';
      case 'stripe_payments': return 'Stripe Pagos';
      case 'paypal': return 'PayPal';
      case 'subscriptions': return 'Suscripciones';
      case 'ghl': return 'GoHighLevel';
      case 'manychat': return 'ManyChat';
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
      // Only add transactions if they exist on the result type
      if ('transactionsCreated' in f.result) {
        acc.transactionsCreated += f.result.transactionsCreated;
      }
      if ('transactionsSkipped' in f.result) {
        acc.transactionsSkipped += f.result.transactionsSkipped;
      }
      // Total unique clients = new + updated
      acc.uniqueClients += f.result.clientsCreated + f.result.clientsUpdated;
    }
    if (f.subscriptionCount) {
      acc.subscriptions += f.subscriptionCount;
    }
    if (f.duplicatesResolved) {
      acc.duplicatesResolved += f.duplicatesResolved;
    }
    if (f.ghlStats) {
      acc.ghlContacts += f.result?.clientsCreated || 0;
      acc.ghlContacts += f.result?.clientsUpdated || 0;
    }
    if (f.manychatStats) {
      acc.manychatContacts = (acc.manychatContacts || 0) + (f.result?.clientsCreated || 0) + (f.result?.clientsUpdated || 0);
    }
    return acc;
  }, { clientsCreated: 0, clientsUpdated: 0, transactionsCreated: 0, transactionsSkipped: 0, subscriptions: 0, uniqueClients: 0, duplicatesResolved: 0, ghlContacts: 0, manychatContacts: 0 });

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
          Detecta: unified_payments.csv, unified_customers.csv, Download-X.csv (PayPal), GHL, subscriptions
        </p>
      </div>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between p-3 bg-[#0f1225] rounded-lg border border-gray-700/50">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {getStatusIcon(file.status)}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-white block truncate">{file.name}</span>
                  {file.status === 'done' && file.result && (
                    <span className="text-xs text-gray-400">
                      {file.result.clientsCreated} nuevos, {file.result.clientsUpdated} actualizados
                    </span>
                  )}
                  {file.status === 'error' && (
                    <span className="text-xs text-red-400">Error al procesar</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={file.type}
                  onChange={(e) => updateFileType(index, e.target.value as CSVFileType)}
                  disabled={file.status !== 'pending'}
                  className="text-xs border border-gray-600 rounded px-2 py-1 bg-[#1a1f36] text-white"
                >
                  <option value="ghl">GoHighLevel</option>
                  <option value="manychat">ManyChat</option>
                  <option value="web">Usuarios Web</option>
                  <option value="paypal">PayPal</option>
                  <option value="stripe_payments">Stripe Pagos</option>
                  <option value="stripe_customers">Clientes LTV</option>
                  <option value="stripe">Stripe (Legacy)</option>
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

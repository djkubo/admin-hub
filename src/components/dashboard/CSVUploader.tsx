import { useState, useRef } from 'react';
import { Upload, FileText, Check, AlertCircle, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  processWebUsersCSV, 
  processPayPalCSV, 
  processPaymentCSV,
  processSubscriptionsCSV,
  ProcessingResult 
} from '@/lib/csvProcessor';
import { toast } from 'sonner';

interface CSVFile {
  name: string;
  type: 'web' | 'stripe' | 'paypal' | 'subscriptions';
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  result?: ProcessingResult;
  subscriptionCount?: number;
}

interface CSVUploaderProps {
  onProcessingComplete: () => void;
}

export function CSVUploader({ onProcessingComplete }: CSVUploaderProps) {
  const [files, setFiles] = useState<CSVFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectFileType = async (file: File): Promise<'web' | 'stripe' | 'paypal' | 'subscriptions'> => {
    const lowerName = file.name.toLowerCase();
    
    // First check file name patterns
    if (lowerName.includes('download') || lowerName.includes('paypal')) return 'paypal';
    if (lowerName.includes('subscription') || lowerName.includes('suscripcion')) return 'subscriptions';
    
    // Read first line to detect by columns
    try {
      const text = await file.text();
      const firstLine = text.split('\n')[0].toLowerCase();
      
      // Stripe detection: has Amount, Created date columns
      if (firstLine.includes('amount') && firstLine.includes('created date')) return 'stripe';
      if (firstLine.includes('created (utc)') || firstLine.includes('payment_intent')) return 'stripe';
      
      // PayPal detection: has "correo electrónico del remitente" column
      if (firstLine.includes('correo electrónico del remitente') || firstLine.includes('bruto')) return 'paypal';
      
      // Web users detection: has Role, Subscription Plan columns
      if (firstLine.includes('role') || firstLine.includes('subscription plan')) return 'web';
      
      // Subscriptions detection
      if (firstLine.includes('plan name') || firstLine.includes('status')) return 'subscriptions';
      
      // Default fallback based on filename
      if (lowerName.includes('stripe') || lowerName.includes('payment') || lowerName.includes('unified')) return 'stripe';
      if (lowerName.includes('user') || lowerName.includes('usuario')) return 'web';
    } catch (e) {
      console.error('Error reading file for detection:', e);
    }
    
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

  const updateFileType = (index: number, type: 'web' | 'stripe' | 'paypal' | 'subscriptions') => {
    setFiles(prev => prev.map((f, i) => i === index ? { ...f, type } : f));
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processFiles = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    
    // Process in order: Web (for phones) -> Subscriptions -> Payments
    const sortedFiles = [...files].sort((a, b) => {
      const priority = { web: 0, subscriptions: 1, stripe: 2, paypal: 3 };
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

        if (file.type === 'subscriptions') {
          const subs = processSubscriptionsCSV(text);
          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done', 
              subscriptionCount: subs.length 
            } : f
          ));
          toast.success(`${file.name}: ${subs.length} suscripciones procesadas`);
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
      case 'paypal': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'subscriptions': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'web': return 'Usuarios Web';
      case 'stripe': return 'Stripe';
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
    return acc;
  }, { clientsCreated: 0, clientsUpdated: 0, transactionsCreated: 0, transactionsSkipped: 0, subscriptions: 0, uniqueClients: 0 });

  return (
    <div className="rounded-xl border border-border/50 bg-[#1a1f36] p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10">
          <Upload className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-white">Cargar Archivos CSV</h3>
          <p className="text-sm text-gray-400">PayPal, Usuarios Web, Suscripciones</p>
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
          Detecta automáticamente: Download-X.csv (PayPal), users.csv (Web), subscriptions.csv
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
                  onChange={(e) => updateFileType(index, e.target.value as 'web' | 'stripe' | 'paypal' | 'subscriptions')}
                  disabled={file.status !== 'pending'}
                  className="text-xs border border-gray-600 rounded px-2 py-1 bg-[#1a1f36] text-white"
                >
                  <option value="web">Usuarios Web</option>
                  <option value="paypal">PayPal</option>
                  <option value="stripe">Stripe</option>
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 text-sm">
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
              Duplicados: <span className="text-yellow-400 font-medium ml-1">{totalResults.transactionsSkipped}</span>
            </div>
            <div className="text-gray-400">
              Suscripciones: <span className="text-white font-medium ml-1">{totalResults.subscriptions}</span>
            </div>
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

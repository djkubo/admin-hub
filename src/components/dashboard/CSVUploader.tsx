import { useState, useRef } from 'react';
import { Upload, FileText, Check, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { processWebCSV, processPaymentCSV, ProcessingResult } from '@/lib/csvProcessor';
import { toast } from 'sonner';

interface CSVFile {
  name: string;
  type: 'web' | 'stripe' | 'paypal';
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  result?: ProcessingResult;
}

interface CSVUploaderProps {
  onProcessingComplete: () => void;
}

export function CSVUploader({ onProcessingComplete }: CSVUploaderProps) {
  const [files, setFiles] = useState<CSVFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectFileType = (fileName: string): 'web' | 'stripe' | 'paypal' => {
    const lowerName = fileName.toLowerCase();
    if (lowerName.includes('stripe')) return 'stripe';
    if (lowerName.includes('paypal')) return 'paypal';
    return 'web';
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    const newFiles: CSVFile[] = selectedFiles.map(file => ({
      name: file.name,
      type: detectFileType(file.name),
      file,
      status: 'pending'
    }));
    setFiles(prev => [...prev, ...newFiles]);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const updateFileType = (index: number, type: 'web' | 'stripe' | 'paypal') => {
    setFiles(prev => prev.map((f, i) => i === index ? { ...f, type } : f));
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processFiles = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    
    // Process Web files first (to have client data), then payment files
    const sortedFiles = [...files].sort((a, b) => {
      if (a.type === 'web' && b.type !== 'web') return -1;
      if (a.type !== 'web' && b.type === 'web') return 1;
      return 0;
    });

    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const originalIndex = files.findIndex(f => f.name === file.name);
      
      setFiles(prev => prev.map((f, idx) => 
        idx === originalIndex ? { ...f, status: 'processing' } : f
      ));

      try {
        const text = await file.file.text();
        let result: ProcessingResult;

        if (file.type === 'web') {
          result = await processWebCSV(text);
        } else {
          result = await processPaymentCSV(text, file.type);
        }

        setFiles(prev => prev.map((f, idx) => 
          idx === originalIndex ? { ...f, status: 'done', result } : f
        ));

        if (result.errors.length > 0) {
          toast.warning(`${file.name}: ${result.errors.length} errores durante el procesamiento`);
        }
      } catch (error) {
        setFiles(prev => prev.map((f, idx) => 
          idx === originalIndex ? { ...f, status: 'error' } : f
        ));
        toast.error(`Error procesando ${file.name}`);
      }
    }

    setIsProcessing(false);
    toast.success('Procesamiento de archivos completado');
    onProcessingComplete();
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'web': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
      case 'stripe': return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300';
      case 'paypal': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'processing': return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case 'done': return <Check className="h-4 w-4 text-green-600" />;
      case 'error': return <AlertCircle className="h-4 w-4 text-destructive" />;
      default: return null;
    }
  };

  const totalResults = files.reduce((acc, f) => {
    if (f.result) {
      acc.clientsCreated += f.result.clientsCreated;
      acc.clientsUpdated += f.result.clientsUpdated;
      acc.transactionsCreated += f.result.transactionsCreated;
      acc.transactionsSkipped += f.result.transactionsSkipped;
    }
    return acc;
  }, { clientsCreated: 0, clientsUpdated: 0, transactionsCreated: 0, transactionsSkipped: 0 });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Cargar Archivos CSV
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div 
          className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
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
          <FileText className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Arrastra archivos CSV o haz clic para seleccionar
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Nombra los archivos con "stripe", "paypal" o "web" para detección automática
          </p>
        </div>

        {files.length > 0 && (
          <div className="space-y-2">
            {files.map((file, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-3">
                  {getStatusIcon(file.status)}
                  <span className="text-sm font-medium">{file.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={file.type}
                    onChange={(e) => updateFileType(index, e.target.value as 'web' | 'stripe' | 'paypal')}
                    disabled={file.status !== 'pending'}
                    className="text-xs border rounded px-2 py-1 bg-background"
                  >
                    <option value="web">Web</option>
                    <option value="stripe">Stripe</option>
                    <option value="paypal">PayPal</option>
                  </select>
                  <Badge className={getTypeColor(file.type)}>{file.type}</Badge>
                  {file.status === 'pending' && (
                    <Button variant="ghost" size="sm" onClick={() => removeFile(index)}>
                      ×
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {files.some(f => f.status === 'done') && (
          <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
            <h4 className="font-medium text-green-800 dark:text-green-300 mb-2">Resumen del Procesamiento</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                <span className="text-muted-foreground">Clientes creados:</span>
                <span className="ml-2 font-medium">{totalResults.clientsCreated}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Clientes actualizados:</span>
                <span className="ml-2 font-medium">{totalResults.clientsUpdated}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Transacciones nuevas:</span>
                <span className="ml-2 font-medium">{totalResults.transactionsCreated}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Duplicados ignorados:</span>
                <span className="ml-2 font-medium">{totalResults.transactionsSkipped}</span>
              </div>
            </div>
          </div>
        )}

        <Button 
          onClick={processFiles} 
          disabled={files.length === 0 || isProcessing || files.every(f => f.status === 'done')}
          className="w-full"
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
      </CardContent>
    </Card>
  );
}

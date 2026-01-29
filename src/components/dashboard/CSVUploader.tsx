import { useState, useRef } from 'react';
import { Upload, FileText, Check, AlertCircle, Loader2, X, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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

type CSVFileType = 'web' | 'stripe' | 'paypal' | 'subscriptions' | 'stripe_customers' | 'stripe_payments' | 'ghl' | 'manychat' | 'master';

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

interface ChunkProgress {
  currentChunk: number;
  totalChunks: number;
  rowsProcessed: number;
  totalRows: number;
}

interface CSVUploaderProps {
  onProcessingComplete: () => void;
}

// Split CSV text into chunks of approximately maxSizeBytes
// Reduced to 200KB for GUARANTEED fast processing (<10s per chunk)
function splitCSVIntoChunks(csvText: string, maxSizeBytes: number = 200 * 1024): string[] {
  const lines = csvText.split('\n');
  if (lines.length < 2) return [csvText];
  
  const headerLine = lines[0];
  const headerSize = new Blob([headerLine + '\n']).size;
  const chunks: string[] = [];
  
  let currentChunk: string[] = [headerLine];
  let currentSize = headerSize;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    
    const lineSize = new Blob([line + '\n']).size;
    
    // If adding this line would exceed the limit, start a new chunk
    if (currentSize + lineSize > maxSizeBytes && currentChunk.length > 1) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [headerLine];
      currentSize = headerSize;
    }
    
    currentChunk.push(line);
    currentSize += lineSize;
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 1) {
    chunks.push(currentChunk.join('\n'));
  }
  
  return chunks;
}

export function CSVUploader({ onProcessingComplete }: CSVUploaderProps) {
  const [files, setFiles] = useState<CSVFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [chunkProgress, setChunkProgress] = useState<ChunkProgress | null>(null);
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
      
      // MASTER CSV DETECTION: Has prefixed columns from multiple sources
      // Prefixes: CNT_ (GHL/Contact), PP_ (PayPal), ST_ (Stripe), SUB_ (Subscriptions), USR_ (Users)
      // NOTE: Check is case-insensitive since CSV headers may be in UPPER, lower, or Mixed case
      const hasCNT = /\bcnt_/i.test(firstLine) || /\bcnt_contact\s*id/i.test(firstLine);
      const hasPP = /\bpp_/i.test(firstLine) || /\bpp_bruto/i.test(firstLine);
      const hasST = /\bst_/i.test(firstLine) || /\bst_amount/i.test(firstLine);
      const hasSUB = /\bsub_/i.test(firstLine) || /\bsub_plan\s*name/i.test(firstLine);
      const hasUSR = /\busr_/i.test(firstLine) || /\busr_nombre/i.test(firstLine);
      const hasAutoMaster = /\bauto_master_/i.test(firstLine) || /\bauto_total_spend/i.test(firstLine);
      
      // If has 2+ prefixes OR has Auto_Master fields, it's a Master CSV
      const prefixCount = [hasCNT, hasPP, hasST, hasSUB, hasUSR].filter(Boolean).length;
      if (prefixCount >= 2 || hasAutoMaster) {
        console.log(`[CSV Detection] Detected as: MASTER CSV (prefixes: CNT=${hasCNT}, PP=${hasPP}, ST=${hasST}, SUB=${hasSUB}, USR=${hasUSR})`);
        return 'master';
      }
      
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
      if (lowerName.includes('master') || lowerName.includes('maestro') || lowerName.includes('unificado')) {
        console.log(`[CSV Detection] Filename fallback: Master CSV`);
        return 'master';
      }
      
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

  // Process a large file in chunks - MICRO CHUNKS for guaranteed success
  const processInChunks = async (
    csvText: string, 
    csvType: string, 
    filename: string
  ): Promise<{ ok: boolean; result?: ProcessingResult; error?: string; importId?: string }> => {
    const fileSizeBytes = new Blob([csvText]).size;
    const MAX_CHUNK_SIZE = 200 * 1024; // 200KB per chunk = ~500 rows = <10s processing
    
    // If file is small enough, send directly
    if (fileSizeBytes <= MAX_CHUNK_SIZE) {
      console.log(`[Chunking] File ${filename} is small (${(fileSizeBytes / 1024 / 1024).toFixed(2)}MB), sending directly`);
      
      try {
        const response = await invokeWithAdminKey<{ ok?: boolean; success?: boolean; result?: ProcessingResult; error?: string }>(
          'process-csv-bulk',
          { csvText, csvType, filename }
        );
        
        if (!response || response.success === false || response.ok === false) {
          return { ok: false, error: response?.error || 'Error desconocido' };
        }
        
        const result = (response as { result?: ProcessingResult }).result || response as unknown as ProcessingResult;
        return { ok: true, result };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Error de conexión';
        console.error('[Chunking] Direct processing failed:', err);
        return { ok: false, error: errorMsg };
      }
    }
    
    // Split into chunks
    const chunks = splitCSVIntoChunks(csvText, MAX_CHUNK_SIZE);
    const totalRows = csvText.split('\n').length - 1;
    
    console.log(`[Chunking] File ${filename} (${(fileSizeBytes / 1024 / 1024).toFixed(2)}MB) split into ${chunks.length} chunks`);
    
    toast.info(`📦 Archivo grande detectado. Dividiendo en ${chunks.length} partes...`, { duration: 5000 });
    
    // Track accumulated results
    const accumulatedResult: ProcessingResult = {
      clientsCreated: 0,
      clientsUpdated: 0,
      transactionsCreated: 0,
      transactionsSkipped: 0,
      errors: []
    };
    
    let rowsProcessed = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    let importId: string | undefined; // Track import ID from first chunk
    
    // Process each chunk sequentially
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkRows = chunk.split('\n').length - 1;
      
      setChunkProgress({
        currentChunk: i + 1,
        totalChunks: chunks.length,
        rowsProcessed,
        totalRows
      });
      
      console.log(`[Chunking] Processing chunk ${i + 1}/${chunks.length} (${chunkRows} rows)${importId ? ` [importId: ${importId}]` : ''}`);
      
      try {
        // Add timeout for each chunk (90 seconds max)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout: El servidor tardó demasiado en responder')), 90000);
        });
        
        // Build request payload - include importId for chunks after the first
        const payload: Record<string, unknown> = { 
          csvText: chunk, 
          csvType, 
          filename: `${filename}_chunk_${i + 1}`,
          isChunk: true,
          chunkIndex: i,
          totalChunks: chunks.length
        };
        
        // CRITICAL: Send importId for all chunks after the first one
        if (importId && i > 0) {
          payload.importId = importId;
        }
        
        const fetchPromise = invokeWithAdminKey<{ ok?: boolean; success?: boolean; result?: ProcessingResult; error?: string; importId?: string }>(
          'process-csv-bulk',
          payload
        );
        
        const response = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (!response || response.success === false || response.ok === false) {
          const errorMsg = response?.error || `Error en parte ${i + 1}`;
          accumulatedResult.errors.push(errorMsg);
          console.error(`[Chunking] Chunk ${i + 1} failed:`, errorMsg);
          consecutiveFailures++;
          
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            toast.error(`❌ Demasiados errores consecutivos. Abortando procesamiento.`);
            break;
          }
          
          // Show progress toast for failed chunk
          toast.warning(`⚠️ Parte ${i + 1}/${chunks.length} tuvo errores, continuando...`);
          continue;
        }
        
        // Reset consecutive failures on success
        consecutiveFailures = 0;
        
        // CRITICAL: Save importId from first chunk response for subsequent chunks
        if (!importId && response.importId) {
          importId = response.importId;
          console.log(`[Chunking] Got importId from first chunk: ${importId}`);
        }
        
        const chunkResult = (response as { result?: ProcessingResult }).result || response as unknown as ProcessingResult;
        
        // Handle staging response format (may have different field names)
        const staged = (chunkResult as unknown as { staged?: number }).staged || 0;
        const resultAny = chunkResult as unknown as Record<string, number | undefined>;
        const created = chunkResult.clientsCreated || resultAny['created'] || staged || 0;
        const updated = chunkResult.clientsUpdated || resultAny['updated'] || 0;
        
        // Accumulate results
        accumulatedResult.clientsCreated += created;
        accumulatedResult.clientsUpdated += updated;
        accumulatedResult.transactionsCreated += (chunkResult.transactionsCreated || 0);
        accumulatedResult.transactionsSkipped += (chunkResult.transactionsSkipped || 0);
        if (chunkResult.errors?.length) {
          accumulatedResult.errors.push(...chunkResult.errors.slice(0, 3)); // Limit errors per chunk
        }
        
        rowsProcessed += chunkRows;
        
        // Show periodic progress toast every 5 chunks
        if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
          toast.info(`📊 Progreso: ${i + 1}/${chunks.length} partes (${rowsProcessed.toLocaleString()} filas)`, { duration: 2000 });
        }
        
        // Small delay between chunks to avoid overwhelming the server
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (chunkError) {
        const errorMsg = chunkError instanceof Error ? chunkError.message : 'Error desconocido';
        accumulatedResult.errors.push(`Parte ${i + 1}: ${errorMsg}`);
        console.error(`[Chunking] Chunk ${i + 1} exception:`, chunkError);
        consecutiveFailures++;
        
        if (errorMsg.includes('Timeout')) {
          toast.error(`⏱️ Timeout en parte ${i + 1}. Intenta con un archivo más pequeño.`);
          if (consecutiveFailures >= 2) break;
        }
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          toast.error(`❌ Demasiados errores consecutivos. Abortando.`);
          break;
        }
      }
    }
    
    setChunkProgress(null);
    
    // If we processed at least some rows, consider it a partial success
    if (rowsProcessed > 0) {
      return { ok: true, result: accumulatedResult };
    }
    
    return { 
      ok: false, 
      error: accumulatedResult.errors.length > 0 
        ? accumulatedResult.errors.join('; ') 
        : 'No se pudieron procesar las filas' 
    };
  };

  const processFiles = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    setChunkProgress(null);
    
    // Process in order: GHL/Web (for contacts) -> Stripe Customers (LTV) -> Stripe Payments -> Subscriptions -> Legacy Stripe/PayPal
    const sortedFiles = [...files].sort((a, b) => {
      const priority: Record<CSVFileType, number> = { 
        master: -1, // Master CSV processes first (contains everything)
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
          toast.info(`📂 Cargando ${file.name} (${fileSizeMB.toFixed(1)}MB)...`, { duration: 3000 });
        }
        
        const text = await file.file.text();

        // MASTER CSV - Process via Edge Function with chunking support
        if (file.type === 'master') {
          const lineCount = text.split('\n').length;
          
          toast.info(`🗂️ Procesando CSV Maestro (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} filas)...`, { duration: 10000 });
          
          const { ok, result: masterResult, error } = await processInChunks(text, 'master', file.name);

          if (!ok || !masterResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`❌ Error procesando CSV Maestro: ${error || 'Error desconocido'}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done' as const, 
              result: masterResult
            } : f
          ));
          
          toast.success(
            `✅ CSV Maestro: ${masterResult.clientsCreated} nuevos, ${masterResult.clientsUpdated} actualizados. ` +
            `${masterResult.transactionsCreated || 0} transacciones.`
          );
          
          if (masterResult.errors.length > 0) {
            toast.warning(`⚠️ ${masterResult.errors.length} advertencias`);
          }
        } else if (file.type === 'subscriptions') {
          // Process subscriptions via Edge Function with chunking (same as GHL/Stripe)
          const lineCount = text.split('\n').length;
          
          toast.info(`📋 Procesando suscripciones (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} filas)...`, { duration: 10000 });
          
          const { ok, result: subsResult, error } = await processInChunks(text, 'subscriptions', file.name);

          if (!ok || !subsResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`❌ Error procesando suscripciones: ${error || 'Error desconocido'}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done' as const, 
              result: subsResult,
              subscriptionCount: (subsResult.clientsCreated || 0) + (subsResult.clientsUpdated || 0)
            } : f
          ));
          
          toast.success(
            `✅ Suscripciones: ${subsResult.clientsCreated || 0} nuevos, ${subsResult.clientsUpdated || 0} actualizados`
          );
          
          if (subsResult.errors?.length > 0) {
            toast.warning(`⚠️ ${subsResult.errors.length} advertencias`);
          }
        } else if (file.type === 'ghl') {
          // For large GHL CSVs (> 10MB or > 100k lines), use Edge Function
          // For smaller files, use local processing (faster)
          const lineCount = text.split('\n').length;
          const useEdgeFunction = fileSizeMB > 10 || lineCount > 100000;

          if (useEdgeFunction) {
            toast.info(`Procesando CSV grande (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas) en servidor...`, { duration: 5000 });
            
            const { ok, result: ghlResult, error } = await processInChunks(text, 'ghl', file.name);

            if (!ok || !ghlResult) {
              setFiles(prev => prev.map((f, idx) => 
                idx === originalIndex ? { ...f, status: 'error' } : f
              ));
              toast.error(`Error procesando CSV: ${error}`);
              continue;
            }

            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { 
                ...f, 
                status: 'done', 
                result: ghlResult,
                ghlStats: {
                  withEmail: 0,
                  withPhone: 0,
                  withTags: 0
                }
              } : f
            ));
            toast.success(
              `${file.name}: ${ghlResult.clientsCreated} nuevos, ${ghlResult.clientsUpdated} actualizados`
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
          // ALWAYS use Edge Function for Stripe Payments (unified_payments.csv)
          const lineCount = text.split('\n').length;
          
          toast.info(`💳 Procesando Stripe Payments (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas)...`, { duration: 5000 });
          
          const { ok, result: processingResult, error } = await processInChunks(text, 'stripe_payments', file.name);

          if (!ok || !processingResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`Error procesando CSV: ${error}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done' as const, 
              result: processingResult,
              stripePaymentsStats: {
                totalAmount: 0,
                uniqueCustomers: processingResult.clientsCreated || 0,
                refundedCount: 0
              }
            } : f
          ));
          toast.success(
            `✅ ${file.name}: ${processingResult.transactionsCreated || 0} transacciones importadas. ` +
            `${processingResult.clientsCreated || 0} clientes creados/actualizados`
          );
          
          if (processingResult.errors?.length > 0) {
            toast.warning(`⚠️ ${processingResult.errors.length} errores`);
          }
        } else if (file.type === 'stripe_customers') {
          // ALWAYS use Edge Function for Stripe Customers (LTV)
          const lineCount = text.split('\n').length;
          
          toast.info(`👤 Procesando Stripe Customers (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas)...`, { duration: 5000 });

          const { ok, result: customerResult, error } = await processInChunks(text, 'stripe_customers', file.name);

          if (!ok || !customerResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`Error procesando CSV: ${error}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? {
              ...f,
              status: 'done' as const,
              result: customerResult,
              duplicatesResolved: 0
            } : f
          ));
          toast.success(
            `✅ ${file.name}: ${customerResult.clientsUpdated || 0} clientes actualizados con LTV`
          );
          
          if (customerResult.errors?.length > 0) {
            toast.warning(`⚠️ ${customerResult.errors.length} errores`);
          }
        } else if (file.type === 'web') {
          // Process web users via Edge Function with chunking (same as other types)
          const lineCount = text.split('\n').length;
          
          toast.info(`👥 Procesando usuarios (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} filas)...`, { duration: 10000 });
          
          const { ok, result: webResult, error } = await processInChunks(text, 'web', file.name);

          if (!ok || !webResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`❌ Error procesando usuarios: ${error || 'Error desconocido'}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? { 
              ...f, 
              status: 'done' as const, 
              result: webResult
            } : f
          ));
          
          toast.success(
            `✅ Usuarios: ${webResult.clientsCreated || 0} nuevos, ${webResult.clientsUpdated || 0} actualizados`
          );
          
          if (webResult.errors?.length > 0) {
            toast.warning(`⚠️ ${webResult.errors.length} advertencias`);
          }
        } else if (file.type === 'paypal') {
          // Use Edge Function for PayPal CSVs with chunking
          const lineCount = text.split('\n').length;
          
          toast.info(`💰 Procesando PayPal (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas)...`, { duration: 5000 });

          const { ok, result: paypalResult, error } = await processInChunks(text, 'paypal', file.name);

          if (!ok || !paypalResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`Error procesando CSV: ${error}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? {
              ...f,
              status: 'done' as const,
              result: paypalResult
            } : f
          ));
          toast.success(
            `${file.name}: ${paypalResult.transactionsCreated || 0} transacciones importadas. ` +
            `${paypalResult.clientsCreated || 0} clientes creados/actualizados`
          );
        } else {
          // Stripe legacy - also use Edge Function
          const lineCount = text.split('\n').length;
          
          toast.info(`💳 Procesando Stripe (${fileSizeMB.toFixed(1)}MB, ${lineCount.toLocaleString()} líneas)...`, { duration: 5000 });

          const { ok, result: stripeResult, error } = await processInChunks(text, 'stripe', file.name);

          if (!ok || !stripeResult) {
            setFiles(prev => prev.map((f, idx) => 
              idx === originalIndex ? { ...f, status: 'error' } : f
            ));
            toast.error(`Error procesando CSV: ${error}`);
            continue;
          }

          setFiles(prev => prev.map((f, idx) => 
            idx === originalIndex ? {
              ...f,
              status: 'done' as const,
              result: stripeResult
            } : f
          ));
          toast.success(
            `${file.name}: ${stripeResult.transactionsCreated || 0} transacciones. ` +
            `${stripeResult.clientsCreated || 0} clientes`
          );
          
          if (stripeResult.errors?.length > 0) {
            toast.warning(`${file.name}: ${stripeResult.errors.length} errores`);
          }
        }
      } catch (error) {
        console.error('Error processing file:', error);
        
        const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
        
        // Check for specific network errors that indicate file too large
        if (errorMessage.includes('Failed to fetch') || errorMessage.includes('Failed to send')) {
          toast.error(`❌ ${file.name}: Archivo demasiado grande. Intenta con un archivo más pequeño o contacta soporte.`, { duration: 8000 });
        } else {
          toast.error(`❌ Error procesando ${file.name}: ${errorMessage}`);
        }
        
        setFiles(prev => prev.map((f, idx) => 
          idx === originalIndex ? { ...f, status: 'error' } : f
        ));
      }
    }

    setIsProcessing(false);
    setChunkProgress(null);
    
    // Check if there were any errors
    const hasErrors = files.some(f => f.status === 'error');
    const hasSuccess = files.some(f => f.status === 'done');
    
    if (hasErrors && hasSuccess) {
      toast.warning('Procesamiento completado con algunos errores');
    } else if (hasErrors) {
      toast.error('Procesamiento completado con errores');
    } else {
      toast.success('✅ Procesamiento completado');
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
      case 'master': return 'bg-gradient-to-r from-blue-500/20 to-purple-500/20 text-white border-blue-500/30';
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
      case 'master': return '🗂️ Master CSV';
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
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10">
          <Upload className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-white">Cargar Archivos CSV</h3>
          <p className="text-sm text-gray-400">PayPal, Stripe, Master CSV, GHL, Suscripciones</p>
        </div>
      </div>

      <div 
        className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer bg-background/50"
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
          Detecta: Master CSV, unified_payments.csv, unified_customers.csv, PayPal, GHL, ManyChat
        </p>
      </div>

      {/* Chunk progress indicator */}
      {chunkProgress && (
        <div className="mt-4 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-blue-400">
              Procesando parte {chunkProgress.currentChunk} de {chunkProgress.totalChunks}
            </span>
            <span className="text-sm text-gray-400">
              {chunkProgress.rowsProcessed.toLocaleString()} / {chunkProgress.totalRows.toLocaleString()} filas
            </span>
          </div>
          <Progress 
            value={(chunkProgress.currentChunk / chunkProgress.totalChunks) * 100} 
            className="h-2"
          />
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between p-3 bg-background rounded-lg border border-border/50">
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
                  className="text-xs border border-border rounded px-2 py-1 bg-card text-foreground"
                >
                  <option value="master">🗂️ Master CSV</option>
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
            {chunkProgress ? `Procesando parte ${chunkProgress.currentChunk}/${chunkProgress.totalChunks}...` : 'Procesando...'}
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

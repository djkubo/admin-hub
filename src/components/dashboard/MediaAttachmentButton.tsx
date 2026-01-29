import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { 
  Paperclip, 
  Image, 
  Mic, 
  Video, 
  FileText,
  Loader2,
  X 
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface MediaAttachment {
  url: string;
  type: "image" | "audio" | "video" | "document";
  filename: string;
  mimeType: string;
}

interface MediaAttachmentButtonProps {
  onAttach: (attachment: MediaAttachment) => void;
  disabled?: boolean;
}

const ACCEPTED_TYPES = {
  image: "image/jpeg,image/png,image/gif,image/webp",
  audio: "audio/mpeg,audio/wav,audio/ogg",
  video: "video/mp4,video/webm",
  document: "application/pdf",
};

export function MediaAttachmentButton({ onAttach, disabled }: MediaAttachmentButtonProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentType, setCurrentType] = useState<keyof typeof ACCEPTED_TYPES>("image");
  const { toast } = useToast();

  const handleTypeSelect = (type: keyof typeof ACCEPTED_TYPES) => {
    setCurrentType(type);
    fileInputRef.current?.click();
  };

  const getMediaType = (mimeType: string): MediaAttachment["type"] => {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file size (10MB max)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Archivo muy grande",
        description: "El tamaño máximo es 10MB",
        variant: "destructive",
      });
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Generate unique filename
      const timestamp = Date.now();
      const ext = file.name.split(".").pop();
      const filename = `${timestamp}-${Math.random().toString(36).substring(7)}.${ext}`;
      const path = `uploads/${filename}`;

      // Upload to Supabase Storage
      const { data, error } = await supabase.storage
        .from("chat-media")
        .upload(path, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (error) throw error;

      // Get public URL
      const { data: urlData } = supabase.storage
        .from("chat-media")
        .getPublicUrl(path);

      const attachment: MediaAttachment = {
        url: urlData.publicUrl,
        type: getMediaType(file.type),
        filename: file.name,
        mimeType: file.type,
      };

      onAttach(attachment);
      
      toast({
        title: "Archivo adjuntado",
        description: file.name,
      });
    } catch (error) {
      console.error("Upload error:", error);
      toast({
        title: "Error al subir",
        description: error instanceof Error ? error.message : "No se pudo subir el archivo",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      setUploadProgress(0);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES[currentType]}
        onChange={handleFileSelect}
        className="hidden"
      />
      
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled || uploading}
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Paperclip className="h-5 w-5" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onClick={() => handleTypeSelect("image")} className="gap-2">
            <Image className="h-4 w-4 text-blue-500" />
            Imagen
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleTypeSelect("audio")} className="gap-2">
            <Mic className="h-4 w-4 text-green-500" />
            Audio
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleTypeSelect("video")} className="gap-2">
            <Video className="h-4 w-4 text-purple-500" />
            Video
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleTypeSelect("document")} className="gap-2">
            <FileText className="h-4 w-4 text-orange-500" />
            Documento PDF
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

interface MediaPreviewProps {
  attachment: MediaAttachment;
  onRemove: () => void;
}

export function MediaPreview({ attachment, onRemove }: MediaPreviewProps) {
  return (
    <div className="relative inline-flex items-center gap-2 p-2 bg-muted rounded-lg max-w-xs">
      {attachment.type === "image" && (
        <img 
          src={attachment.url} 
          alt={attachment.filename}
          className="h-16 w-16 object-cover rounded"
        />
      )}
      {attachment.type === "audio" && (
        <div className="flex items-center gap-2 px-2">
          <Mic className="h-8 w-8 text-green-500" />
          <span className="text-sm truncate max-w-[120px]">{attachment.filename}</span>
        </div>
      )}
      {attachment.type === "video" && (
        <div className="flex items-center gap-2 px-2">
          <Video className="h-8 w-8 text-purple-500" />
          <span className="text-sm truncate max-w-[120px]">{attachment.filename}</span>
        </div>
      )}
      {attachment.type === "document" && (
        <div className="flex items-center gap-2 px-2">
          <FileText className="h-8 w-8 text-orange-500" />
          <span className="text-sm truncate max-w-[120px]">{attachment.filename}</span>
        </div>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

import { useState } from "react";
import { 
  Image, 
  Mic, 
  Video, 
  FileText, 
  Download, 
  Play,
  Pause,
  Maximize2 
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ChatMediaBubbleProps {
  mediaUrl: string;
  mediaType: "image" | "audio" | "video" | "document" | string;
  filename?: string;
  isOutgoing?: boolean;
}

export function ChatMediaBubble({ 
  mediaUrl, 
  mediaType, 
  filename,
  isOutgoing = false 
}: ChatMediaBubbleProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

  const handleAudioToggle = () => {
    if (!audioElement) {
      const audio = new Audio(mediaUrl);
      audio.onended = () => setIsPlaying(false);
      setAudioElement(audio);
      audio.play();
      setIsPlaying(true);
    } else if (isPlaying) {
      audioElement.pause();
      setIsPlaying(false);
    } else {
      audioElement.play();
      setIsPlaying(true);
    }
  };

  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = mediaUrl;
    link.download = filename || "download";
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Image
  if (mediaType === "image" || mediaType?.startsWith("image/")) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <div className="relative cursor-pointer group">
            <img
              src={mediaUrl}
              alt={filename || "Image"}
              className="max-w-[240px] max-h-[200px] rounded-lg object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded-lg flex items-center justify-center">
              <Maximize2 className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </DialogTrigger>
        <DialogContent className="max-w-4xl p-2">
          <DialogHeader className="sr-only">
            <DialogTitle>{filename || "Image preview"}</DialogTitle>
            <DialogDescription>Expanded image preview for chat media.</DialogDescription>
          </DialogHeader>
          <img
            src={mediaUrl}
            alt={filename || "Image"}
            className="w-full h-auto max-h-[80vh] object-contain rounded"
          />
        </DialogContent>
      </Dialog>
    );
  }

  // Audio
  if (mediaType === "audio" || mediaType?.startsWith("audio/")) {
    return (
      <div className={cn(
        "flex items-center gap-3 p-3 rounded-lg min-w-[200px]",
        isOutgoing ? "bg-primary/20" : "bg-muted"
      )}>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleAudioToggle}
          className="h-10 w-10 rounded-full bg-green-500 hover:bg-green-600 text-white"
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="h-5 w-5 ml-0.5" />
          )}
        </Button>
        <div className="flex-1 min-w-0">
          <div className="h-1 bg-muted-foreground/20 rounded-full">
            <div className="h-1 bg-green-500 rounded-full w-0" />
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {filename || "Audio"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDownload}
          className="h-8 w-8"
        >
          <Download className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  // Video
  if (mediaType === "video" || mediaType?.startsWith("video/")) {
    return (
      <div className="relative max-w-[280px]">
        <video
          src={mediaUrl}
          controls
          className="rounded-lg w-full"
          preload="metadata"
        >
          Tu navegador no soporta video
        </video>
      </div>
    );
  }

  // Document (PDF)
  if (mediaType === "document" || mediaType === "application/pdf") {
    return (
      <a
        href={mediaUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "flex items-center gap-3 p-3 rounded-lg hover:bg-muted/80 transition-colors",
          isOutgoing ? "bg-primary/20" : "bg-muted"
        )}
      >
        <div className="h-10 w-10 rounded-lg bg-orange-500/20 flex items-center justify-center">
          <FileText className="h-5 w-5 text-orange-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {filename || "Documento"}
          </p>
          <p className="text-xs text-muted-foreground">PDF</p>
        </div>
        <Download className="h-4 w-4 text-muted-foreground" />
      </a>
    );
  }

  // Fallback for unknown types
  return (
    <a
      href={mediaUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-sm text-primary hover:underline"
    >
      <Download className="h-4 w-4" />
      {filename || "Descargar archivo"}
    </a>
  );
}

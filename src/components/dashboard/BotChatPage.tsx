import { useState, useEffect, useRef } from "react";
import { 
  useChatContacts, 
  useChatMessages, 
  useChatEventsRealtime,
  type ChatContact,
  type ChatEvent 
} from "@/hooks/useChatEvents";
import { useCurrentAgent } from "@/hooks/useAgents";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  Bot, 
  Search,
  ArrowLeft,
  User,
  Send,
  PanelRightClose,
  PanelRightOpen,
  UserPlus,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ChatCustomerPanel } from "./ChatCustomerPanel";
import { ChatQuickTemplates, fillTemplateVariables, type ChatTemplate } from "./ChatQuickTemplates";
import { AgentStatusPanel } from "./AgentStatusPanel";
import { ConversationFilters, type ConversationFilter, type ConversationStatusFilter } from "./ConversationFilters";
import { MediaAttachmentButton, MediaPreview, type MediaAttachment } from "./MediaAttachmentButton";
import { ChatMediaBubble } from "./ChatMediaBubble";

// Sentiment analysis helper - analyze last messages to determine mood
function analyzeSentiment(messages: ChatEvent[]): "positive" | "negative" | "neutral" {
  if (!messages || messages.length === 0) return "neutral";
  
  // Get last 5 user messages
  const userMessages = messages
    .filter(m => m.sender === "user")
    .slice(-5)
    .map(m => m.message?.toLowerCase() || "");
  
  const text = userMessages.join(" ");
  
  // Negative indicators
  const negativeWords = [
    "problema", "error", "no funciona", "ayuda", "urgente", "mal", "molesto",
    "enojado", "cancelar", "reembolso", "devolver", "queja", "terrible",
    "pésimo", "horrible", "fraude", "estafa", "robo", "nunca", "jamás",
    "furioso", "decepcionado", "frustrado", "cansado", "harto"
  ];
  
  // Positive indicators
  const positiveWords = [
    "gracias", "excelente", "genial", "perfecto", "increíble", "feliz",
    "contento", "satisfecho", "encanta", "maravilloso", "fantástico",
    "amor", "super", "bueno", "bien", "éxito", "funciona", "resuelto"
  ];
  
  let score = 0;
  for (const word of negativeWords) {
    if (text.includes(word)) score -= 1;
  }
  for (const word of positiveWords) {
    if (text.includes(word)) score += 1;
  }
  
  if (score <= -2) return "negative";
  if (score >= 2) return "positive";
  return "neutral";
}

// Sentiment indicator component
function SentimentBadge({ sentiment }: { sentiment: "positive" | "negative" | "neutral" }) {
  if (sentiment === "neutral") return null;
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-sm">
          {sentiment === "negative" ? "🔴" : "🟢"}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {sentiment === "negative" ? "Cliente posiblemente molesto" : "Sentimiento positivo"}
      </TooltipContent>
    </Tooltip>
  );
}

export default function BotChatPage() {
  const [selectedContact, setSelectedContact] = useState<ChatContact | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [replyMessage, setReplyMessage] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [showCustomerPanel, setShowCustomerPanel] = useState(true);
  const [agentFilter, setAgentFilter] = useState<ConversationFilter>("all");
  const [statusFilter, setStatusFilter] = useState<ConversationStatusFilter>("all");
  const [mediaAttachment, setMediaAttachment] = useState<MediaAttachment | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Enable realtime
  useChatEventsRealtime();

  const { data: currentAgent } = useCurrentAgent();
  const { data: contacts, isLoading: loadingContacts } = useChatContacts();
  const { data: messages, isLoading: loadingMessages } = useChatMessages(selectedContact?.contact_id);

  // Calculate sentiment for each contact (memoized)
  const contactSentiments = new Map<string, "positive" | "negative" | "neutral">();
  
  // Filter contacts
  const filteredContacts = contacts?.filter((contact) => {
    const query = searchQuery.toLowerCase();
    return (
      contact.name?.toLowerCase().includes(query) ||
      contact.email?.toLowerCase().includes(query) ||
      contact.contact_id.toLowerCase().includes(query) ||
      contact.last_message?.toLowerCase().includes(query)
    );
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Analyze sentiment when messages change
  const currentSentiment = messages ? analyzeSentiment(messages) : "neutral";

  const getInitials = (name: string | null, contactId: string) => {
    if (name) {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    return contactId.slice(0, 2).toUpperCase();
  };

  // Group messages by date
  const groupMessagesByDate = (msgs: ChatEvent[]) => {
    const groups: { date: string; messages: ChatEvent[] }[] = [];
    let currentDate = "";
    
    for (const msg of msgs) {
      const msgDate = format(new Date(msg.created_at), "yyyy-MM-dd");
      if (msgDate !== currentDate) {
        currentDate = msgDate;
        groups.push({ date: msgDate, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  };

  const formatDateHeader = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (format(date, "yyyy-MM-dd") === format(today, "yyyy-MM-dd")) {
      return "Hoy";
    } else if (format(date, "yyyy-MM-dd") === format(yesterday, "yyyy-MM-dd")) {
      return "Ayer";
    }
    return format(date, "EEEE, d 'de' MMMM", { locale: es });
  };

  // Handle template selection
  const handleTemplateSelect = (template: ChatTemplate) => {
    const variables: Record<string, string> = {
      name: selectedContact?.name || "Cliente",
      email: selectedContact?.email || "",
      payment_link: "[Link de pago]",
      portal_link: "[Link del portal]",
    };
    const filledContent = fillTemplateVariables(template.content, variables);
    setReplyMessage(filledContent);
  };

  // Handle sending reply via Python server -> GoHighLevel
  const handleSendReply = async () => {
    if ((!replyMessage.trim() && !mediaAttachment) || !selectedContact) return;
    
    setSendingReply(true);
    try {
      const payload: Record<string, any> = {
        contact_id: selectedContact.contact_id,
        message: replyMessage || "",
        channel: "WhatsApp",
      };

      // Add media if attached
      if (mediaAttachment) {
        payload.media_url = mediaAttachment.url;
        payload.media_type = mediaAttachment.type;
        payload.media_filename = mediaAttachment.filename;
      }

      const response = await fetch("https://vrp-bot-2.onrender.com/send/ghl", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      toast({
        title: mediaAttachment ? "Mensaje con adjunto enviado" : "Mensaje enviado",
        description: "El mensaje fue enviado por WhatsApp al contacto",
      });
      setReplyMessage("");
      setMediaAttachment(null);
    } catch (error) {
      console.error("Error sending reply:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "No se pudo enviar el mensaje",
        variant: "destructive",
      });
    } finally {
      setSendingReply(false);
    }
  };

  // Simple sentiment analysis for contact list (based on last message)
  const getContactSentiment = (contact: ChatContact): "positive" | "negative" | "neutral" => {
    const text = contact.last_message?.toLowerCase() || "";
    const negativeWords = ["problema", "error", "ayuda", "urgente", "mal", "cancelar", "reembolso"];
    const positiveWords = ["gracias", "excelente", "genial", "perfecto"];
    
    for (const word of negativeWords) {
      if (text.includes(word)) return "negative";
    }
    for (const word of positiveWords) {
      if (text.includes(word)) return "positive";
    }
    return "neutral";
  };

  // Calculate filter counts
  const filterCounts = {
    all: contacts?.length || 0,
    mine: 0, // Would be populated if we had agent assignment data
    unassigned: 0,
  };

  return (
    <TooltipProvider>
      <div className="flex h-[calc(100vh-8rem)] md:h-[calc(100vh-7rem)] gap-0 md:gap-4">
        {/* Contacts List */}
        <Card className={cn(
          "w-full md:w-80 lg:w-96 flex flex-col border-0 md:border rounded-none md:rounded-xl",
          selectedContact && "hidden md:flex"
        )}>
          <CardHeader className="pb-2 px-3 md:px-6">
            <CardTitle className="flex items-center gap-2 text-base md:text-lg">
              <Bot className="h-4 w-4 md:h-5 md:w-5 text-primary" />
              Chat Bot IA
            </CardTitle>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar contacto..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 text-sm"
              />
            </div>
          </CardHeader>

          {/* Agent Filters */}
          <ConversationFilters
            filter={agentFilter}
            onFilterChange={setAgentFilter}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            counts={filterCounts}
          />

          <CardContent className="flex-1 p-0 overflow-hidden">
            <ScrollArea className="h-full">
              {loadingContacts ? (
                <div className="space-y-2 p-3 md:p-4">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : filteredContacts?.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                  <Bot className="h-8 w-8 mb-2" />
                  <p className="text-sm">No hay conversaciones del bot</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredContacts?.map((contact) => {
                    const sentiment = getContactSentiment(contact);
                    return (
                      <button
                        key={contact.contact_id}
                        onClick={() => setSelectedContact(contact)}
                        className={cn(
                          "w-full p-3 md:p-4 text-left hover:bg-muted/50 transition-colors relative",
                          selectedContact?.contact_id === contact.contact_id && "bg-muted"
                        )}
                      >
                        <div className="flex gap-2.5 md:gap-3">
                          <div className="relative">
                            <Avatar className="h-10 w-10">
                              <AvatarFallback className="bg-primary/10 text-primary text-sm">
                                {getInitials(contact.name, contact.contact_id)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="absolute -bottom-1 -right-1 rounded-full p-0.5 bg-green-500">
                              <Bot className="h-2.5 w-2.5 text-white" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-medium truncate">
                                  {contact.name || contact.contact_id}
                                </span>
                                <SentimentBadge sentiment={sentiment} />
                              </div>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {formatDistanceToNow(new Date(contact.last_message_at), {
                                  addSuffix: true,
                                  locale: es,
                                })}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <p className="text-sm text-muted-foreground truncate flex-1">
                                {contact.last_message || "Sin mensajes"}
                              </p>
                              {contact.unread_count > 0 && (
                                <Badge variant="default" className="h-5 min-w-5 justify-center">
                                  {contact.unread_count}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Chat Thread */}
        <Card className={cn(
          "flex-1 flex flex-col border-0 md:border rounded-none md:rounded-xl",
          !selectedContact && "hidden md:flex"
        )}>
          {selectedContact ? (
            <>
              {/* Header */}
              <CardHeader className="pb-3 border-b">
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="md:hidden"
                    onClick={() => setSelectedContact(null)}
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                  <Avatar className="h-10 w-10">
                    <AvatarFallback className="bg-primary/10 text-primary">
                      {getInitials(selectedContact.name, selectedContact.contact_id)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">
                        {selectedContact.name || "Contacto"}
                      </h3>
                      <SentimentBadge sentiment={currentSentiment} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {selectedContact.email || selectedContact.contact_id}
                    </p>
                  </div>
                  <Badge variant="secondary" className="gap-1">
                    <Bot className="h-3 w-3" />
                    Bot IA
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowCustomerPanel(!showCustomerPanel)}
                    className="hidden lg:flex"
                  >
                    {showCustomerPanel ? (
                      <PanelRightClose className="h-5 w-5" />
                    ) : (
                      <PanelRightOpen className="h-5 w-5" />
                    )}
                  </Button>
                </div>
              </CardHeader>

              {/* Messages */}
              <CardContent className="flex-1 p-4 overflow-hidden">
                <ScrollArea className="h-full">
                  {loadingMessages ? (
                    <div className="space-y-4">
                      {[...Array(5)].map((_, i) => (
                        <div key={i} className={cn("flex", i % 2 === 0 ? "justify-start" : "justify-end")}>
                          <Skeleton className="h-12 w-48" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {groupMessagesByDate(messages || []).map((group) => (
                        <div key={group.date}>
                          {/* Date separator */}
                          <div className="flex items-center justify-center my-4">
                            <div className="bg-muted px-3 py-1 rounded-full">
                              <span className="text-xs text-muted-foreground capitalize">
                                {formatDateHeader(group.date)}
                              </span>
                            </div>
                          </div>

                          {/* Messages */}
                          {group.messages.map((msg) => {
                            const isUser = msg.sender === "user";
                            return (
                              <div
                                key={msg.id}
                                className={cn(
                                  "flex gap-2 mb-3",
                                  isUser ? "justify-start" : "justify-end"
                                )}
                              >
                                {isUser && (
                                  <Avatar className="h-7 w-7 shrink-0">
                                    <AvatarFallback className="bg-blue-100 text-blue-600 text-xs">
                                      <User className="h-3.5 w-3.5" />
                                    </AvatarFallback>
                                  </Avatar>
                                )}
                                <div
                                  className={cn(
                                    "max-w-[75%] rounded-2xl px-4 py-2",
                                    isUser
                                      ? "bg-muted rounded-tl-sm"
                                      : "bg-primary text-primary-foreground rounded-tr-sm"
                                  )}
                                >
                                  {/* Render media if present */}
                                  {(msg as any).media_url && (
                                    <div className="mb-2">
                                      <ChatMediaBubble
                                        mediaUrl={(msg as any).media_url}
                                        mediaType={(msg as any).media_type || "image"}
                                        filename={(msg as any).media_filename}
                                        isOutgoing={!isUser}
                                      />
                                    </div>
                                  )}
                                  {msg.message && (
                                    <p className="text-sm whitespace-pre-wrap break-words">
                                      {msg.message}
                                    </p>
                                  )}
                                  <p className={cn(
                                    "text-[10px] mt-1",
                                    isUser ? "text-muted-foreground" : "text-primary-foreground/70"
                                  )}>
                                    {format(new Date(msg.created_at), "HH:mm")}
                                  </p>
                                </div>
                                {!isUser && (
                                  <Avatar className="h-7 w-7 shrink-0">
                                    <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                      <Bot className="h-3.5 w-3.5" />
                                    </AvatarFallback>
                                  </Avatar>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </ScrollArea>
              </CardContent>

              {/* Reply input with templates */}
              <div className="p-4 border-t">
                <div className="flex gap-2 mb-2">
                  <ChatQuickTemplates onSelectTemplate={handleTemplateSelect} />
                </div>
                
                {/* Media preview */}
                {mediaAttachment && (
                  <div className="mb-3">
                    <MediaPreview 
                      attachment={mediaAttachment} 
                      onRemove={() => setMediaAttachment(null)} 
                    />
                  </div>
                )}

                <div className="flex gap-2 items-center">
                  <MediaAttachmentButton 
                    onAttach={setMediaAttachment}
                    disabled={sendingReply}
                  />
                  <Input
                    placeholder="Responder como humano..."
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendReply();
                      }
                    }}
                    disabled={sendingReply}
                    className="flex-1"
                  />
                  <Button 
                    onClick={handleSendReply} 
                    disabled={(!replyMessage.trim() && !mediaAttachment) || sendingReply}
                    size="icon"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  La respuesta se enviará vía GoHighLevel al contacto
                </p>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Selecciona una conversación</p>
                <p className="text-sm">para ver el historial del bot</p>
              </div>
            </div>
          )}
        </Card>

        {/* Customer Panel - Only on desktop when chat selected */}
        {selectedContact && showCustomerPanel && (
          <Card className="hidden lg:flex w-80 flex-col border rounded-xl">
            <CardHeader className="pb-2 border-b">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                👤 Perfil del Cliente
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden">
              <ChatCustomerPanel
                clientId={null}
                clientEmail={selectedContact.email}
                clientPhone={null}
              />
            </CardContent>

            {/* Agent Status at bottom */}
            <AgentStatusPanel />
          </Card>
        )}
      </div>
    </TooltipProvider>
  );
}

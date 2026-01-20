import { useState, useEffect, useRef } from "react";
import { useConversations, useMessages, useMarkAsRead, useSendMessage, type Conversation, type Message } from "@/hooks/useMessages";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  MessageSquare, 
  Send, 
  Phone, 
  Mail, 
  Search,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Zap,
  Timer
} from "lucide-react";
import { formatDistanceToNow, format, differenceInHours } from "date-fns";
import { es } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

const channelConfig = {
  sms: { 
    icon: Phone, 
    color: "bg-blue-500", 
    textColor: "text-blue-600",
    label: "SMS" 
  },
  whatsapp: { 
    icon: MessageSquare, 
    color: "bg-green-500", 
    textColor: "text-green-600",
    label: "WhatsApp" 
  },
  email: { 
    icon: Mail, 
    color: "bg-orange-500", 
    textColor: "text-orange-600",
    label: "Email" 
  },
};

const statusIcons: Record<string, React.ReactNode> = {
  queued: <Clock className="h-3 w-3 text-muted-foreground" />,
  sent: <Check className="h-3 w-3 text-muted-foreground" />,
  delivered: <CheckCheck className="h-3 w-3 text-muted-foreground" />,
  read: <CheckCheck className="h-3 w-3 text-primary" />,
  failed: <AlertCircle className="h-3 w-3 text-destructive" />,
  received: null,
};

// Check if conversation has 24h window open (last inbound message within 24h)
function hasOpenWindow(lastInboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  const hoursSinceLastInbound = differenceInHours(new Date(), new Date(lastInboundAt));
  return hoursSinceLastInbound < 24;
}

function getWindowTimeLeft(lastInboundAt: string | null): string | null {
  if (!lastInboundAt) return null;
  const hoursSinceLastInbound = differenceInHours(new Date(), new Date(lastInboundAt));
  if (hoursSinceLastInbound >= 24) return null;
  const hoursLeft = 24 - hoursSinceLastInbound;
  if (hoursLeft <= 1) return "< 1h";
  return `${hoursLeft}h`;
}

export default function MessagesPage() {
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const [selectedChannel, setSelectedChannel] = useState<"sms" | "whatsapp">("whatsapp");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: conversations, isLoading: loadingConversations } = useConversations();
  const { data: messages, isLoading: loadingMessages } = useMessages(selectedConversation?.client_id || undefined);
  const markAsRead = useMarkAsRead();
  const sendMessage = useSendMessage();

  // Filter conversations
  const filteredConversations = conversations?.filter((conv) => {
    const query = searchQuery.toLowerCase();
    return (
      conv.client_name?.toLowerCase().includes(query) ||
      conv.client_email?.toLowerCase().includes(query) ||
      conv.client_phone?.toLowerCase().includes(query) ||
      conv.last_message.toLowerCase().includes(query)
    );
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Mark inbound messages as read when conversation is selected
  useEffect(() => {
    if (selectedConversation && messages) {
      messages
        .filter((m) => m.direction === "inbound" && !m.read_at)
        .forEach((m) => markAsRead.mutate(m.id));
    }
  }, [selectedConversation, messages]);

  // Set default channel based on last conversation channel
  useEffect(() => {
    if (selectedConversation?.last_channel) {
      setSelectedChannel(selectedConversation.last_channel === "whatsapp" ? "whatsapp" : "sms");
    }
  }, [selectedConversation]);

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = supabase
      .channel("messages-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          console.log("New message:", payload);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation?.client_id) return;

    const phone = selectedConversation.client_phone;
    if (!phone) return;

    try {
      await sendMessage.mutateAsync({
        clientId: selectedConversation.client_id,
        channel: selectedChannel,
        body: newMessage,
        to: phone,
      });
      setNewMessage("");
    } catch (error) {
      console.error("Error sending message:", error);
    }
  };

  const getInitials = (name: string | null) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  // Group messages by date for better readability
  const groupMessagesByDate = (msgs: Message[]) => {
    const groups: { date: string; messages: Message[] }[] = [];
    let currentDate = "";
    
    const sortedMsgs = [...msgs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    
    for (const msg of sortedMsgs) {
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

  const windowOpen = selectedConversation?.last_inbound_at 
    ? hasOpenWindow(selectedConversation.last_inbound_at) 
    : false;
  const timeLeft = selectedConversation?.last_inbound_at 
    ? getWindowTimeLeft(selectedConversation.last_inbound_at) 
    : null;

  return (
    <TooltipProvider>
      <div className="flex h-[calc(100vh-4rem)] gap-4">
        {/* Conversations List */}
        <Card className={cn(
          "w-full md:w-96 flex flex-col",
          selectedConversation && "hidden md:flex"
        )}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Mensajes
            </CardTitle>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar conversaciones..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-hidden">
            <ScrollArea className="h-full">
              {loadingConversations ? (
                <div className="space-y-2 p-4">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : filteredConversations?.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                  <MessageSquare className="h-8 w-8 mb-2" />
                  <p>No hay conversaciones</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredConversations?.map((conv) => {
                    const convWindowOpen = conv.last_inbound_at 
                      ? hasOpenWindow(conv.last_inbound_at) 
                      : false;
                    const convTimeLeft = conv.last_inbound_at 
                      ? getWindowTimeLeft(conv.last_inbound_at) 
                      : null;
                    const ChannelIcon = channelConfig[conv.last_channel as keyof typeof channelConfig]?.icon || MessageSquare;
                    
                    return (
                      <button
                        key={conv.client_id || "unknown"}
                        onClick={() => setSelectedConversation(conv)}
                        className={cn(
                          "w-full p-4 text-left hover:bg-muted/50 transition-colors relative",
                          selectedConversation?.client_id === conv.client_id && "bg-muted"
                        )}
                      >
                        <div className="flex gap-3">
                          <div className="relative">
                            <Avatar className="h-10 w-10">
                              <AvatarFallback className="bg-primary/10 text-primary text-sm">
                                {getInitials(conv.client_name)}
                              </AvatarFallback>
                            </Avatar>
                            {/* Channel indicator */}
                            <div className={cn(
                              "absolute -bottom-1 -right-1 rounded-full p-0.5",
                              channelConfig[conv.last_channel as keyof typeof channelConfig]?.color || "bg-gray-500"
                            )}>
                              <ChannelIcon className="h-2.5 w-2.5 text-white" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-medium truncate">
                                  {conv.client_name || conv.client_phone || "Desconocido"}
                                </span>
                                {convWindowOpen && (
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <Badge variant="secondary" className="bg-green-100 text-green-700 h-5 px-1.5 gap-0.5 shrink-0">
                                        <Zap className="h-3 w-3" />
                                        {convTimeLeft}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Ventana de 24h abierta - Puedes responder sin plantilla</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {formatDistanceToNow(new Date(conv.last_message_at), {
                                  addSuffix: true,
                                  locale: es,
                                })}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <p className="text-sm text-muted-foreground truncate flex-1">
                                {conv.last_direction === "outbound" && "Tú: "}
                                {conv.last_message}
                              </p>
                              {conv.unread_count > 0 && (
                                <Badge variant="default" className="h-5 min-w-5 justify-center">
                                  {conv.unread_count}
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

        {/* Messages Thread */}
        <Card className={cn(
          "flex-1 flex flex-col",
          !selectedConversation && "hidden md:flex"
        )}>
          {selectedConversation ? (
            <>
              {/* Header */}
              <CardHeader className="pb-3 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="md:hidden"
                      onClick={() => setSelectedConversation(null)}
                    >
                      <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="bg-primary/10 text-primary">
                        {getInitials(selectedConversation.client_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="font-semibold">
                        {selectedConversation.client_name || "Cliente"}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {selectedConversation.client_phone || selectedConversation.client_email}
                      </p>
                    </div>
                  </div>
                  
                  {/* Window status */}
                  {windowOpen ? (
                    <Tooltip>
                      <TooltipTrigger>
                        <Badge className="bg-green-100 text-green-700 gap-1">
                          <Zap className="h-3.5 w-3.5" />
                          Ventana abierta ({timeLeft})
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>El cliente escribió recientemente.</p>
                        <p>Puedes responder texto libre sin plantilla.</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger>
                        <Badge variant="secondary" className="gap-1">
                          <Timer className="h-3.5 w-3.5" />
                          Sin ventana
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Han pasado más de 24h desde el último mensaje del cliente.</p>
                        <p>WhatsApp requiere usar plantillas aprobadas.</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
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
                          
                          {/* Messages for this date */}
                          <div className="space-y-3">
                            {group.messages.map((msg) => {
                              const channel = channelConfig[msg.channel as keyof typeof channelConfig];
                              const ChannelIcon = channel?.icon || MessageSquare;
                              
                              return (
                                <div
                                  key={msg.id}
                                  className={cn(
                                    "flex",
                                    msg.direction === "outbound" ? "justify-end" : "justify-start"
                                  )}
                                >
                                  <div
                                    className={cn(
                                      "max-w-[80%] rounded-2xl px-4 py-2 relative",
                                      msg.direction === "outbound"
                                        ? "bg-primary text-primary-foreground rounded-br-md"
                                        : "bg-muted rounded-bl-md"
                                    )}
                                  >
                                    <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                                    <div className={cn(
                                      "flex items-center gap-1.5 mt-1 text-xs",
                                      msg.direction === "outbound" 
                                        ? "text-primary-foreground/70 justify-end" 
                                        : "text-muted-foreground"
                                    )}>
                                      <span>
                                        {format(new Date(msg.created_at), "HH:mm")}
                                      </span>
                                      {msg.direction === "outbound" && statusIcons[msg.status]}
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className={cn(
                                            "flex items-center gap-0.5",
                                            msg.direction === "outbound" 
                                              ? "text-primary-foreground/70" 
                                              : channel?.textColor
                                          )}>
                                            <ChannelIcon className="h-3 w-3" />
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {channel?.label || msg.channel}
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </ScrollArea>
              </CardContent>

              {/* Input with channel selector */}
              <div className="p-4 border-t space-y-2">
                {/* Channel selector */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Enviar por:</span>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={selectedChannel === "whatsapp" ? "default" : "outline"}
                      className={cn(
                        "gap-1.5 h-7",
                        selectedChannel === "whatsapp" && "bg-green-600 hover:bg-green-700"
                      )}
                      onClick={() => setSelectedChannel("whatsapp")}
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      WhatsApp
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={selectedChannel === "sms" ? "default" : "outline"}
                      className={cn(
                        "gap-1.5 h-7",
                        selectedChannel === "sms" && "bg-blue-600 hover:bg-blue-700"
                      )}
                      onClick={() => setSelectedChannel("sms")}
                    >
                      <Phone className="h-3.5 w-3.5" />
                      SMS
                    </Button>
                  </div>
                  {!windowOpen && selectedChannel === "whatsapp" && (
                    <span className="text-xs text-amber-600 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Requiere plantilla
                    </span>
                  )}
                </div>
                
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMessage();
                  }}
                  className="flex gap-2"
                >
                  <Input
                    placeholder={windowOpen || selectedChannel === "sms" 
                      ? "Escribe un mensaje..." 
                      : "Escribe un mensaje (se usará plantilla si aplica)..."
                    }
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    disabled={sendMessage.isPending}
                  />
                  <Button 
                    type="submit" 
                    size="icon"
                    disabled={!newMessage.trim() || sendMessage.isPending}
                    className={cn(
                      selectedChannel === "whatsapp" && "bg-green-600 hover:bg-green-700",
                      selectedChannel === "sms" && "bg-blue-600 hover:bg-blue-700"
                    )}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <MessageSquare className="h-12 w-12 mb-4" />
              <p className="text-lg font-medium">Selecciona una conversación</p>
              <p className="text-sm">Elige un cliente para ver el historial de mensajes</p>
            </div>
          )}
        </Card>
      </div>
    </TooltipProvider>
  );
}

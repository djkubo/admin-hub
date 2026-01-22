import { useState, useEffect, useRef } from "react";
import { 
  useChatContacts, 
  useChatMessages, 
  useChatEventsRealtime,
  type ChatContact,
  type ChatEvent 
} from "@/hooks/useChatEvents";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Bot, 
  Search,
  ArrowLeft,
  User,
  Send
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export default function BotChatPage() {
  const [selectedContact, setSelectedContact] = useState<ChatContact | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [replyMessage, setReplyMessage] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Enable realtime
  useChatEventsRealtime();

  const { data: contacts, isLoading: loadingContacts } = useChatContacts();
  const { data: messages, isLoading: loadingMessages } = useChatMessages(selectedContact?.contact_id);

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

  // Handle sending reply via Python server -> GoHighLevel
  const handleSendReply = async () => {
    if (!replyMessage.trim() || !selectedContact) return;
    
    setSendingReply(true);
    try {
      const response = await fetch("https://vrp-bot-2.onrender.com/send/ghl", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contact_id: selectedContact.contact_id,
          message: replyMessage,
          channel: "WhatsApp",
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      toast({
        title: "Mensaje enviado",
        description: "El mensaje fue enviado por WhatsApp al contacto",
      });
      setReplyMessage("");
      // El mensaje aparecerá automáticamente via realtime subscription
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

  return (
    <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-4rem)] gap-0 md:gap-4">
      {/* Contacts List */}
      <Card className={cn(
        "w-full md:w-80 lg:w-96 flex flex-col border-0 md:border rounded-none md:rounded-xl",
        selectedContact && "hidden md:flex"
      )}>
        <CardHeader className="pb-3 px-3 md:px-6">
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
                {filteredContacts?.map((contact) => (
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
                          <span className="font-medium truncate">
                            {contact.name || contact.contact_id}
                          </span>
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
                ))}
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
                  <h3 className="font-semibold">
                    {selectedContact.name || "Contacto"}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedContact.email || selectedContact.contact_id}
                  </p>
                </div>
                <Badge variant="secondary" className="gap-1">
                  <Bot className="h-3 w-3" />
                  Bot IA
                </Badge>
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
                                <p className="text-sm whitespace-pre-wrap break-words">
                                  {msg.message}
                                </p>
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

            {/* Reply input */}
            <div className="p-4 border-t">
              <div className="flex gap-2">
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
                  disabled={!replyMessage.trim() || sendingReply}
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
    </div>
  );
}

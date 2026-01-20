import { useState, useEffect, useRef } from "react";
import { useConversations, useMessages, useMarkAsRead, useSendMessage, type Conversation, type Message } from "@/hooks/useMessages";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
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
  AlertCircle
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

const channelIcons: Record<string, React.ReactNode> = {
  sms: <Phone className="h-3 w-3" />,
  whatsapp: <MessageSquare className="h-3 w-3" />,
  email: <Mail className="h-3 w-3" />,
};

const channelColors: Record<string, string> = {
  sms: "bg-blue-500",
  whatsapp: "bg-green-500",
  email: "bg-orange-500",
};

const statusIcons: Record<string, React.ReactNode> = {
  queued: <Clock className="h-3 w-3 text-muted-foreground" />,
  sent: <Check className="h-3 w-3 text-muted-foreground" />,
  delivered: <CheckCheck className="h-3 w-3 text-muted-foreground" />,
  read: <CheckCheck className="h-3 w-3 text-primary" />,
  failed: <AlertCircle className="h-3 w-3 text-destructive" />,
  received: null,
};

export default function MessagesPage() {
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [newMessage, setNewMessage] = useState("");
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

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = supabase
      .channel("messages-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          console.log("New message:", payload);
          // React Query will handle the refetch
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
        channel: selectedConversation.last_channel === "whatsapp" ? "whatsapp" : "sms",
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

  return (
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
                {filteredConversations?.map((conv) => (
                  <button
                    key={conv.client_id || "unknown"}
                    onClick={() => setSelectedConversation(conv)}
                    className={cn(
                      "w-full p-4 text-left hover:bg-muted/50 transition-colors",
                      selectedConversation?.client_id === conv.client_id && "bg-muted"
                    )}
                  >
                    <div className="flex gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarFallback className="bg-primary/10 text-primary text-sm">
                          {getInitials(conv.client_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="font-medium truncate">
                            {conv.client_name || conv.client_phone || "Desconocido"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(conv.last_message_at), {
                              addSuffix: true,
                              locale: es,
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge 
                            variant="secondary" 
                            className={cn("h-5 px-1.5", channelColors[conv.last_channel])}
                          >
                            {channelIcons[conv.last_channel]}
                          </Badge>
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
                ))}
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
                    {[...messages || []].reverse().map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          "flex",
                          msg.direction === "outbound" ? "justify-end" : "justify-start"
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[80%] rounded-2xl px-4 py-2",
                            msg.direction === "outbound"
                              ? "bg-primary text-primary-foreground rounded-br-md"
                              : "bg-muted rounded-bl-md"
                          )}
                        >
                          <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                          <div className={cn(
                            "flex items-center gap-1 mt-1 text-xs",
                            msg.direction === "outbound" 
                              ? "text-primary-foreground/70 justify-end" 
                              : "text-muted-foreground"
                          )}>
                            <span>
                              {format(new Date(msg.created_at), "HH:mm")}
                            </span>
                            {msg.direction === "outbound" && statusIcons[msg.status]}
                            {channelIcons[msg.channel]}
                          </div>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </ScrollArea>
            </CardContent>

            {/* Input */}
            <div className="p-4 border-t">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="flex gap-2"
              >
                <Input
                  placeholder="Escribe un mensaje..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  disabled={sendMessage.isPending}
                />
                <Button 
                  type="submit" 
                  size="icon"
                  disabled={!newMessage.trim() || sendMessage.isPending}
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
  );
}

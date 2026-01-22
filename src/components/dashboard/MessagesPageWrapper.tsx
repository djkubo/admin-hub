import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, Bot, Sparkles } from "lucide-react";
import MessagesPage from "./MessagesPage";
import BotChatPage from "./BotChatPage";
import AIChatInsights from "./AIChatInsights";

export default function MessagesPageWrapper() {
  const [activeTab, setActiveTab] = useState<"bot" | "crm" | "insights">("bot");

  return (
    <div className="h-full flex flex-col">
      {/* Tab switcher */}
      <div className="px-4 pt-4 pb-2">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "bot" | "crm" | "insights")}>
          <TabsList className="grid w-full max-w-lg grid-cols-3">
            <TabsTrigger value="bot" className="gap-2">
              <Bot className="h-4 w-4" />
              <span className="hidden sm:inline">Chat Bot IA</span>
              <span className="sm:hidden">Bot</span>
            </TabsTrigger>
            <TabsTrigger value="crm" className="gap-2">
              <MessageSquare className="h-4 w-4" />
              <span className="hidden sm:inline">CRM Mensajes</span>
              <span className="sm:hidden">CRM</span>
            </TabsTrigger>
            <TabsTrigger value="insights" className="gap-2">
              <Sparkles className="h-4 w-4" />
              <span className="hidden sm:inline">AI Insights</span>
              <span className="sm:hidden">IA</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-4">
        {activeTab === "bot" && <BotChatPage />}
        {activeTab === "crm" && <MessagesPage />}
        {activeTab === "insights" && <AIChatInsights />}
      </div>
    </div>
  );
}

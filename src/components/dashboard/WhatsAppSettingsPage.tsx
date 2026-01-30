import { WhatsAppQRConnect } from "./WhatsAppQRConnect";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Users, History, Settings } from "lucide-react";

export function WhatsAppSettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">WhatsApp Directo</h1>
        <p className="text-muted-foreground">
          Conecta tu cuenta personal de WhatsApp para gestionar conversaciones directamente
        </p>
      </div>

      <Tabs defaultValue="connection" className="space-y-4">
        <TabsList className="bg-zinc-900 border border-zinc-800">
          <TabsTrigger value="connection" className="data-[state=active]:bg-zinc-800">
            <Settings className="h-4 w-4 mr-2" />
            Conexión
          </TabsTrigger>
          <TabsTrigger value="features" className="data-[state=active]:bg-zinc-800">
            <MessageSquare className="h-4 w-4 mr-2" />
            Funciones
          </TabsTrigger>
        </TabsList>

        <TabsContent value="connection" className="space-y-4">
          <WhatsAppQRConnect />
          
          <Card className="bg-zinc-900 border-zinc-800">
            <CardHeader>
              <CardTitle className="text-lg">¿Cómo funciona?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="p-4 rounded-lg bg-zinc-800/50 border border-zinc-700">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">📱</span>
                    <span className="font-medium text-foreground">1. Escanea</span>
                  </div>
                  <p className="text-sm text-zinc-400">
                    Escanea el código QR con tu WhatsApp para vincular tu cuenta
                  </p>
                </div>
                
                <div className="p-4 rounded-lg bg-zinc-800/50 border border-zinc-700">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">🔄</span>
                    <span className="font-medium text-foreground">2. Sincroniza</span>
                  </div>
                  <p className="text-sm text-zinc-400">
                    Tus contactos y conversaciones se sincronizan automáticamente
                  </p>
                </div>
                
                <div className="p-4 rounded-lg bg-zinc-800/50 border border-zinc-700">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">💬</span>
                    <span className="font-medium text-foreground">3. Chatea</span>
                  </div>
                  <p className="text-sm text-zinc-400">
                    Envía y recibe mensajes en tiempo real desde el dashboard
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="features" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <MessageSquare className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-base">Chat en Tiempo Real</CardTitle>
                    <CardDescription>
                      Responde mensajes directamente desde aquí
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Badge className="bg-zinc-800 text-white border-zinc-700">
                  Disponible al conectar
                </Badge>
              </CardContent>
            </Card>
            
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Users className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-base">Importar Contactos</CardTitle>
                    <CardDescription>
                      Sincroniza tu agenda de WhatsApp
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Badge className="bg-zinc-800 text-white border-zinc-700">
                  Disponible al conectar
                </Badge>
              </CardContent>
            </Card>
            
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <History className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-base">Historial de Chats</CardTitle>
                    <CardDescription>
                      Accede a conversaciones anteriores
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Badge className="bg-zinc-800 text-white border-zinc-700">
                  Disponible al conectar
                </Badge>
              </CardContent>
            </Card>
            
            <Card className="bg-zinc-900 border-zinc-800">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Settings className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-base">Automatizaciones</CardTitle>
                    <CardDescription>
                      Conecta con tus flujos existentes
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
                  Próximamente
                </Badge>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Zap, CreditCard, HandHeart, Settings, MessageSquare, Link } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatTemplate {
  id: string;
  name: string;
  content: string;
  icon: typeof Zap;
  category: "recovery" | "welcome" | "support" | "general";
}

const DEFAULT_TEMPLATES: ChatTemplate[] = [
  {
    id: "payment-link",
    name: "Link de Pago",
    content: "Hola! Aquí tienes tu link para actualizar tu método de pago: {{payment_link}}\n\nSi tienes dudas, escríbeme.",
    icon: CreditCard,
    category: "recovery",
  },
  {
    id: "welcome",
    name: "Bienvenida",
    content: "¡Hola {{name}}! 👋\n\nBienvenido/a a VRP. Estoy aquí para ayudarte con lo que necesites.\n\n¿En qué te puedo asistir hoy?",
    icon: HandHeart,
    category: "welcome",
  },
  {
    id: "reset-instructions",
    name: "Reset Password",
    content: "Para restablecer tu contraseña:\n\n1. Ve a la página de login\n2. Click en 'Olvidé mi contraseña'\n3. Ingresa tu email: {{email}}\n4. Revisa tu bandeja (y spam)\n\n¿Pudiste acceder?",
    icon: Settings,
    category: "support",
  },
  {
    id: "followup",
    name: "Seguimiento",
    content: "Hola {{name}}, ¿cómo va todo?\n\nQuería dar seguimiento a nuestra última conversación. ¿Tienes alguna pregunta adicional?",
    icon: MessageSquare,
    category: "general",
  },
  {
    id: "portal-link",
    name: "Portal Stripe",
    content: "Aquí tienes acceso a tu portal de cliente donde puedes:\n\n✅ Ver tus facturas\n✅ Actualizar tu tarjeta\n✅ Gestionar tu suscripción\n\n🔗 {{portal_link}}",
    icon: Link,
    category: "recovery",
  },
];

interface ChatQuickTemplatesProps {
  onSelectTemplate: (template: ChatTemplate) => void;
  className?: string;
}

export function ChatQuickTemplates({ onSelectTemplate, className }: ChatQuickTemplatesProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (template: ChatTemplate) => {
    onSelectTemplate(template);
    setOpen(false);
  };

  const categoryColors = {
    recovery: "border-amber-500/30 bg-amber-500/10",
    welcome: "border-emerald-500/30 bg-emerald-500/10",
    support: "border-blue-500/30 bg-blue-500/10",
    general: "border-gray-500/30 bg-gray-500/10",
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("gap-1.5 h-7 text-xs px-2", className)}
        >
          <Zap className="h-3.5 w-3.5 text-amber-500" />
          <span className="hidden sm:inline">Plantillas</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground px-2 py-1">
            Respuestas rápidas
          </p>
          {DEFAULT_TEMPLATES.map((template) => {
            const Icon = template.icon;
            return (
              <button
                key={template.id}
                onClick={() => handleSelect(template)}
                className={cn(
                  "w-full flex items-center gap-2 p-2 rounded-md text-left hover:bg-muted/80 transition-colors",
                  "border",
                  categoryColors[template.category]
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{template.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {template.content.slice(0, 50)}...
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Helper to replace template variables
export function fillTemplateVariables(
  content: string,
  variables: Record<string, string>
): string {
  let filled = content;
  for (const [key, value] of Object.entries(variables)) {
    filled = filled.replace(new RegExp(`{{${key}}}`, "g"), value || "");
  }
  return filled;
}

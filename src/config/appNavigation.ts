import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CreditCard,
  FileText,
  Home,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  Smartphone,
  TrendingUp,
  Upload,
  Users,
  Workflow,
  DollarSign,
  Cog,
} from "lucide-react";

import { APP_PATHS } from "@/config/appPaths";

export const ROUTE_MAP = {
  dashboard: APP_PATHS.commandCenter,

  // Insights
  analytics: APP_PATHS.analytics,

  // CRM
  inbox: APP_PATHS.inbox,
  clients: APP_PATHS.clients,

  // Growth
  campaigns: APP_PATHS.campaigns,
  broadcast: APP_PATHS.broadcast,
  flows: APP_PATHS.flows,
  whatsapp: APP_PATHS.whatsapp,

  // Revenue
  movements: APP_PATHS.movements,
  invoices: APP_PATHS.invoices,
  subscriptions: APP_PATHS.subscriptions,
  recovery: APP_PATHS.recovery,

  // Ops/Admin
  sync: APP_PATHS.sync,
  diagnostics: APP_PATHS.diagnostics,
  settings: APP_PATHS.settings,
} as const;

export type NavItemId = keyof typeof ROUTE_MAP;

export type NavItem = {
  id: NavItemId;
  label: string;
  icon: LucideIcon;
  path: (typeof ROUTE_MAP)[NavItemId];
};

export type NavGroup = {
  id: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
};

export const NAVIGATION_GROUPS: NavGroup[] = [
  {
    id: "center",
    label: "Centro",
    icon: Home,
    items: [
      { id: "dashboard", label: "Centro de Comando", icon: LayoutDashboard, path: ROUTE_MAP.dashboard },
      { id: "analytics", label: "Analítica", icon: BarChart3, path: ROUTE_MAP.analytics },
    ],
  },
  {
    id: "crm",
    label: "CRM",
    icon: MessageCircle,
    items: [
      { id: "inbox", label: "Bandeja", icon: MessageSquare, path: ROUTE_MAP.inbox },
      { id: "clients", label: "Clientes", icon: Users, path: ROUTE_MAP.clients },
    ],
  },
  {
    id: "growth",
    label: "Crecimiento",
    icon: TrendingUp,
    items: [
      { id: "campaigns", label: "Campañas", icon: Megaphone, path: ROUTE_MAP.campaigns },
      { id: "broadcast", label: "Difusión", icon: Radio, path: ROUTE_MAP.broadcast },
      { id: "flows", label: "Automatizaciones", icon: Workflow, path: ROUTE_MAP.flows },
      { id: "whatsapp", label: "WhatsApp", icon: Smartphone, path: ROUTE_MAP.whatsapp },
    ],
  },
  {
    id: "revenue",
    label: "Ingresos",
    icon: DollarSign,
    items: [
      { id: "movements", label: "Movimientos", icon: Activity, path: ROUTE_MAP.movements },
      { id: "invoices", label: "Facturas", icon: FileText, path: ROUTE_MAP.invoices },
      { id: "subscriptions", label: "Suscripciones", icon: CreditCard, path: ROUTE_MAP.subscriptions },
      { id: "recovery", label: "Recuperación", icon: AlertTriangle, path: ROUTE_MAP.recovery },
    ],
  },
  {
    id: "system",
    label: "Sistema",
    icon: Cog,
    items: [
      { id: "sync", label: "Importar / Sincronizar", icon: Upload, path: ROUTE_MAP.sync },
      { id: "diagnostics", label: "Diagnóstico", icon: Shield, path: ROUTE_MAP.diagnostics },
      { id: "settings", label: "Ajustes", icon: Settings, path: ROUTE_MAP.settings },
    ],
  },
];

export function getNavMetaForPath(pathname: string): { group: NavGroup; item: NavItem } | null {
  for (const group of NAVIGATION_GROUPS) {
    for (const item of group.items) {
      if (pathname === item.path) return { group, item };
    }
  }
  return null;
}

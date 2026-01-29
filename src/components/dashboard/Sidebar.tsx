import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { 
  LayoutDashboard, 
  AlertTriangle,
  FileText,
  Users, 
  CreditCard,
  Upload,
  BarChart3, 
  Settings,
  LogOut,
  Send,
  MessageSquare,
  Shield,
  Menu,
  X,
  Activity
} from "lucide-react";
import vrpLogo from "@/assets/vrp-logo.png";

interface SidebarProps {
  activeItem?: string;
  onItemClick?: (item: string) => void;
}

const menuItems = [
  { id: "dashboard", label: "Command Center", icon: LayoutDashboard },
  { id: "movements", label: "Movimientos", icon: Activity },
  { id: "messages", label: "Mensajes", icon: MessageSquare },
  { id: "recovery", label: "Recovery", icon: AlertTriangle },
  { id: "invoices", label: "Facturas", icon: FileText },
  { id: "clients", label: "Clientes", icon: Users },
  { id: "subscriptions", label: "Suscripciones", icon: CreditCard },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "import", label: "Importar / Sync", icon: Upload },
  { id: "diagnostics", label: "Diagnostics", icon: Shield },
  { id: "campaigns", label: "Campañas", icon: Send },
  { id: "settings", label: "Ajustes", icon: Settings },
];

export function Sidebar({ activeItem = "dashboard", onItemClick }: SidebarProps) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleItemClick = (itemId: string) => {
    onItemClick?.(itemId);
    setIsOpen(false);
  };

  return (
    <>
      {/* Mobile Header - Clean, minimal */}
      <header className="fixed top-0 left-0 right-0 z-50 md:hidden glass-header">
        <div className="flex items-center justify-between h-14 px-4 safe-area-top">
          <div className="flex items-center gap-3">
            <img 
              src={vrpLogo}
              alt="VRP Logo" 
              className="h-8 w-auto"
            />
          </div>
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="p-2.5 rounded-md hover:bg-accent touch-feedback"
            aria-label="Toggle menu"
          >
            {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Mobile Overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar - Premium SaaS Style */}
      <aside 
        className={cn(
          "fixed left-0 top-0 z-40 flex h-screen flex-col bg-sidebar border-r border-border transition-transform duration-300 ease-out",
          "w-[280px] md:w-64",
          "md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo - Clean, minimal */}
        <div className="hidden md:flex h-16 items-center gap-3 border-b border-border px-5">
          <img 
            src={vrpLogo}
            alt="VRP Logo" 
            className="h-9 w-auto"
          />
        </div>

        {/* Mobile: spacer for header */}
        <div className="h-14 md:hidden safe-area-top border-b border-border flex items-center px-4">
          <span className="text-xs font-medium text-muted-foreground tracking-wide">
            Menu
          </span>
        </div>

        {/* Navigation - Clean, minimal */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-1">
            {menuItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeItem === item.id;
              
              return (
                <button
                  key={item.id}
                  onClick={() => handleItemClick(item.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors duration-150 touch-feedback",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <Icon className={cn("h-4 w-4 flex-shrink-0", isActive && "text-primary")} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* User section - Clean */}
        <div className="border-t border-border p-4 safe-area-bottom">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent">
              <span className="text-xs font-semibold text-foreground">VR</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">Admin</p>
              <p className="text-xs text-muted-foreground truncate">V-Remixes Pack</p>
            </div>
            <button className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors touch-feedback">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

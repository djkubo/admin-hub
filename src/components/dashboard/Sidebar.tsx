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
  { id: "dashboard", label: "Command Center", shortLabel: "Home", icon: LayoutDashboard },
  { id: "movements", label: "Movimientos", shortLabel: "Movs", icon: Activity },
  { id: "messages", label: "Mensajes", shortLabel: "Msgs", icon: MessageSquare },
  { id: "recovery", label: "Recovery", shortLabel: "Recovery", icon: AlertTriangle },
  { id: "invoices", label: "Facturas", shortLabel: "Facturas", icon: FileText },
  { id: "clients", label: "Clientes", shortLabel: "Clientes", icon: Users },
  { id: "subscriptions", label: "Suscripciones", shortLabel: "Subs", icon: CreditCard },
  { id: "analytics", label: "Analytics", shortLabel: "Analytics", icon: BarChart3 },
  { id: "import", label: "Importar/Sync", shortLabel: "Import", icon: Upload },
  { id: "diagnostics", label: "Diagnostics", shortLabel: "Diag", icon: Shield },
  { id: "campaigns", label: "Campañas", shortLabel: "Camps", icon: Send },
  { id: "settings", label: "Ajustes", shortLabel: "Config", icon: Settings },
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
      {/* Mobile Header - VRP Glass effect */}
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
            className="p-2.5 rounded-sm hover:bg-accent touch-feedback"
            aria-label="Toggle menu"
          >
            {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Mobile Overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar - VRP Carbon Style */}
      <aside 
        className={cn(
          "fixed left-0 top-0 z-40 flex h-screen flex-col bg-sidebar border-r border-sidebar-border transition-transform duration-300 ease-out",
          // Red accent border on right
          "border-r-2 border-r-primary/20",
          // Responsive width
          "w-[280px] md:w-64",
          // Mobile: slide in/out
          "md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo - VRP Branding */}
        <div className="hidden md:flex h-16 items-center gap-3 border-b border-sidebar-border px-5">
          <img 
            src={vrpLogo}
            alt="VRP Logo" 
            className="h-10 w-auto"
          />
        </div>

        {/* Mobile: spacer for header */}
        <div className="h-14 md:hidden safe-area-top border-b border-sidebar-border flex items-center px-4">
          <span className="text-sm font-heading font-bold uppercase tracking-wider text-primary">
            // MENU
          </span>
        </div>

        {/* Navigation - VRP Style */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 md:py-4">
          <div className="space-y-1">
            {menuItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeItem === item.id;
              
              return (
                <button
                  key={item.id}
                  onClick={() => handleItemClick(item.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-sm px-3.5 py-3 text-sm font-medium transition-all duration-200 touch-feedback",
                    // VRP styling: sharp corners, red accents
                    isActive
                      ? "bg-primary/15 text-white border-l-2 border-l-primary"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-white border-l-2 border-l-transparent"
                  )}
                >
                  <Icon className={cn("h-5 w-5 flex-shrink-0", isActive && "text-primary")} />
                  <span className="truncate font-heading uppercase tracking-wide text-xs">
                    {item.label}
                  </span>
                  {isActive && (
                    <div className="ml-auto h-1.5 w-1.5 rounded-full bg-primary animate-pulse-red" />
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        {/* User section - VRP Style */}
        <div className="border-t border-sidebar-border p-4 safe-area-bottom">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-primary/20 border border-primary/30">
              <span className="text-sm font-heading font-bold text-primary">VR</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">Admin</p>
              <p className="text-xs text-muted-foreground truncate">V-Remixes Pack</p>
            </div>
            <button className="rounded-sm p-2.5 text-muted-foreground hover:bg-sidebar-accent hover:text-white transition-colors touch-feedback">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

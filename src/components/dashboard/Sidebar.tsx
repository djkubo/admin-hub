import { useState, useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { 
  LogOut,
  Menu,
  Search,
  X
} from "lucide-react";
import { toast } from "sonner";
import vrpLogo from "@/assets/vrp-logo.png";
import { NAVIGATION_GROUPS } from "@/config/appNavigation";
import { CommandMenu } from "@/components/dashboard/CommandMenu";

export function Sidebar() {
  const [isOpen, setIsOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

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

  // Close mobile menu on navigation
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  const displayName = user?.user_metadata?.full_name ?? user?.email ?? "Admin";
  const initials = (() => {
    const fromEmail = user?.email?.trim();
    if (fromEmail) return fromEmail.slice(0, 2).toUpperCase();

    const fromName = user?.user_metadata?.full_name?.trim();
    if (fromName) {
      const parts = fromName.split(/\s+/).filter(Boolean);
      const letters = parts.slice(0, 2).map((p: string) => p[0]?.toUpperCase()).join("");
      if (letters) return letters;
    }

    return "VR";
  })();

  const handleLogout = async () => {
    try {
      const { error } = await signOut();
      if (error) {
        toast.error("No se pudo cerrar sesión", {
          description: error.message,
        });
        return;
      }

      toast.success("Sesión cerrada");
      setIsOpen(false);
      navigate("/login");
    } catch (err) {
      toast.error("No se pudo cerrar sesión", {
        description: err instanceof Error ? err.message : "Error inesperado",
      });
    }
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsCommandOpen(true)}
              className="p-2.5 rounded-lg hover:bg-accent touch-feedback"
              aria-label="Buscar"
              type="button"
            >
              <Search className="h-5 w-5" />
            </button>
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="p-2.5 rounded-lg hover:bg-accent touch-feedback"
              aria-label={isOpen ? "Cerrar menú" : "Abrir menú"}
              type="button"
            >
              {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden animate-fade-in"
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
          <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Menú
          </span>
        </div>

        {/* Navigation - Grouped by modules */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {/* Search / command menu trigger */}
          <button
            type="button"
            onClick={() => setIsCommandOpen(true)}
            className={cn(
              "mb-4 flex w-full items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-sm",
              "text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors touch-feedback"
            )}
            aria-label="Abrir buscador"
          >
            <Search className="h-4 w-4" />
            <span className="truncate">Buscar…</span>
            <span className="ml-auto hidden lg:inline text-xs text-muted-foreground">
              ⌘K
            </span>
          </button>

          <div className="space-y-6">
            {NAVIGATION_GROUPS.map((group, groupIndex) => (
              <div key={group.id}>
                {/* Section separator (except first) */}
                {groupIndex > 0 && (
                  <div className="border-t border-border mb-4" />
                )}
                
                {/* Section label */}
                <div className="section-label mb-2">
                  {group.label}
                </div>

                {/* Section items */}
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const to = item.path;
                    
                    return (
                      <NavLink
                        key={item.id}
                        to={to}
                        end={to === "/"}
                        className={({ isActive }) => cn(
                          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 touch-feedback relative",
                          isActive
                            ? "bg-accent text-foreground active-indicator"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        )}
                      >
                        {({ isActive }) => (
                          <>
                            <Icon className={cn(
                              "h-4 w-4 flex-shrink-0 transition-colors",
                              isActive && "text-primary"
                            )} />
                            <span className="truncate">{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* User section - Clean */}
        <div className="border-t border-border p-4 safe-area-bottom">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent">
              <span className="text-xs font-semibold text-foreground">{initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground truncate">VRP Centro de Comando</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors touch-feedback"
              aria-label="Cerrar sesión"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <CommandMenu
        open={isCommandOpen}
        onOpenChange={setIsCommandOpen}
        onLogout={handleLogout}
      />
    </>
  );
}

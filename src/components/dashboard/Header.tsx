import { Search, Bell, Plus, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  title: string;
  subtitle?: string;
  onAddClient?: () => void;
  onSyncData?: () => void;
  isSyncing?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
}

export function Header({ 
  title, 
  subtitle, 
  onAddClient, 
  onSyncData,
  isSyncing,
  searchValue, 
  onSearchChange 
}: HeaderProps) {
  return (
    <header className="flex flex-col gap-3 md:gap-4">
      {/* Title row - VRP Style */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-heading font-bold text-foreground uppercase tracking-wide">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 md:mt-1 text-xs md:text-sm text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        
        {/* Action buttons - VRP Style */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="relative h-9 w-9 touch-feedback rounded-sm">
            <Bell className="h-4 w-4 md:h-5 md:w-5" />
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary animate-pulse-red" />
          </Button>

          {onSyncData && (
            <Button 
              onClick={onSyncData} 
              disabled={isSyncing}
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs touch-feedback rounded-sm font-heading uppercase tracking-wide"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Sync</span>
            </Button>
          )}
          
          {onAddClient && (
            <Button 
              onClick={onAddClient} 
              size="sm"
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-red-600 text-xs touch-feedback rounded-sm font-heading uppercase tracking-wide"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Nuevo</span>
            </Button>
          )}
        </div>
      </div>
      
      {/* Search row - VRP Style */}
      {onSearchChange && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar..."
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full md:w-64 pl-9 bg-card border-border text-sm rounded-sm"
          />
        </div>
      )}
    </header>
  );
}

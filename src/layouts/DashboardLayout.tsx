import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SyncStatusBanner } from "@/components/dashboard/SyncStatusBanner";
import { getNavMetaForPath } from "@/config/appNavigation";
import { useEffect } from "react";

export function DashboardLayout() {
  const location = useLocation();

  useEffect(() => {
    const meta = getNavMetaForPath(location.pathname);
    const pageTitle = meta ? `${meta.item.label} · ${meta.group.label}` : "VRP // SYSTEM";
    document.title = `${pageTitle} · VRP`;
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      
      {/* Main content with responsive padding */}
      <main className="md:pl-64 pt-14 md:pt-0">
        <div className="p-4 md:p-8 safe-area-bottom">
          <Outlet />
        </div>
      </main>

      {/* Persistent sync status banner */}
      <SyncStatusBanner />
    </div>
  );
}

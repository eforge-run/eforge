import type { ReactNode } from 'react';

interface AppLayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  sidebarCollapsed: boolean;
}

export function AppLayout({ header, sidebar, children, sidebarCollapsed }: AppLayoutProps) {
  return (
    <div
      className="grid grid-rows-[auto_1fr] h-screen bg-background gap-x-0 transition-[grid-template-columns] duration-200"
      style={{ gridTemplateColumns: sidebarCollapsed ? '0px 1fr' : '280px 1fr' }}
    >
      {header}
      <div className="overflow-hidden">
        {sidebar}
      </div>
      <div className="overflow-hidden flex flex-col">
        {children}
      </div>
    </div>
  );
}

import type { ReactNode } from 'react';

interface AppLayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppLayout({ header, sidebar, children }: AppLayoutProps) {
  return (
    <div className="grid grid-cols-[280px_1fr] grid-rows-[auto_1fr] h-screen bg-background gap-x-0">
      {header}
      {sidebar}
      <div className="overflow-hidden flex flex-col">
        {children}
      </div>
    </div>
  );
}

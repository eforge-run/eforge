import type { ReactNode } from 'react';

interface AppLayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppLayout({ header, sidebar, children }: AppLayoutProps) {
  return (
    <div className="grid grid-cols-[260px_1fr] grid-rows-[auto_1fr] h-screen">
      {header}
      {sidebar}
      {children}
    </div>
  );
}

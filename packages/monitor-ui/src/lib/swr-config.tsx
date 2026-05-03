import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';

/**
 * Root SWR configuration provider for the monitor UI.
 *
 * Global defaults:
 *   - revalidateOnFocus: true     — revalidate stale data when the tab regains focus
 *   - revalidateOnReconnect: true — revalidate when the browser reconnects
 *   - dedupingInterval: 2000      — deduplicate identical fetches within 2 s
 *   - errorRetryInterval: 5000    — wait 5 s before retrying after an error
 */
export function SWRConfigProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        dedupingInterval: 2000,
        errorRetryInterval: 5000,
      }}
    >
      {children}
    </SWRConfig>
  );
}

import { useEffect, useRef } from 'react';

interface ShutdownBannerProps {
  countdown: number;
}

export function ShutdownBanner({ countdown }: ShutdownBannerProps) {
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function sendKeepAlive() {
    fetch('/api/keep-alive', { method: 'POST' }).catch(() => {});
  }

  function handleKeepAlive() {
    sendKeepAlive();
    // Start periodic pings every 30s to keep server alive
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    pingIntervalRef.current = setInterval(sendKeepAlive, 30_000);
  }

  // Clean up periodic pings on unmount
  useEffect(() => {
    return () => {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-xs">
      <span>
        Server shutting down in <strong>{countdown}s</strong> — no active runs
      </span>
      <button
        onClick={handleKeepAlive}
        className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 cursor-pointer transition-colors"
      >
        Keep Alive
      </button>
    </div>
  );
}

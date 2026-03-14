import { useRef, useState, useCallback, useEffect } from 'react';

interface UseAutoScrollResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
  enableAutoScroll: () => void;
}

export function useAutoScroll(deps: unknown[]): UseAutoScrollResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
  }, []);

  const enableAutoScroll = useCallback(() => {
    setAutoScroll(true);
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Attach scroll listener
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Auto-scroll when deps change
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, autoScroll, enableAutoScroll };
}

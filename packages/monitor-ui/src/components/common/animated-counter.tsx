import { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  value: number;
  format: (n: number) => string;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function AnimatedCounter({ value, format }: AnimatedCounterProps) {
  const prevValueRef = useRef(value);
  const [displayValue, setDisplayValue] = useState(value);
  const [deltaText, setDeltaText] = useState<string | null>(null);
  const [deltaVisible, setDeltaVisible] = useState(false);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const prevValue = prevValueRef.current;
    if (prevValue === value) return;

    const diff = value - prevValue;
    if (diff > 0) {
      // Show delta badge — set text first, then make visible on next frame
      setDeltaText(`+${format(diff)}`);
      requestAnimationFrame(() => setDeltaVisible(true));
      // Start fade-out after a delay, then clear text after transition completes
      const fadeTimer = setTimeout(() => setDeltaVisible(false), 700);
      const clearTimer = setTimeout(() => setDeltaText(null), 1200);

      // Animate from prev to current
      const duration = 300;
      const startTime = performance.now();

      const animate = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeOutCubic(progress);
        setDisplayValue(prevValue + diff * eased);

        if (progress < 1) {
          animationRef.current = requestAnimationFrame(animate);
        } else {
          setDisplayValue(value);
        }
      };

      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = requestAnimationFrame(animate);

      prevValueRef.current = value;
      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(clearTimer);
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
      };
    } else {
      setDisplayValue(value);
      prevValueRef.current = value;
    }
  }, [value, format]);

  return (
    <span className="relative inline-flex items-baseline gap-1">
      <span>{format(Math.round(displayValue))}</span>
      {deltaText && (
        <span
          className="text-[10px] font-normal text-green transition-opacity duration-500"
          style={{ opacity: deltaVisible ? 0.8 : 0 }}
        >
          {deltaText}
        </span>
      )}
    </span>
  );
}

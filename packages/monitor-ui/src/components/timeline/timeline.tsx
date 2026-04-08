import type { StoredEvent } from '@/lib/reducer';
import { EventCard } from './event-card';

interface TimelineProps {
  events: StoredEvent[];
  startTime: number | null;
  showVerbose: boolean;
}

export function Timeline({ events, startTime, showVerbose }: TimelineProps) {
  return (
    <div className="flex flex-col flex-1">
      {events.map((storedEvent, i) => (
        <EventCard
          key={storedEvent.eventId || i}
          event={storedEvent.event}
          startTime={startTime}
          showVerbose={showVerbose}
        />
      ))}
    </div>
  );
}

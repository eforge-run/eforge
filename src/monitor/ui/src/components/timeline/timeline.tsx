import { useState } from 'react';
import type { StoredEvent } from '@/lib/reducer';
import { TimelineControls } from './timeline-controls';
import { EventCard } from './event-card';

interface TimelineProps {
  events: StoredEvent[];
  startTime: number | null;
}

export function Timeline({ events, startTime }: TimelineProps) {
  const [showVerbose, setShowVerbose] = useState(false);

  return (
    <>
      <TimelineControls showVerbose={showVerbose} onToggleVerbose={setShowVerbose} />
      <div className="flex flex-col gap-0.5 flex-1">
        {events.map((storedEvent, i) => (
          <EventCard
            key={storedEvent.eventId || i}
            event={storedEvent.event}
            startTime={startTime}
            showVerbose={showVerbose}
          />
        ))}
      </div>
    </>
  );
}

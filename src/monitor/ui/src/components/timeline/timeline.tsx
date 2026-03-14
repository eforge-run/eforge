import { useState } from 'react';
import type { StoredEvent } from '@/lib/reducer';
import type { PipelineStage } from '@/lib/types';
import type { WaveInfo } from '@/lib/wave-utils';
import { isMultiPlanRun } from '@/lib/wave-utils';
import { TimelineControls } from './timeline-controls';
import { EventCard } from './event-card';
import { WaveTimeline } from './wave-timeline';

interface TimelineProps {
  events: StoredEvent[];
  startTime: number | null;
  waves: WaveInfo[];
  planStatuses: Record<string, PipelineStage>;
}

export function Timeline({ events, startTime, waves, planStatuses }: TimelineProps) {
  const [showVerbose, setShowVerbose] = useState(false);

  return (
    <>
      <TimelineControls showVerbose={showVerbose} onToggleVerbose={setShowVerbose} />
      {isMultiPlanRun(waves) ? (
        <WaveTimeline
          events={events}
          waves={waves}
          planStatuses={planStatuses}
          startTime={startTime}
          showVerbose={showVerbose}
        />
      ) : (
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
      )}
    </>
  );
}

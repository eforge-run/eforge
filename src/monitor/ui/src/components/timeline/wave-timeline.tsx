import type { StoredEvent } from '@/lib/reducer';
import type { PipelineStage } from '@/lib/types';
import type { WaveInfo } from '@/lib/wave-utils';
import { partitionEventsByWave } from '@/lib/wave-utils';
import { EventCard } from './event-card';
import { WaveSection } from './wave-section';

interface WaveTimelineProps {
  events: StoredEvent[];
  waves: WaveInfo[];
  planStatuses: Record<string, PipelineStage>;
  startTime: number | null;
  showVerbose: boolean;
}

export function WaveTimeline({
  events,
  waves,
  planStatuses,
  startTime,
  showVerbose,
}: WaveTimelineProps) {
  const { preWave, waveEvents, postWave } = partitionEventsByWave(events, waves);

  // Sort waves by wave number
  const sortedWaves = [...waves].sort((a, b) => a.wave - b.wave);

  return (
    <div className="flex flex-col gap-2">
      {/* Pre-wave events (planning phase) */}
      {preWave.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {preWave.map((storedEvent, i) => (
            <EventCard
              key={storedEvent.eventId || i}
              event={storedEvent.event}
              startTime={startTime}
              showVerbose={showVerbose}
            />
          ))}
        </div>
      )}

      {/* Wave sections */}
      {sortedWaves.map((wave) => (
        <WaveSection
          key={wave.wave}
          wave={wave}
          planStatuses={planStatuses}
          events={waveEvents.get(wave.wave) || []}
          startTime={startTime}
          showVerbose={showVerbose}
        />
      ))}

      {/* Post-wave events (merge, validation, completion) */}
      {postWave.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {postWave.map((storedEvent, i) => (
            <EventCard
              key={storedEvent.eventId || i}
              event={storedEvent.event}
              startTime={startTime}
              showVerbose={showVerbose}
            />
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EventCard } from './event-card';
import { WaveHeader } from './wave-header';
import { PipelineRow } from '@/components/pipeline/pipeline-row';
import type { StoredEvent } from '@/lib/reducer';
import type { PipelineStage } from '@/lib/types';
import type { WaveInfo, WaveStatus } from '@/lib/wave-utils';
import { computeWaveStatus } from '@/lib/wave-utils';

interface WaveSectionProps {
  wave: WaveInfo;
  planStatuses: Record<string, PipelineStage>;
  events: StoredEvent[];
  startTime: number | null;
  showVerbose: boolean;
}

export function WaveSection({
  wave,
  planStatuses,
  events,
  startTime,
  showVerbose,
}: WaveSectionProps) {
  const status = computeWaveStatus(wave, planStatuses);

  // Running and failed waves default to expanded; completed/pending waves default to collapsed
  const defaultOpen = status === 'running' || status === 'failed';
  const [isOpen, setIsOpen] = useState<boolean | undefined>(undefined);

  // Use explicit user choice if set, otherwise derive from status
  const open = isOpen ?? defaultOpen;

  const completedCount = wave.planIds.filter((id) => planStatuses[id] === 'complete').length;
  const runningCount = wave.planIds.filter(
    (id) => planStatuses[id] === 'implement' || planStatuses[id] === 'review' || planStatuses[id] === 'evaluate',
  ).length;
  const failedCount = wave.planIds.filter((id) => planStatuses[id] === 'failed').length;

  return (
    <Collapsible open={open} onOpenChange={setIsOpen}>
      <div className="border border-border rounded-lg bg-card/50 overflow-hidden">
        <CollapsibleTrigger asChild>
          <div>
            <WaveHeader
              waveNumber={wave.wave}
              planCount={wave.planIds.length}
              completedCount={completedCount}
              runningCount={runningCount}
              failedCount={failedCount}
              status={status}
              isOpen={open}
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 flex flex-col gap-2">
            {/* Pipeline rows for this wave's plans */}
            <div className="pt-1">
              {wave.planIds.map((planId) => (
                <PipelineRow
                  key={planId}
                  planId={planId}
                  currentStage={planStatuses[planId] || 'implement'}
                />
              ))}
            </div>

            {/* Events within this wave */}
            <div className="flex flex-col gap-0.5">
              {events.map((storedEvent, i) => (
                <EventCard
                  key={storedEvent.eventId || i}
                  event={storedEvent.event}
                  startTime={startTime}
                  showVerbose={showVerbose}
                />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

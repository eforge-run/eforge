import { Checkbox } from '@/components/ui/checkbox';

interface TimelineControlsProps {
  showVerbose: boolean;
  onToggleVerbose: (checked: boolean) => void;
}

export function TimelineControls({ showVerbose, onToggleVerbose }: TimelineControlsProps) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-[11px] text-text-dim flex items-center gap-1 cursor-pointer">
        <Checkbox
          checked={showVerbose}
          onCheckedChange={(checked) => onToggleVerbose(checked === true)}
          className="h-3.5 w-3.5"
        />
        Show agent events
      </label>
    </div>
  );
}

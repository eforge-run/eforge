import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface PlanMetadataProps {
  id: string;
  name: string;
  dependsOn: string[];
  branch: string;
  migrations?: Array<{ timestamp: string; description: string }>;
}

export function PlanMetadata({ id, name, dependsOn, branch, migrations }: PlanMetadataProps) {
  const [migrationsExpanded, setMigrationsExpanded] = useState(false);

  return (
    <Card className="border-border bg-bg-tertiary">
      <CardContent className="p-3 space-y-2 text-xs">
        {/* Name */}
        <div className="flex items-baseline gap-2">
          <span className="text-text-dim min-w-[80px]">Name</span>
          <span className="text-foreground font-semibold">{name}</span>
        </div>

        {/* ID */}
        <div className="flex items-baseline gap-2">
          <span className="text-text-dim min-w-[80px]">ID</span>
          <code className="text-foreground font-mono text-[11px] bg-background/50 px-1.5 py-0.5 rounded">
            {id}
          </code>
        </div>

        {/* Branch */}
        {branch && (
          <div className="flex items-baseline gap-2">
            <span className="text-text-dim min-w-[80px]">Branch</span>
            <code className="text-foreground font-mono text-[11px] bg-background/50 px-1.5 py-0.5 rounded">
              {branch}
            </code>
          </div>
        )}

        {/* Dependencies */}
        <div className="flex items-baseline gap-2">
          <span className="text-text-dim min-w-[80px]">Depends on</span>
          <div className="flex flex-wrap gap-1">
            {dependsOn.length > 0 ? (
              dependsOn.map((dep) => (
                <Badge
                  key={dep}
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 font-mono"
                >
                  {dep}
                </Badge>
              ))
            ) : (
              <span className="text-text-dim italic">none</span>
            )}
          </div>
        </div>

        {/* Migrations */}
        {migrations && migrations.length > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="text-text-dim min-w-[80px]">Migrations</span>
            <div>
              <button
                className="bg-transparent border-none text-foreground cursor-pointer text-[11px] p-0 hover:text-blue"
                onClick={() => setMigrationsExpanded(!migrationsExpanded)}
              >
                {migrations.length} migration{migrations.length !== 1 ? 's' : ''}
                {' '}
                <span className="text-text-dim">{migrationsExpanded ? '(hide)' : '(show)'}</span>
              </button>
              {migrationsExpanded && (
                <div className="mt-1 space-y-0.5">
                  {migrations.map((m, i) => (
                    <div key={i} className="text-[11px] text-text-dim">
                      <code className="font-mono">{m.timestamp}</code> — {m.description}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

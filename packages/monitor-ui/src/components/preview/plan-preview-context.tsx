import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { PipelineStage } from '@/lib/types';
import type { ModuleStatus } from '@/lib/reducer';

interface ContentPreview {
  title: string;
  content: string;
}

interface RuntimeData {
  planStatuses: Record<string, PipelineStage>;
  fileChanges: Map<string, string[]>;
  moduleStatuses: Record<string, ModuleStatus>;
}

interface PlanPreviewContextValue {
  selectedPlanId: string | null;
  openPreview: (planId: string) => void;
  contentPreview: ContentPreview | null;
  openContentPreview: (title: string, content: string) => void;
  closePreview: () => void;
  planStatuses: Record<string, PipelineStage>;
  fileChanges: Map<string, string[]>;
  moduleStatuses: Record<string, ModuleStatus>;
  setRuntimeData: (data: RuntimeData) => void;
}

const PlanPreviewContext = createContext<PlanPreviewContextValue | null>(null);

export function PlanPreviewProvider({ children }: { children: ReactNode }) {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [contentPreview, setContentPreview] = useState<ContentPreview | null>(null);
  const [planStatuses, setPlanStatuses] = useState<Record<string, PipelineStage>>({});
  const [fileChanges, setFileChanges] = useState<Map<string, string[]>>(new Map());
  const [moduleStatuses, setModuleStatuses] = useState<Record<string, ModuleStatus>>({});

  const openPreview = useCallback((planId: string) => {
    setContentPreview(null);
    setSelectedPlanId(planId);
  }, []);

  const openContentPreview = useCallback((title: string, content: string) => {
    setSelectedPlanId(null);
    setContentPreview({ title, content });
  }, []);

  const closePreview = useCallback(() => {
    setSelectedPlanId(null);
    setContentPreview(null);
  }, []);

  const setRuntimeData = useCallback((data: RuntimeData) => {
    setPlanStatuses(data.planStatuses);
    setFileChanges(data.fileChanges);
    setModuleStatuses(data.moduleStatuses);
  }, []);

  return (
    <PlanPreviewContext.Provider value={{ selectedPlanId, openPreview, contentPreview, openContentPreview, closePreview, planStatuses, fileChanges, moduleStatuses, setRuntimeData }}>
      {children}
    </PlanPreviewContext.Provider>
  );
}

export function usePlanPreview(): PlanPreviewContextValue {
  const ctx = useContext(PlanPreviewContext);
  if (!ctx) {
    throw new Error('usePlanPreview must be used within a PlanPreviewProvider');
  }
  return ctx;
}

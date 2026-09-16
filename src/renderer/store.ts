import { create } from 'zustand';
import type { AgentHarness } from '../shared/types';

export type ProviderFilter = 'all' | AgentHarness;

interface DashboardUiState {
  providerFilter: ProviderFilter;
  selectedRunId?: string;
  selectedAgentId: string | null;
  setProviderFilter: (providerFilter: ProviderFilter) => void;
  selectRun: (selectedRunId?: string) => void;
  selectAgent: (selectedAgentId: string | null) => void;
}

export const useDashboardStore = create<DashboardUiState>((set) => ({
  providerFilter: 'all',
  selectedRunId: undefined,
  selectedAgentId: null,
  setProviderFilter: (providerFilter) => set({ providerFilter, selectedRunId: undefined, selectedAgentId: null }),
  selectRun: (selectedRunId) => set({ selectedRunId, selectedAgentId: null }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
}));

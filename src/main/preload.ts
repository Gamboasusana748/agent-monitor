import { contextBridge, ipcRenderer } from 'electron';
import type { MonitorBridge, MonitorSnapshot } from '../shared/types';
const bridge: MonitorBridge = {
  getSnapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  getTrace: agentId => ipcRenderer.invoke('monitor:trace', agentId),
  loadRun: runId => ipcRenderer.invoke('monitor:load-run', runId),
  onSnapshot: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: MonitorSnapshot) => callback(snapshot);
    ipcRenderer.on('monitor:changed', listener);
    return () => ipcRenderer.removeListener('monitor:changed', listener);
  },
};
contextBridge.exposeInMainWorld('agentMonitor', bridge);

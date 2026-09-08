const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  logout: () => ipcRenderer.invoke('crm-logout'),
});

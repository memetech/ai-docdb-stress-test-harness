const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stressTest', {
  run: argumentsText => ipcRenderer.invoke('stress-test:run', argumentsText),
});

'use strict';
// The only bridge between the sandboxed page and the main process. Narrow on purpose.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('vc', {
  openDialog: () => invoke('vc:open-dialog'),
  analyze: p => invoke('vc:analyze', p),
  release: id => invoke('vc:release', id),
  plan: opts => invoke('vc:plan', opts),
  deepScan: id => invoke('vc:deepscan', id),
  exportConformed: opts => invoke('vc:export-conform', opts),
  cancelExport: () => invoke('vc:cancel-export'),
  savePngs: files => invoke('vc:save-pngs', files),
  reveal: p => invoke('vc:reveal', p),
  tools: () => invoke('vc:tools'),
  ready: () => invoke('vc:renderer-ready'),
  // taskbar / shortcut integration: the page reports its state, the main process sends commands back
  state: s => ipcRenderer.send('vc:state', s),
  onCommand: cb => ipcRenderer.on('vc:command', (_e, cmd) => cb(cmd)),
  onOpenFiles: cb => ipcRenderer.on('vc:open-files', (_e, paths) => cb(paths)),
  onProgress: cb => ipcRenderer.on('vc:progress', (_e, msg) => cb(msg)),
  // File paths of dropped files can only be read here, via webUtils.
  onDropFiles: cb => {
    window.addEventListener('drop', e => {
      e.preventDefault();
      const paths = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map(f => webUtils.getPathForFile(f)).filter(Boolean);
      if (paths.length) cb(paths);
    });
  },
});

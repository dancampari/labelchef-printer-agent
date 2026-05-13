const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronSpoolerAPI', {
    onInjectHtml: (callback) => ipcRenderer.on('inject-html-for-print', callback),
    sendReadyToPrint: (id, printerName, widthMicrons) => ipcRenderer.send('spooler-ready-to-print', { id, printerName, widthMicrons })
});

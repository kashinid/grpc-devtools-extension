// background.js

// Храним порты DevTools по tabId
const devToolsPorts = {};
// Храним порты от content scripts по tabId
const contentScriptPorts = {};

// Храним информацию о состоянии панелей
const panelStates = {};

// Подключаемся через порты
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'grpc-devtools-port') {
    // Это DevTools панель
    port.onMessage.addListener((message) => {
      if (message.type === 'init') {
        const tabId = message.tabId;
        if (typeof tabId === 'number') {
          // Сохраняем состояние панели
          panelStates[tabId] = {
            port,
            isActive: true,
            lastActive: Date.now()
          };

          devToolsPorts[tabId] = port;

          port.onDisconnect.addListener(() => {
            console.debug(`[background] Panel for tab ${tabId} disconnected`);
            handlePanelDisconnection(tabId);
          });
        }
      } else if (message.action === 'panelClosed') {
        const tabId = message.tabId;
        if (typeof tabId === 'number' && panelStates[tabId]) {
          panelStates[tabId].isActive = false;
          console.debug(`[background] Panel for tab ${tabId} explicitly closed`);
        }
      }
    });
  }
  else if (port.name === 'grpc-devtools-content') {
    // Это content script
    const tabId = port.sender.tab.id;

    // Сохраняем порт content script
    if (!contentScriptPorts[tabId]) {
      contentScriptPorts[tabId] = [];
    }
    contentScriptPorts[tabId].push(port);

    port.onMessage.addListener((message) => {
      // Пересылаем сообщения от content script в DevTools
      if (message.action === 'gRPCNetworkCall') {
        const devToolsPort = devToolsPorts[tabId];
        if (devToolsPort) {
          devToolsPort.postMessage(message);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      // Удаляем порт content script ТОЛЬКО ЕСЛИ он существует
      if (contentScriptPorts[tabId] && Array.isArray(contentScriptPorts[tabId])) {
        contentScriptPorts[tabId] = contentScriptPorts[tabId].filter(p => p !== port);
        if (contentScriptPorts[tabId].length === 0) {
          delete contentScriptPorts[tabId];
        }
      }

      // Проверяем, не закрыта ли панель
      if (devToolsPorts[tabId]) {
        console.debug(`[background] Content script disconnected for tab ${tabId}, but panel is still active`);
      }
    });
  }
});

// Обработчик отключения панели
function handlePanelDisconnection(tabId) {
  console.debug(`[background] Cleaning up resources for tab ${tabId}`);

  // Удаляем состояние панели
  delete panelStates[tabId];

  // Очищаем любые связанные ресурсы
  if (contentScriptPorts[tabId] && Array.isArray(contentScriptPorts[tabId])) {
    // Отправляем сигнал content script о том, что панель закрыта
    contentScriptPorts[tabId].forEach(port => {
      try {
        port.postMessage({
          action: 'panelClosed',
          tabId: tabId
        });
      } catch (e) {
        console.debug(`[background] Could not notify content script for tab ${tabId}`);
      }
    });
  }

  // Удаляем записи о tabId
  delete devToolsPorts[tabId];
  delete contentScriptPorts[tabId];

  console.debug(`[background] Resources cleaned up for tab ${tabId}`);
}

// Для обратной совместимости с некоторыми сообщениями
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, target, tabId: msgTabId } = message;
  const tabId = msgTabId || (sender.tab && sender.tab.id);

  if (tabId === undefined) {
    console.warn('[background] Cannot determine tabId', message);
    return;
  }

  if (target) {
    if (target === 'panel') {
      const port = devToolsPorts[tabId];
      if (port) {
        port.postMessage(message);
      }
    } else if (target === 'content') {
      chrome.tabs.sendMessage(tabId, message, { frameId: message.frameId }).catch(() => { });
    }
    return true;
  }
});

// Дополнительная очистка при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  console.debug(`[background] Tab ${tabId} closed, cleaning up`);
  handlePanelDisconnection(tabId);
});
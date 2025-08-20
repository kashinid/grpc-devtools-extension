// content-script.js

// Флаги для отслеживания состояния внедрения скриптов
let grpcWebInjectInjected = false;
let connectWebInterceptorInjected = false;

// === 1. Внедряем grpc-web-inject.js как внешний скрипт ===
function injectGrpcWebScript() {
  if (grpcWebInjectInjected) {
    console.debug('[content-script] grpc-web-inject.js already injected, skipping');
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('grpc-web-inject.js');
  script.onload = () => {
    script.remove();
    grpcWebInjectInjected = true;
    console.debug('[content-script] grpc-web-inject.js injected and cleaned up');
  };
  script.onerror = (e) => {
    console.error('[content-script] Failed to load grpc-web-inject.js', e);
    grpcWebInjectInjected = false;
  };
  (document.head || document.documentElement).appendChild(script);
}

// === 2. Внедряем connect-web-interceptor.js ===
function injectConnectWebScript() {
  if (connectWebInterceptorInjected) {
    console.debug('[content-script] connect-web-interceptor.js already injected, skipping');
    return;
  }

  const cs = document.createElement('script');
  cs.src = chrome.runtime.getURL('connect-web-interceptor.js');
  cs.onload = () => {
    cs.remove();
    connectWebInterceptorInjected = true;
    console.debug('[content-script] connect-web-interceptor.js injected and cleaned up');
  };
  cs.onerror = (e) => {
    console.error('[content-script] Failed to load connect-web-interceptor.js', e);
    connectWebInterceptorInjected = false;
  };
  (document.head || document.documentElement).appendChild(cs);
}

// Внедряем скрипты при первой загрузке
injectGrpcWebScript();
injectConnectWebScript();

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
// Вспомогательная функция для очистки данных перед сериализацией
function sanitizeForSerialization(obj) {
  if (obj === undefined) return undefined;
  if (obj === null) return null;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  try {
    // Попробуем сериализовать и десериализовать
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    // Если не получается, возвращаем упрощенное представление
    return {
      _type: typeof obj,
      _string: String(obj),
      _hasCircular: true
    };
  }
}

// === ПОРТЫ ДЛЯ УСТОЙЧИВОЙ КОММУНИКАЦИИ ===
let devToolsPort = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let panelConnected = true; // Флаг для отслеживания состояния панели

// === Обработчик для BFCache ===
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    console.debug('[content-script] Page restored from BFCache, reconnecting...');

    // Сбрасываем состояние подключения
    panelConnected = true;

    // Пересоздаем порт
    if (devToolsPort) {
      try {
        devToolsPort.disconnect();
      } catch (e) {
        console.debug('[content-script] Error disconnecting port', e);
      }
      devToolsPort = null;
    }

    // Пытаемся переподключиться
    connectToDevTools();

    // Перезапускаем скрипты ТОЛЬКО ЕСЛИ они были удалены
    if (!grpcWebInjectInjected) {
      injectGrpcWebScript();
    }
    if (!connectWebInterceptorInjected) {
      injectConnectWebScript();
    }

    // Повторно регистрируем обработчик сообщений
    window.removeEventListener('message', handleMessageEvent);
    window.addEventListener('message', handleMessageEvent, false);
  }
});

// Добавляем обработчик для visibilitychange
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    console.debug('[content-script] Page became visible, checking connection...');

    // Если соединение отсутствует, пытаемся переподключиться
    if (!devToolsPort || !panelConnected) {
      if (devToolsPort) {
        try {
          devToolsPort.disconnect();
        } catch (e) {
          console.debug('[content-script] Error disconnecting port', e);
        }
        devToolsPort = null;
      }

      connectToDevTools();

      // Перезапускаем скрипты, если они были удалены
      if (!grpcWebInjectInjected) {
        injectGrpcWebScript();
      }
      if (!connectWebInterceptorInjected) {
        injectConnectWebScript();
      }
    }
  }
});

function connectToDevTools() {
  try {
    // Создаем порт для коммуникации с background
    devToolsPort = chrome.runtime.connect({ name: 'grpc-devtools-content' });

    // Обработчик отключения
    devToolsPort.onDisconnect.addListener(() => {
      console.debug('[content-script] DevTools port disconnected');
      devToolsPort = null;
      panelConnected = false;

      // Проверяем, видима ли страница перед переподключением
      if (document.visibilityState === 'visible') {
        // Попытка переподключения
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          console.debug(`[content-script] Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          setTimeout(connectToDevTools, 500);
        }
      }
    });

    // Сброс счетчика попыток при успешном подключении
    reconnectAttempts = 0;
    panelConnected = true;
  } catch (error) {
    console.debug('[content-script] Failed to connect to DevTools', error);
    panelConnected = false;
  }
}

// Инициируем подключение
connectToDevTools();

// === 3. ОБНОВЛЕННЫЙ обработчик сообщений ===
function handleMessageEvent(event) {
  // Проверяем источник: только из той же страницы
  if (event.source !== window) return;

  // Фильтруем по типу сообщения
  if (event.data?.type !== '__GRPCWEB_DEVTOOLS__') return;

  // КРИТИЧЕСКИ ВАЖНО: очищаем данные перед отправкой
  const cleanData = {
    method: event.data.method,
    methodType: event.data.methodType,
    request: sanitizeForSerialization(event.data.request),
    response: sanitizeForSerialization(event.data.response),
    error: sanitizeForSerialization(event.data.error)
  };

  // Отправляем через порт, если он доступен и панель подключена
  if (devToolsPort && panelConnected) {
    try {
      devToolsPort.postMessage({
        action: 'gRPCNetworkCall',
        target: 'panel',
        data: cleanData
      });
    } catch (error) {
      // Игнорируем ошибку, связанную с BFCache
      if (error.message && error.message.includes('message channel is closed')) {
        console.debug('[content-script] Port closed due to BFCache, ignoring message');
        panelConnected = false;
        return;
      }
      console.debug('[content-script] Failed to send message via port', error);
      devToolsPort = null;
      panelConnected = false;
      connectToDevTools();
    }
  } else {
    console.debug('[content-script] DevTools port not available or panel closed, skipping message');
  }
}

// === Обработчик сообщений от background ===
function handleBackgroundMessage(message) {
  if (message.action === 'panelClosed') {
    panelConnected = false;
    console.debug('[content-script] DevTools panel closed, resources will be cleaned up');
  }
}

// Подписываемся на сообщения
window.addEventListener('message', handleMessageEvent, false);

// Подписываемся на сообщения от background
chrome.runtime.onMessage.addListener(handleBackgroundMessage);

// === Очистка при разгрузке страницы ===
window.addEventListener('beforeunload', () => {
  if (!panelConnected) {
    // Если панель уже закрыта, можно выполнить дополнительную очистку
    console.debug('[content-script] Page unloading with closed panel, cleaning up');
  }
});
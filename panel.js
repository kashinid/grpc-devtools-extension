// panel.js

// === DOM Elements ===
const requestsList = document.getElementById("requests-list");
const details = document.getElementById("details");
const detailMethod = document.getElementById("detail-method");
const detailType = document.getElementById("detail-type");
const detailRequest = document.getElementById("detail-request");
const detailResponse = document.getElementById("detail-response");
const detailError = document.getElementById("detail-error");

const clearBtn = document.getElementById("clear-btn");
const captureToggle = document.getElementById("capture-toggle");

const searchInput = document.getElementById("search-input");
const clearSearchBtn = document.getElementById("clear-search");
const searchPrevBtn = document.getElementById("search-prev");
const searchNextBtn = document.getElementById("search-next");
const searchCountSpan = document.getElementById("search-count");

// === ПОЛУЧАЕМ tabId ИЗ DevTools API ===
let inspectedTabId = null;
let port = null;
let contextValid = true;
let isInitializing = false;

// Попытаемся получить tabId безопасно
try {
  inspectedTabId = chrome.devtools.inspectedWindow.tabId;
} catch (e) {
  console.debug('[panel] Could not get tabId, extension context may be invalid', e);
  contextValid = false;
}

// Проверка действительности контекста расширения
function isExtensionContextValid() {
  try {
    // Проверяем базовые API Chrome
    return typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.id === 'string' &&
      chrome.devtools &&
      chrome.devtools.inspectedWindow;
  } catch (e) {
    return false;
  }
}

// Инициализация соединения
function initConnection() {
  if (!isExtensionContextValid()) {
    console.debug('[panel] Extension context is invalid, cannot initialize connection');
    contextValid = false;
    return false;
  }

  try {
    // Очищаем старый порт, если он существует
    if (port) {
      try {
        port.disconnect();
      } catch (e) {
        // Игнорируем ошибку
      }
      port = null;
    }

    port = chrome.runtime.connect({ name: 'grpc-devtools-port' });

    // Настройка обработчика сообщений
    port.onMessage.addListener(messageListener);

    // Отправляем tabId
    if (inspectedTabId === null) {
      try {
        inspectedTabId = chrome.devtools.inspectedWindow.tabId;
      } catch (e) {
        console.debug('[panel] Could not get tabId during initialization', e);
        return false;
      }
    }

    port.postMessage({ type: 'init', tabId: inspectedTabId });
    console.debug('[panel] Connection initialized successfully');
    return true;
  } catch (e) {
    console.debug('[panel] Failed to initialize connection', e);
    return false;
  }
}

// === State ===
let requests = [];
let selectedId = null;
let isCapturing = true;
let requestIdCounter = 0;

let currentSearch = "";
let allHighlights = [];
let currentHighlightIndex = -1;
let isNavigating = false;
let hasSearchResults = false;
let userInitiatedSelection = false;

// Таймеры для debounce и отложенных операций
let searchDebounceTimer = null;

// === Safe JSON Stringify ===
function safeStringify(obj) {
  if (obj === undefined) return '(undefined)';
  if (obj === null) return 'null';
  if (typeof obj === 'string' && obj === "EOF") return "Stream ended (EOF)";
  if (obj === "EOF") return "Stream ended (EOF)";

  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    }, 2);
  } catch (e) {
    return '(invalid JSON)';
  }
}

// === Highlight Utility ===
function highlightInElement(element, query) {
  if (!query || !element) return;
  const text = element.textContent;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  element.innerHTML = text.replace(regex, '<mark class="highlight">$1</mark>');
}

// === UI Functions ===
function renderList() {
  if (!contextValid) return;

  const filteredRequests = filterRequests();
  const query = currentSearch.trim().toLowerCase();

  // Обновляем флаг наличия результатов поиска
  hasSearchResults = query && filteredRequests.length > 0;

  requestsList.innerHTML = '';

  if (filteredRequests.length === 0) {
    const message = currentSearch ? 'Ничего не найдено' : 'Нет gRPC-вызовов';
    requestsList.innerHTML = `<div class="empty">${message}</div>`;
    return;
  }

  filteredRequests.forEach((req, index) => {
    const item = document.createElement("div");
    item.className = "request-item";

    // ВСЕГДА выделяем выбранный запрос, даже если он не соответствует поисковому запросу
    if (req.id === selectedId) {
      item.classList.add("selected");
    }

    const methodParts = req.method.split('/');
    const methodShort = methodParts.pop() || 'unknown';
    const serviceShort = methodParts.pop() || 'unknown';

    // Подсветка в названиях
    const methodNameEl = document.createElement('span');
    methodNameEl.className = 'method-name';
    highlightInElement(methodNameEl, query);
    methodNameEl.textContent = methodShort;

    const methodTypeEl = document.createElement('span');
    methodTypeEl.className = 'method-type';
    highlightInElement(methodTypeEl, query);
    methodTypeEl.textContent = req.methodType;

    const serviceEl = document.createElement('div');
    serviceEl.style.fontSize = '0.8em';
    serviceEl.style.color = 'var(--text-light)';
    highlightInElement(serviceEl, query);
    serviceEl.textContent = serviceShort;

    item.appendChild(methodNameEl);
    item.appendChild(methodTypeEl);
    item.appendChild(serviceEl);

    item.onclick = () => toggleRequest(req.id);
    requestsList.appendChild(item);
  });
}

function toggleRequest(id) {
  if (!contextValid) return;

  userInitiatedSelection = true; // Помечаем, что выбор инициирован пользователем

  if (selectedId === id) {
    selectedId = null;
    details.style.display = 'none';
  } else {
    selectedId = id;
    const req = requests.find(r => r.id === id);
    if (!req) return;

    detailMethod.textContent = req.method;
    detailType.textContent = req.methodType;

    detailRequest.textContent = req.request ? safeStringify(req.request) : '(нет данных)';
    detailResponse.textContent = req.response ? safeStringify(req.response) : '(нет данных)';
    detailError.textContent = req.error ? safeStringify(req.error) : '(нет ошибки)';

    details.style.display = 'block';

    // Сбрасываем индекс совпадения при переключении на новый запрос
    if (!isNavigating) {
      currentHighlightIndex = 0;
    }

    // Прокручиваем к выбранному элементу для лучшей видимости
    setTimeout(() => {
      const selectedItem = document.querySelector('.request-item.selected');
      if (selectedItem) {
        selectedItem.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
      }
    }, 50);
  }

  // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: ВСЕГДА ОБНОВЛЯЕМ СПИСОК ПОСЛЕ ВЫБОРА ЗАПРОСА
  renderList();

  // Перезапускаем поиск только если есть активный поисковый запрос
  if (currentSearch.trim()) {
    performSearch();
  }

  // Сбрасываем флаг ПОСЛЕ ВЫПОЛНЕНИЯ ВСЕХ ОПЕРАЦИЙ
  setTimeout(() => {
    userInitiatedSelection = false;
  }, 0);
}

// === Search & Highlight ===
function performSearch() {
  if (!contextValid) return;

  const query = currentSearch.trim();
  clearHighlights();

  if (!query) {
    renderList();
    return;
  }

  // Подсветка в деталях (если есть выбранный запрос)
  if (selectedId) {
    highlightInElement(detailRequest, query);
    highlightInElement(detailResponse, query);
    highlightInElement(detailError, query);

    // Сбор совпадений для навигации
    allHighlights = Array.from(details.querySelectorAll('pre mark.highlight'));

    // Удаляем класс текущего выделения
    document.querySelectorAll('mark.highlight-current').forEach(el => {
      el.classList.remove('highlight-current');
    });

    // Добавляем класс текущему выделению
    if (currentHighlightIndex >= 0 && allHighlights[currentHighlightIndex]) {
      allHighlights[currentHighlightIndex].classList.add('highlight-current');
    }

    // Устанавливаем индекс на 0, если он был сброшен
    if (allHighlights.length > 0 && currentHighlightIndex < 0) {
      currentHighlightIndex = 0;
    }

    updateSearchCount();

    if (allHighlights.length > 0 && currentHighlightIndex >= 0) {
      scrollToCurrentHighlight();
    }
  }

  // Перерисовываем список с подсветкой
  renderList();

  // Автоматически выбираем первый запрос с совпадением ТОЛЬКО если:
  // 1. Есть поисковый запрос
  // 2. Нет навигации
  // 3. Нет выбранного запроса ИЛИ выбранный запрос не соответствует поиску
  // 4. Выбор НЕ инициирован пользователем
  if (query && !isNavigating && !userInitiatedSelection) {
    const filteredRequests = filterRequests();
    if (filteredRequests.length > 0 && (!selectedId || !hasSearchResultsForSelected())) {
      // Выбираем первый запрос с совпадением
      toggleRequest(filteredRequests[0].id);
    }
  }
}

// Проверяем, есть ли совпадения в текущем выбранном запросе
function hasSearchResultsForSelected() {
  if (!selectedId || !currentSearch.trim()) return false;
  const filteredRequests = filterRequests();
  return filteredRequests.some(req => req.id === selectedId);
}

function filterRequests() {
  if (!contextValid) return [];

  const query = currentSearch.toLowerCase().trim();
  if (!query) return requests;

  return requests.filter(req => {
    const reqStr = (req.request ? safeStringify(req.request) : '').toLowerCase();
    const resStr = (req.response ? safeStringify(req.response) : '').toLowerCase();
    const errStr = (req.error ? safeStringify(req.error) : '').toLowerCase();
    const methodStr = req.method.toLowerCase();
    return methodStr.includes(query) || reqStr.includes(query) || resStr.includes(query) || errStr.includes(query);
  });
}

function updateSearchCount() {
  if (!contextValid) return;

  searchCountSpan.textContent = allHighlights.length > 0
    ? `${currentHighlightIndex + 1}/${allHighlights.length}`
    : '0/0';
}

function scrollToCurrentHighlight() {
  if (!contextValid || currentHighlightIndex < 0 || !allHighlights[currentHighlightIndex]) return;

  allHighlights[currentHighlightIndex].scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });
}

function clearHighlights() {
  if (!contextValid) return;

  // Очищаем детали
  [detailRequest, detailResponse, detailError].forEach(el => {
    if (el && el.children.length > 0) {
      el.textContent = el.textContent;
    }
  });

  // Очищаем подсветку в списке
  document.querySelectorAll('.request-item .method-name, .request-item .method-type, .request-item div')
    .forEach(el => {
      if (el && el.children.length > 0) {
        el.textContent = el.textContent;
      }
    });

  allHighlights = [];
  currentHighlightIndex = -1;
  updateSearchCount();
}

// === Controls ===
clearBtn.onclick = () => {
  if (!contextValid) return;

  requests = [];
  selectedId = null;
  details.style.display = 'none';
  renderList();

  if (isExtensionContextValid()) {
    chrome.runtime.sendMessage({ action: "clearRequests" });
  }
};

function updateCaptureButton() {
  if (!contextValid) return;

  captureToggle.classList.toggle("on", isCapturing);
  captureToggle.classList.toggle("off", !isCapturing);
  captureToggle.title = isCapturing ? "Перехват включён" : "Перехват выключен";
}

captureToggle.onclick = () => {
  if (!contextValid) return;

  isCapturing = !isCapturing;
  updateCaptureButton();

  if (isExtensionContextValid()) {
    chrome.runtime.sendMessage({ action: "setCapture", enabled: isCapturing });
  }
};

// === Search Controls ===
searchInput.addEventListener("input", () => {
  if (!contextValid) return;

  currentSearch = searchInput.value;
  isNavigating = false;

  // Очищаем предыдущий таймер
  clearTimeout(searchDebounceTimer);

  // Используем debounce для поиска
  searchDebounceTimer = setTimeout(() => {
    performSearch();

    // Обновляем состояние кнопок навигации
    updateNavigationButtonsState();

    // Добавляем небольшую задержку для отрисовки
    setTimeout(() => {
      updateSearchCount();
    }, 100);
  }, 300);
});

searchInput.addEventListener("keydown", (e) => {
  if (!contextValid) return;

  if (e.key === "Escape") {
    clearSearchBtn.click();
    searchInput.blur();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (hasSearchResults) {
      searchNextBtn.click();
    }
  }
});

clearSearchBtn.onclick = () => {
  if (!contextValid) return;

  searchInput.value = "";
  currentSearch = "";
  isNavigating = false;
  hasSearchResults = false;
  performSearch(); // Сброс + перерисовка
  updateNavigationButtonsState();
};

// Обновляем состояние кнопок навигации
function updateNavigationButtonsState() {
  if (!contextValid) return;

  const hasResults = currentSearch.trim() && hasSearchResults;

  searchPrevBtn.disabled = !hasResults;
  searchNextBtn.disabled = !hasResults;

  // Добавляем визуальное отключение
  if (!hasResults) {
    searchPrevBtn.style.opacity = "0.5";
    searchNextBtn.style.opacity = "0.5";
  } else {
    searchPrevBtn.style.opacity = "1";
    searchNextBtn.style.opacity = "1";
  }
}

searchNextBtn.onclick = () => {
  if (!contextValid || !hasSearchResults) return;

  isNavigating = true;

  if (allHighlights.length === 0) {
    const filteredRequests = filterRequests();
    if (filteredRequests.length > 0) {
      // Переходим к следующему запросу
      const currentIndex = filteredRequests.findIndex(req => req.id === selectedId);
      if (currentIndex < filteredRequests.length - 1) {
        toggleRequest(filteredRequests[currentIndex + 1].id);
      } else {
        // Вернуться к первому запросу
        toggleRequest(filteredRequests[0].id);
      }
    }
    return;
  }

  currentHighlightIndex = (currentHighlightIndex + 1) % allHighlights.length;
  updateSearchCount();
  scrollToCurrentHighlight();

  setTimeout(() => {
    isNavigating = false;
  }, 100);
};

searchPrevBtn.onclick = () => {
  if (!contextValid || !hasSearchResults) return;

  isNavigating = true;

  if (allHighlights.length === 0) {
    const filteredRequests = filterRequests();
    if (filteredRequests.length > 0) {
      // Переходим к предыдущему запросу
      const currentIndex = filteredRequests.findIndex(req => req.id === selectedId);
      if (currentIndex > 0) {
        toggleRequest(filteredRequests[currentIndex - 1].id);
      } else {
        // Перейти к последнему запросу
        toggleRequest(filteredRequests[filteredRequests.length - 1].id);
      }
    }
    return;
  }

  currentHighlightIndex = (currentHighlightIndex - 1 + allHighlights.length) % allHighlights.length;
  updateSearchCount();
  scrollToCurrentHighlight();

  setTimeout(() => {
    isNavigating = false;
  }, 100);
};

// === Message Listener ===
const messageListener = (message) => {
  if (!contextValid || message.action !== "gRPCNetworkCall" || !isCapturing) return;

  const data = message.data;
  const id = ++requestIdCounter;

  const request = {
    id,
    method: data.method,
    methodType: data.methodType,
    request: data.request,
    response: data.response,
    error: data.error,
    timestamp: Date.now(),
  };

  requests.push(request);

  if (requests.length > 100) {
    requests.shift();
  }

  if (!selectedId) {
    toggleRequest(id);
  } else {
    renderList();
  }
};

// === Проверка и восстановление соединения ===
function checkAndRestoreConnection() {
  if (!contextValid) {
    console.debug('[panel] Context is not valid, cannot check connection');
    return false;
  }

  if (!isExtensionContextValid()) {
    console.debug('[panel] Extension context is invalid');
    contextValid = false;
    cleanupResources();
    return false;
  }

  // Проверяем, можем ли мы отправить сообщение
  try {
    if (port) {
      port.postMessage({ action: 'ping' });
      return true;
    }
  } catch (e) {
    // Если ошибка связана с недействительным контекстом, помечаем контекст как недействительный
    if (e.message && e.message.includes('Extension context invalidated')) {
      console.debug('[panel] Extension context invalidated, marking as invalid');
      contextValid = false;
      cleanupResources();
      return false;
    }
  }

  // Если порта нет или он недоступен, пытаемся восстановить соединение
  if (!port || !isPortConnected(port)) {
    return initConnection();
  }

  return true;
}

// Проверка, подключен ли порт
function isPortConnected(port) {
  try {
    // Проверяем, можем ли мы отправить сообщение
    port.postMessage({ action: 'check' });
    return true;
  } catch (e) {
    return false;
  }
}

// === Обработчик видимости для принудительного обновления ===
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    console.debug('[panel] Panel became visible, checking connection...');

    // Проверяем и восстанавливаем соединение
    if (checkAndRestoreConnection()) {
      console.debug('[panel] Connection check successful');

      // Если соединение активно, обновим интерфейс
      if (currentSearch.trim()) {
        performSearch();
      } else {
        renderList();
      }
    } else {
      console.debug('[panel] Could not restore connection');
    }
  }
});

// === Очистка ресурсов при закрытии панели ===
function cleanupResources() {
  console.debug('[panel] Cleaning up resources before panel closure');

  // Очищаем данные
  requests = [];
  selectedId = null;
  allHighlights = [];
  currentSearch = "";

  // Сбрасываем интерфейс
  if (requestsList) {
    requestsList.innerHTML = '<div class="empty">Нет gRPC-вызовов</div>';
  }
  if (details) {
    details.style.display = 'none';
  }

  // Отписываемся от сообщений
  if (port) {
    try {
      port.onMessage.removeListener(messageListener);
      port.disconnect();
    } catch (e) {
      // Игнорируем ошибку
    }
    port = null;
  }

  // Очищаем таймеры
  clearTimeout(searchDebounceTimer);

  console.debug('[panel] Resources cleaned up successfully');
}

// === Обработка закрытия панели ===
window.addEventListener('beforeunload', cleanupResources);

// === Дополнительная защита от утечек памяти ===
window.addEventListener('unload', () => {
  // Финальная очистка
  if (port) {
    try {
      port.disconnect();
    } catch (e) {
      console.debug('[panel] Could not disconnect port', e);
    }
    port = null;
  }
  console.debug('[panel] Port disconnected');
});

// === Инициализация ===
function initPanel() {
  if (!isExtensionContextValid()) {
    console.debug('[panel] Extension context is invalid, cannot initialize');
    contextValid = false;

    // Показываем сообщение об ошибке
    if (requestsList) {
      requestsList.innerHTML = '<div class="empty">Расширение недоступно. Попробуйте обновить страницу.</div>';
    }
    return;
  }

  contextValid = true;

  // Инициализируем соединение
  if (!initConnection()) {
    console.debug('[panel] Failed to initialize connection');
    contextValid = false;

    if (requestsList) {
      requestsList.innerHTML = '<div class="empty">Не удалось подключиться к расширению. Попробуйте обновить страницу.</div>';
    }
    return;
  }

  // Инициализируем UI
  details.style.display = 'none';
  detailRequest.textContent = '(нет)';
  detailResponse.textContent = '(нет)';
  detailError.textContent = '(нет)';

  updateCaptureButton();
  performSearch();
  updateNavigationButtonsState();

  console.debug('[panel] Panel initialized successfully');
}

// Инициализируем панель
initPanel();

// Добавляем обработчик для ошибок
window.addEventListener('error', (event) => {
  if (event.message && event.message.includes('Extension context invalidated')) {
    console.debug('[panel] Global error: Extension context invalidated');
    contextValid = false;
    cleanupResources();

    if (requestsList) {
      requestsList.innerHTML = '<div class="empty">Расширение было обновлено в фоновом режиме. Пожалуйста, перезагрузите DevTools (закройте и откройте панель заново).</div>';
    }
  }
});
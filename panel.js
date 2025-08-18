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
const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

// === Подключаемся к background ===
const port = chrome.runtime.connect({ name: 'grpc-devtools-port' });

// === ОТПРАВЛЯЕМ tabId СРАЗУ ПОСЛЕ ПОДКЛЮЧЕНИЯ ===
port.postMessage({ type: 'init', tabId: inspectedTabId });

// === State ===
let requests = [];
let selectedId = null;
let isCapturing = true; // По умолчанию включено
let requestIdCounter = 0;

let currentSearch = "";
let allHighlights = [];
let currentHighlightIndex = -1;
let isNavigating = false; // Флаг для отслеживания навигации
let hasSearchResults = false; // Новый флаг для отслеживания наличия результатов поиска
let userInitiatedSelection = false; // НОВЫЙ ФЛАГ: выбор пользователя

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
  searchCountSpan.textContent = allHighlights.length > 0
    ? `${currentHighlightIndex + 1}/${allHighlights.length}`
    : '0/0';
}

function scrollToCurrentHighlight() {
  if (currentHighlightIndex >= 0 && allHighlights[currentHighlightIndex]) {
    allHighlights[currentHighlightIndex].scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }
}

function clearHighlights() {
  // Очищаем детали
  [detailRequest, detailResponse, detailError].forEach(el => {
    if (el.children.length > 0) {
      el.textContent = el.textContent;
    }
  });

  // Очищаем подсветку в списке
  document.querySelectorAll('.request-item .method-name, .request-item .method-type, .request-item div')
    .forEach(el => {
      if (el.children.length > 0) {
        el.textContent = el.textContent;
      }
    });

  allHighlights = [];
  currentHighlightIndex = -1;
  updateSearchCount();
}

// === Controls ===
clearBtn.onclick = () => {
  requests = [];
  selectedId = null;
  details.style.display = 'none';
  renderList();
  chrome.runtime.sendMessage({ action: "clearRequests" });
};

function updateCaptureButton() {
  captureToggle.classList.toggle("on", isCapturing);
  captureToggle.classList.toggle("off", !isCapturing);
  captureToggle.title = isCapturing ? "Перехват включён" : "Перехват выключен";
}

captureToggle.onclick = () => {
  isCapturing = !isCapturing;
  updateCaptureButton();
  chrome.runtime.sendMessage({ action: "setCapture", enabled: isCapturing });
};

// === Search Controls ===
searchInput.addEventListener("input", () => {
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
  searchInput.value = "";
  currentSearch = "";
  isNavigating = false;
  hasSearchResults = false;
  performSearch(); // Сброс + перерисовка
  updateNavigationButtonsState();
};

// Обновляем состояние кнопок навигации
function updateNavigationButtonsState() {
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
  if (!hasSearchResults) return;

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
  if (!hasSearchResults) return;

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
  if (message.action === "gRPCNetworkCall" && isCapturing) {
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
  }
};

port.onMessage.addListener(messageListener);

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
  port.onMessage.removeListener(messageListener);

  // Отправляем сигнал о закрытии панели
  try {
    port.postMessage({
      action: 'panelClosed',
      tabId: inspectedTabId
    });
  } catch (e) {
    console.debug('[panel] Could not send panelClosed message', e);
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
  try {
    port.disconnect();
  } catch (e) {
    console.debug('[panel] Could not disconnect port', e);
  }
  console.debug('[panel] Port disconnected');
});

// === Init ===
details.style.display = 'none';
detailRequest.textContent = '(нет)';
detailResponse.textContent = '(нет)';
detailError.textContent = '(нет)';

updateCaptureButton();
performSearch();
updateNavigationButtonsState();
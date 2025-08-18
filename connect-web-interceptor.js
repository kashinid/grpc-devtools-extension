// connect-web-interceptor.js
// Перехватывает запросы от @connectrpc/connect-web

(() => {
  if (window.__CONNECT_RPC_DEVTOOLS_HOOKED__) return;
  window.__CONNECT_RPC_DEVTOOLS_HOOKED__ = true;

  const POST_TYPE = "__GRPCWEB_DEVTOOLS__";

  // Сохраняем оригинальные методы
  const originalTransportUnary = window.createTransport?.prototype?.unary;
  const originalTransportStream = window.createTransport?.prototype?.stream;

  // Если нет глобального createTransport, попробуем перехватить через замену модуля (редкий случай)
  const wrapTransport = (transport) => {
    if (transport.__DEVTOOLS_WRAPPED__) return transport;
    transport.__DEVTOOLS_WRAPPED__ = true;

    const originalUnary = transport.unary;
    const originalStream = transport.stream;

    transport.unary = function (service, method, ...args) {
      const request = args[0]?.message;

      // Логируем запрос
      logRequest({
        method: `${service.typeName}/${method.name}`,
        methodType: "unary",
        request: serializeMessage(request),
      });

      const promise = originalUnary.call(this, service, method, ...args);

      promise
        .then((response) => {
          logResponse({
            method: `${service.typeName}/${method.name}`,
            methodType: "unary",
            response: serializeMessage(response.message),
          });
        })
        .catch((error) => {
          logError({
            method: `${service.typeName}/${method.name}`,
            methodType: "unary",
            error: {
              code: error.code,
              message: error.message,
            },
          });
        });

      return promise;
    };

    transport.stream = function (service, method, ...args) {
      const request = args[0]?.message;

      logRequest({
        method: `${service.typeName}/${method.name}`,
        methodType: "server_streaming",
        request: serializeMessage(request),
      });

      const stream = originalStream.call(this, service, method, ...args);

      const originalEmit = stream.emit;
      stream.emit = function (event, data) {
        if (event === "message") {
          logResponse({
            method: `${service.typeName}/${method.name}`,
            methodType: "server_streaming",
            response: serializeMessage(data),
          });
        } else if (event === "error") {
          logError({
            method: `${service.typeName}/${method.name}`,
            methodType: "server_streaming",
            error: {
              code: data.code,
              message: data.message,
            },
          });
        }
        return originalEmit.call(this, event, data);
      };

      return stream;
    };

    return transport;
  };

  // Оборачиваем createTransport, если он есть
  if (typeof window.createTransport === 'function') {
    const originalCreate = window.createTransport;
    window.createTransport = function (options) {
      const transport = originalCreate(options);
      return wrapTransport(transport);
    };
  }

  // Универсальный логгер
  function logRequest({ method, methodType, request }) {
    window.postMessage(
      {
        type: POST_TYPE,
        method,
        methodType,
        request,
      },
      "*"
    );
  }

  function logResponse({ method, methodType, response }) {
    window.postMessage(
      {
        type: POST_TYPE,
        method,
        methodType,
        response,
      },
      "*"
    );
  }

  function logError({ method, methodType, error }) {
    window.postMessage(
      {
        type: POST_TYPE,
        method,
        methodType,
        error,
      },
      "*"
    );
  }

  // Универсальная сериализация сообщения
  function serializeMessage(msg) {
    if (!msg) return undefined;
    return typeof msg.toObject === 'function'
      ? msg.toObject()
      : typeof msg === 'object'
        ? { ...msg }
        : msg;
  }

  console.log("[Connect RPC DevTools] Перехватчик активирован");
})();
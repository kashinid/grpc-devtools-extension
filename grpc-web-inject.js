// grpc-web-inject.js

(() => {
  if (window.__GRPCWEB_DEVTOOLS_HOOKED__) return;
  window.__GRPCWEB_DEVTOOLS_HOOKED__ = true;

  const postType = "__GRPCWEB_DEVTOOLS__";

  const StreamInterceptor = function (method, request, stream) {
    this._callbacks = {};
    const methodType = "server_streaming";

    window.postMessage({
      type: postType,
      method,
      methodType,
      request: typeof request.toObject === 'function' ? request.toObject() : request,
    }, "*");

    stream.on('data', response => {
      window.postMessage({
        type: postType,
        method,
        methodType,
        response: typeof response.toObject === 'function' ? response.toObject() : response,
      }, "*");
      if (this._callbacks['data']) this._callbacks['data'](response);
    });

    stream.on('status', status => {
      if (status.code === 0) {
        window.postMessage({
          type: postType,
          method,
          methodType,
          response: "EOF",
        }, "*");
      }
      if (this._callbacks['status']) this._callbacks['status'](status);
    });

    stream.on('error', error => {
      if (error.code !== 0) {
        window.postMessage({
          type: postType,
          method,
          methodType,
          error: {
            code: error.code,
            message: error.message,
          },
        }, "*");
      }
      if (this._callbacks['error']) this._callbacks['error'](error);
    });

    this._stream = stream;
  };

  StreamInterceptor.prototype.on = function (type, callback) {
    this._callbacks[type] = callback;
    return this;
  };

  StreamInterceptor.prototype.cancel = function () {
    this._stream.cancel();
  };

  window.__GRPCWEB_DEVTOOLS__ = function (clients) {
    if (!Array.isArray(clients)) return;

    clients.forEach(client => {
      if (!client || !client.client_) return;

      if (client.client_.rpcCall) {
        client.client_.rpcCall_ = client.client_.rpcCall;
        client.client_.rpcCall = function (method, request, metadata, methodInfo, callback) {
          let posted = false;
          const newCallback = (err, response) => {
            if (!posted) {
              window.postMessage({
                type: postType,
                method,
                methodType: "unary",
                request: typeof request.toObject === 'function' ? request.toObject() : request,
                response: err ? undefined : (typeof response.toObject === 'function' ? response.toObject() : response),
                error: err ? { code: err.code, message: err.message } : undefined,
              }, "*");
              posted = true;
            }
            callback(err, response);
          };
          return this.rpcCall_(method, request, metadata, methodInfo, newCallback);
        };

        client.client_.unaryCall = function (method, request, metadata, methodInfo) {
          return new Promise((resolve, reject) => {
            this.rpcCall(method, request, metadata, methodInfo, (err, response) => {
              err ? reject(err) : resolve(response);
            });
          });
        };
      }

      if (client.client_.serverStreaming) {
        client.client_.serverStreaming_ = client.client_.serverStreaming;
        client.client_.serverStreaming = function (method, request, metadata, methodInfo) {
          const stream = client.client_.serverStreaming_(method, request, metadata, methodInfo);
          return new StreamInterceptor(method, request, stream);
        };
      }
    });
  };
})();
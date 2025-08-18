// devtools.js
console.log("gRPC DevTools: Загружен");

chrome.devtools.panels.create(
  "gRPC",
  "icon16.png",
  "panel.html",
  function (panel) {
    console.log("gRPC: Панель создана");
  }
);
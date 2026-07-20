// Service worker for the Cline PWA.
// Catches navigation failures (server not running / crashed) and serves a
// branded fallback page that auto-refreshes once the server is reachable.

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Cline</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    background:#1F2428;
    color:#6E7681;
    font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
    display:flex;
    height:100svh;
    align-items:center;
    justify-content:center;
    padding:24px;
  }
  .container{
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    gap:12px;
    padding:48px 0;
  }
  h3{font-size:16px;font-weight:600;color:#E6EDF3}
  p{font-size:14px;color:#8B949E;text-align:center;line-height:1.5}
  .spinner{
    width:20px;height:20px;
    border:2px solid #30363D;
    border-top-color:#8B949E;
    border-radius:50%;
    animation:spin .8s linear infinite;
    margin-top:8px;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="container">
  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" x2="12" y1="8" y2="12"/>
    <line x1="12" x2="12.01" y1="16" y2="16"/>
  </svg>
  <h3>Waiting for Cline</h3>
  <p>Run <code style="background:#2D3339;padding:2px 6px;border-radius:4px;font-size:13px">cline</code> in your terminal to start the server.</p>
  <div class="spinner"></div>
  <p id="cert-hint" style="display:none;margin-top:12px;color:#D29922;font-size:13px;line-height:1.5;max-width:420px">
    Unable to connect. If you are using HTTPS with a self-signed certificate,<br/>
    open this URL directly and accept the browser certificate warning (Advanced &rarr; Proceed), then reload.
  </p>
</div>
<script>
  (function poll(failures) {
    fetch("/", { method: "HEAD", cache: "no-store" })
      .then(function(r) { if (r.ok) location.reload(); else setTimeout(function() { poll(0); }, 2000); })
      .catch(function() {
        if (failures >= 3 && location.protocol === "https:") {
          var hint = document.getElementById("cert-hint");
          if (hint) hint.style.display = "block";
        }
        setTimeout(function() { poll(failures + 1); }, 2000);
      });
  })(0);
</script>
</body>
</html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  // Only intercept navigation requests (page loads), not API calls or assets.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(() =>
      new Response(FALLBACK_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event.notification.data || {}));
});

// OS 通知点击与应用内通知点击（focus-workspace-tab-request）共用的 tab 匹配语义：
// 按 URL pathname 严格比对（所有已落地 tab 的 pathname 均为 buildProjectPathname 规范编码形）。
function findWorkspaceWindowClientByPathname(windowClients, workspacePathname, excludedClientId) {
  if (!workspacePathname) {
    return null;
  }
  return (
    windowClients.find((client) => {
      if (excludedClientId && client.id === excludedClientId) {
        return false;
      }
      try {
        return new URL(client.url).pathname === workspacePathname;
      } catch {
        return false;
      }
    }) || null
  );
}

// 消息 shape 与 web-ui/src/hooks/use-notification-task-focus.ts 的 NotificationTaskFocusMessage 手工同步
// （sw.js 无法 import src 模块；漂移由 workspace-tab-focus-via-service-worker.test.ts 的防漂移测试锁定）。
function postFocusTaskFromNotificationMessage(client, taskId, workspaceId) {
  client.postMessage({
    source: "cline-kanban",
    type: "focus-task-from-notification",
    taskId,
    workspaceId,
  });
}

async function handleNotificationClick(data) {
  const taskId = typeof data.taskId === "string" ? data.taskId : null;
  const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId : null;
  const workspacePathname = typeof data.workspacePathname === "string" ? data.workspacePathname : null;

  if (!taskId) {
    return;
  }

  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const target = findWorkspaceWindowClientByPathname(windowClients, workspacePathname, null);

  if (target) {
    await target.focus();
    postFocusTaskFromNotificationMessage(target, taskId, workspaceId);
    return;
  }

  if (self.clients.openWindow && workspacePathname) {
    await self.clients.openWindow(`${workspacePathname}?task=${encodeURIComponent(taskId)}`);
  }
}

// 应用内通知点击的跨 tab 聚焦请求：页面在点击手势内同步 postMessage 过来（此时 origin 下持有
// transient activation，client.focus() 按现行规范被允许），SW 找到目标项目的 tab 后聚焦并转发
// 既有 focus-task-from-notification 消息，经 MessageChannel port 恰好回报一次 outcome。
// 消息类型/outcome 字面量与 web-ui/src/utils/workspace-tab-focus-via-service-worker.ts 手工同步。
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "cline-kanban" || data.type !== "focus-workspace-tab-request") {
    return;
  }
  const responsePort = event.ports && event.ports[0];
  if (!responsePort) {
    return;
  }
  event.waitUntil(handleFocusWorkspaceTabRequest(data, event.source, responsePort));
});

async function handleFocusWorkspaceTabRequest(data, senderClient, responsePort) {
  const respond = (outcome) => {
    responsePort.postMessage({
      source: "cline-kanban",
      type: "focus-workspace-tab-response",
      outcome,
    });
  };
  try {
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId : null;
    const workspacePathname = typeof data.workspacePathname === "string" ? data.workspacePathname : null;
    if (!taskId || !workspaceId || !workspacePathname) {
      respond("focus-failed");
      return;
    }

    const windowClients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    // 排除发起 tab 自身：其 pathname 可能滞后于导航意图（「正切离项目 A 时点 A 的通知」场景），
    // 不排除会自 focus 空转；排除后走 no-tab-found → 页面新开目标 tab，尊重用户刚做出的切换意图。
    const senderClientId = senderClient && senderClient.id ? senderClient.id : null;
    const target = findWorkspaceWindowClientByPathname(windowClients, workspacePathname, senderClientId);
    if (!target) {
      respond("no-tab-found");
      return;
    }

    // Chromium 现实现只在 notificationclick 的 window-interaction token 下允许 client.focus()
    // （w3c/ServiceWorker#602），页面点击发起的 message 上下文会以 InvalidAccessError 拒绝；
    // 仍保留尝试：未来实现若放宽为 MDN 描述的「origin 级 transient activation」门槛，
    // 此处自动升级为真聚焦。被拒时仍转发选中消息（postMessage 无门槛），让任务在后台
    // 目标 tab 就位打开，由页面侧 toast 提示用户手动切换。
    // matchAll 按最近聚焦优先排序，多个同项目 tab 时第一个即用户最近用过的那个。
    let focusedClient = null;
    try {
      focusedClient = await target.focus();
    } catch {
      postFocusTaskFromNotificationMessage(target, taskId, workspaceId);
      respond("task-selected-in-background-tab");
      return;
    }
    postFocusTaskFromNotificationMessage(focusedClient || target, taskId, workspaceId);
    respond("focused");
  } catch {
    respond("focus-failed");
  }
}

// Bridge to the desktop app (kustik_screenshot/app.py).
//
// JS → host: window.webkit.messageHandlers.native.postMessage(JSON string)
// host → JS: window.nativeReceive(message object)
//
// `call` sends a request with an id and resolves with the host's reply;
// `on` subscribes to unsolicited host messages (capture trigger, levels…).

const pending = new Map();
const handlers = new Map();
let seq = 0;

const port = () => window.webkit?.messageHandlers?.native;

export const native = {
  get available() { return !!port(); },

  send(type, data = {}) {
    const p = port();
    if (p) p.postMessage(JSON.stringify({ type, ...data }));
  },

  call(type, data = {}, { onProgress } = {}) {
    const id = ++seq;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      this.send(type, { ...data, id });
    });
    promise.callId = id;
    return promise;
  },

  cancel(id) { this.send('cancel', { target: id }); },

  on(type, fn) { handlers.set(type, fn); },
};

window.nativeReceive = (msg) => {
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    if (msg.type === 'progress') { p.onProgress?.(msg.p); return; }
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error || 'host error'));
    else p.resolve(msg.data ?? {});
    return;
  }
  handlers.get(msg.type)?.(msg);
};

// Surface JS errors in the host's log.
addEventListener('error', (e) => native.send('log', { text: `JS error: ${e.message} @ ${e.filename}:${e.lineno}` }));
addEventListener('unhandledrejection', (e) => native.send('log', { text: `JS rejection: ${e.reason?.message || e.reason}` }));

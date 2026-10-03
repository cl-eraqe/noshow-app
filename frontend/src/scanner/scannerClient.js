// Page-side handle on the scanner worker. The worker — and with it OpenCV —
// is created only when the scanner opens, and terminated when it closes, so
// the ~10 MB library costs nothing for anyone who never scans and holds no
// memory once the scan is done. After the first download the service worker
// serves it from the phone (see vite.config.js).

export function createScanner() {
  // A classic worker: the build bundles it into one script, and classic
  // workers also run on iPhones older than iOS 15, which module workers do not.
  const worker = new Worker(new URL('./scanner.worker.js', import.meta.url));
  const pending = new Map();
  let nextId = 1;
  let markReady, markFailed, isReady = false;
  const ready = new Promise((res, rej) => { markReady = res; markFailed = rej; });
  ready.catch(() => {});   // callers that never await it must not see an unhandled rejection

  worker.onmessage = ({ data }) => {
    if (data?.type === 'ready') { isReady = true; return markReady(); }
    const p = pending.get(data?.id);
    if (!p) return;
    pending.delete(data.id);
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  worker.onerror = e => {
    const err = new Error(e.message || 'scanner failed to load');
    if (!isReady) markFailed(err);
    pending.forEach(p => p.reject(err));
    pending.clear();
  };

  function call(msg, transfer) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  return {
    ready,
    detect: image => call({ type: 'detect', image }).then(r => r.corners),
    warp: (image, corners) => call({ type: 'warp', image, corners }).then(r => r.image),
    close: () => {
      worker.terminate();
      pending.forEach(p => p.reject(new Error('scanner closed')));
      pending.clear();
    },
  };
}

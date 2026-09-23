// Features provide their worker and payload; this owner handles task termination and deadlines.
export function createPdfExportJob({ createWorker, prepare, name, onProgress = () => {} }) {
  let worker, settled = false, rejectPending, timeout;
  const promise = new Promise((resolve, reject) => {
    rejectPending = reject;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker?.terminate();
      callback(value);
    };
    try {
      worker = createWorker();
      timeout = setTimeout(() => finish(reject, new Error(name + ' export timed out')), 300000);
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.type === 'progress') onProgress(data.percent);
        else if (data.type === 'result') finish(resolve, data.output);
        else if (data.type === 'error') finish(reject, new Error(data.message));
      };
      worker.onerror = () => finish(reject, new Error(name + ' export worker failed'));
      worker.onmessageerror = () => finish(reject, new Error(name + ' export message failed'));
      const { payload, transfers } = prepare();
      worker.postMessage(payload, transfers);
    } catch (error) { finish(reject, error); }
  });
  return { promise, cancel() {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    worker?.terminate();
    rejectPending(new Error(name + ' export cancelled'));
  } };
}

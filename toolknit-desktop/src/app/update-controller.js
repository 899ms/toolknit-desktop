/** Update orchestration contract; network and rendering remain injectable. */
export function createUpdateController({ check, onRelease, onError } = {}) {
  let running = null;
  const run = async (...args) => {
    if (running) return running;
    running = Promise.resolve().then(() => check?.(...args)).then(result => {
      if (result) onRelease?.(result);
      return result;
    }).catch(error => { onError?.(error); return null; }).finally(() => { running = null; });
    return running;
  };
  return Object.freeze({ run });
}

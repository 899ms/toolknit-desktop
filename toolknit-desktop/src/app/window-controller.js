/** Native window actions kept behind the application boundary. */
export function createWindowController({ appWindow, isTauri = false, onStateChange } = {}) {
  const invoke = async action => {
    if (!isTauri || !appWindow) return false;
    if (action === 'minimize') await appWindow.minimize();
    else if (action === 'maximize') {
      const maximized = await appWindow.isMaximized();
      await (maximized ? appWindow.unmaximize() : appWindow.maximize());
    } else if (action === 'close') await appWindow.close();
    else return false;
    onStateChange?.(action);
    return true;
  };
  return Object.freeze({ invoke });
}

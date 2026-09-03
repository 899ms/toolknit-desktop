import { createAppLifecycle } from './app-lifecycle.js';
import { createHomeController } from './home-controller.js';
import { createModalManager } from './modal-manager.js';
import { createSettingsController } from './settings-controller.js';
import { createUpdateController } from './update-controller.js';
import { createWindowController } from './window-controller.js';

/** Dependency-injection seam for the application entrypoint. */
export function createAppComposition(options = {}) {
  return Object.freeze({
    lifecycle: createAppLifecycle(options),
    home: createHomeController(options),
    modals: createModalManager(options),
    settings: createSettingsController(options),
    updates: createUpdateController(options),
    window: createWindowController(options)
  });
}

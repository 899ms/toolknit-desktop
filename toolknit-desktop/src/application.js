/*
 * Compatibility entrypoint for the desktop application.
 * Runtime wiring lives in application-runtime.js while responsibilities are
 * progressively promoted to app/* controllers.
 */
import './application-runtime.js';

export const APPLICATION_RUNTIME_MODULE = './application-runtime.js';

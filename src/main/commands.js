'use strict';
// One command vocabulary for every way of driving a running instance from outside the window:
// taskbar thumbnail buttons, jump-list tasks, and Start Menu shortcuts (which launch a second process
// whose command line is forwarded to the first by Electron's single-instance lock).

const APP_ID = 'VideoCompare.App';          // AppUserModelID: ties the window, pinned icon and shortcuts together
const APP_NAME = 'Video Compare';

const COMMAND_FLAGS = {
  '--quit': 'quit',
  '--suspend': 'suspend',
  '--resume': 'resume',
  '--toggle-suspend': 'toggle-suspend',
  '--toggle-play': 'toggle-play',
};
const RENDERER_COMMANDS = new Set(['toggle-play', 'step-back', 'step-forward', 'suspend', 'resume', 'toggle-suspend']);

/** The control command on a command line, or null. */
function parseCommand(argv) {
  for (const a of argv) if (Object.hasOwn(COMMAND_FLAGS, a)) return COMMAND_FLAGS[a];
  return null;
}

/** @param {{getWindow: () => (import('electron').BrowserWindow|null), quit: () => void}} deps */
function createRouter({ getWindow, quit }) {
  return {
    /** @returns {boolean} whether the command was understood and delivered */
    run(cmd) {
      if (cmd === 'quit') { quit(); return true; }
      if (!RENDERER_COMMANDS.has(cmd)) return false;
      const w = getWindow();
      if (!w || w.isDestroyed()) return false;
      w.webContents.send('vc:command', cmd);
      return true;
    },
  };
}

module.exports = { APP_ID, APP_NAME, COMMAND_FLAGS, RENDERER_COMMANDS, parseCommand, createRouter };

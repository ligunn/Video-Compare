'use strict';
// Windows taskbar integration: thumbnail-toolbar buttons (hover the taskbar icon) and jump-list tasks
// (right-click it). Both feed the command router in commands.js.
const path = require('node:path');
const { glyphPng } = require('./icons');

const ASSETS = path.resolve(__dirname, '..', '..', 'assets');
const ICON = path.join(ASSETS, 'icon.ico');

/**
 * @param {{app: import('electron').App, nativeImage: typeof import('electron').nativeImage,
 *          getWindow: () => (import('electron').BrowserWindow|null), run: (cmd: string) => void}} deps
 */
function createTaskbar({ app, nativeImage, getWindow, run }) {
  const images = new Map();
  const glyph = name => { if (!images.has(name)) images.set(name, nativeImage.createFromBuffer(glyphPng(name, 32))); return images.get(name); };
  const status = { thumbnail: false, tasks: false, buttons: [] };
  let last = { hasVideos: false, playing: false, suspended: false };

  /** Thumbnail buttons reflect the app: Play/Pause and Suspend/Resume swap glyph and tooltip. */
  function buttonsFor(s) {
    const live = s.hasVideos && !s.suspended;
    return [
      { tooltip: 'Previous frame', icon: glyph('prev'), flags: live ? [] : ['disabled'], click: () => run('step-back') },
      { tooltip: s.playing ? 'Pause' : 'Play', icon: glyph(s.playing ? 'pause' : 'play'), flags: live ? [] : ['disabled'], click: () => run('toggle-play') },
      { tooltip: 'Next frame', icon: glyph('next'), flags: live ? [] : ['disabled'], click: () => run('step-forward') },
      { tooltip: s.suspended ? 'Resume: reload the videos' : 'Suspend: free decoder and GPU memory', icon: glyph(s.suspended ? 'resume' : 'suspend'), flags: s.hasVideos ? [] : ['disabled'], click: () => run('toggle-suspend') },
    ];
  }

  function update(state) {
    last = { ...last, ...state };
    const win = getWindow();
    if (!win || win.isDestroyed() || process.platform !== 'win32') return false;
    const buttons = buttonsFor(last);
    status.buttons = buttons.map(b => `${b.tooltip}${b.flags.length ? ' (disabled)' : ''}`);
    // A taskbar decoration must never be able to take the app down: report failure in `status` instead of throwing.
    try { status.thumbnail = win.setThumbarButtons(buttons); status.error = null; }
    catch (e) { status.thumbnail = false; status.error = String(e && e.message || e); }
    return status.thumbnail;
  }

  /** Right-click the taskbar icon: works even when the app is not running (they launch a control command). */
  function setTasks() {
    if (process.platform !== 'win32') return false;
    const prefix = app.isPackaged ? '' : `"${app.getAppPath()}" `;
    const task = (title, description, flag) => ({ program: process.execPath, arguments: `${prefix}${flag}`, iconPath: ICON, iconIndex: 0, title, description });
    try {
      status.tasks = app.setUserTasks([
        task('Play / pause', 'Toggle playback in the running Video Compare', '--toggle-play'),
        task('Suspend', 'Pause and release video decoders and GPU memory', '--suspend'),
        task('Resume', 'Reload the videos and continue where you were', '--resume'),
        task('Quit Video Compare', 'Close the running Video Compare', '--quit'),
      ]);
    } catch (e) { status.tasks = false; status.error = String(e && e.message || e); }
    return status.tasks;
  }

  return { update, setTasks, status, buttonsFor };
}

module.exports = { createTaskbar, ICON };

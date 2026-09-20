'use strict';
// Creates/removes the Desktop and Start Menu shortcuts. They carry the app's AppUserModelID and icon, so a
// running window groups under the same taskbar icon once the user pins it (Windows does not let an app pin
// itself). `electron . --install-shortcuts` / `--remove-shortcuts` run this.
const path = require('node:path');
const fs = require('node:fs');
const { APP_ID, APP_NAME } = require('./commands');
const { ICON } = require('./taskbar');

// Start Menu only (local, %APPDATA%). No Desktop shortcut by default; drag one out of the Start Menu if wanted.
function locations(app) {
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
  return {
    startMenu,
    // created by an earlier version of this tool; still removed by --remove-shortcuts
    legacy: [path.join(app.getPath('desktop'), `${APP_NAME}.lnk`)],
    list: [
      { file: path.join(startMenu, `${APP_NAME}.lnk`), flag: '', description: 'Compare versions of the same video', aumid: true },
      { file: path.join(startMenu, `Stop ${APP_NAME}.lnk`), flag: '--quit', description: `Close the running ${APP_NAME}`, aumid: false },
      { file: path.join(startMenu, `Suspend ${APP_NAME}.lnk`), flag: '--suspend', description: 'Pause and free decoder and GPU memory', aumid: false },
      { file: path.join(startMenu, `Resume ${APP_NAME}.lnk`), flag: '--resume', description: 'Reload the videos and continue', aumid: false },
    ],
  };
}

function install({ app, shell }) {
  const appDir = app.getAppPath();
  const { startMenu, list } = locations(app);
  fs.mkdirSync(startMenu, { recursive: true });
  return list.map(s => {
    const options = {
      target: process.execPath, cwd: appDir, description: s.description, icon: ICON, iconIndex: 0,
      args: `"${appDir}"${s.flag ? ' ' + s.flag : ''}`,
      ...(s.aumid ? { appUserModelId: APP_ID } : {}),
    };
    const ok = shell.writeShortcutLink(s.file, 'create', options);
    let back = null;
    try { back = shell.readShortcutLink(s.file); } catch { /* reported as not ok below */ }
    return { file: s.file, ok: ok && !!back && back.target.toLowerCase() === process.execPath.toLowerCase(), args: back && back.args, appUserModelId: back && back.appUserModelId };
  });
}

function remove({ app }) {
  const { startMenu, list, legacy } = locations(app);
  const files = [...list.map(s => s.file), ...legacy];
  const results = files.map(file => { const existed = fs.existsSync(file); if (existed) fs.rmSync(file, { force: true }); return { file, ok: !fs.existsSync(file), existed }; });
  try { fs.rmdirSync(startMenu); } catch { /* not empty or already gone */ }
  return results;
}

module.exports = { install, remove, locations };

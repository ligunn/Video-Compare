# Video Compare

A Windows desktop app for reviewing the differences between two or more versions of the **same footage**: an original
against an upscale, or two upscales against each other. It shows them side by side, with a wipe slider, an A/B flip or a
difference heatmap, with zoom and pan synchronised across all of them and frame-accurate stepping.

- **Frame-rate differences are fixed for you.** A 59.98 fps file next to a 60 fps file, or a file that dropped frames, is
  detected and lined up automatically (details below).
- **Every file gets a health report**: dropped/duplicated frames, timestamp faults, audio/video sync, bitrate, and more.
- **More than two videos** work in every view.

## Quick start (about 5 minutes, mostly downloads)

**You need:** Windows 11 (64-bit), an internet connection, about 1 GB of free disk space, and a GitHub login that can see
this repository. H.264 videos play on any PC; **H.265 (HEVC) videos need a graphics card/driver with hardware HEVC
decoding** (see Troubleshooting).

Do everything below in **Command Prompt** (Start menu, type `cmd`, press Enter). Command Prompt avoids PowerShell's
script-execution restrictions that otherwise break `npm` on a fresh Windows install.

**1. Install Node.js and FFmpeg** (two commands; say yes if Windows asks for permission):

```
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
```

**2. Close Command Prompt and open a new one.** (So it can see the newly installed `node` and `npm`.)

**3. Download this project.** On the repository page on GitHub click the green **Code** button, then **Download ZIP**.
It saves as `Video-Compare-main.zip` in your Downloads folder. Unpack it into your user folder:

```
tar -xf "%USERPROFILE%\Downloads\Video-Compare-main.zip" -C "%USERPROFILE%"
cd /d "%USERPROFILE%\Video-Compare-main"
```

*(Prefer git? Install it with `winget install --id Git.Git -e`, then `git clone` the URL behind the green Code button
and `cd` into the new folder. Everything after this step is identical.)*

**4. Install the app's one dependency (Electron) and start it:**

```
npm ci
npm start
```

`npm ci` downloads about 150 MB and takes a minute or two. `npm start` opens the app. Drag two or more videos onto the
window, or press **Ctrl+O** and pick them.

**5. (Optional) Check everything works on your PC.** This generates small synthetic test clips and needs no videos of yours:

```
npm test
npm run selftest
```

`npm test` takes a minute or two. `npm run selftest` opens a window that drives itself for about 45 seconds (leave it
alone); it ends with `SELFTEST PASSED`.

**6. (Optional) Start Menu shortcuts.** `npm run shortcuts` creates a *Video Compare* folder in the Start Menu with
**Video Compare**, **Stop**, **Suspend** and **Resume** shortcuts. To pin it to the taskbar (Windows will not let an app
pin itself): start it from the Start Menu, right-click its taskbar icon, choose *Pin to taskbar*. `npm run shortcuts:remove`
deletes the shortcuts again.

### Troubleshooting

| Problem | Fix |
|---|---|
| `'winget' is not recognized` | Install **App Installer** from the Microsoft Store (it provides winget), then repeat step 1. |
| `'npm' is not recognized` | You skipped step 2: close Command Prompt and open a new one. |
| The app says **ffprobe was not found** | FFmpeg is missing or not the full build: run the second command in step 1, then restart the app. Or set the environment variable `VIDEO_COMPARE_FFMPEG_DIR` to the folder that holds `ffmpeg.exe` and `ffprobe.exe`. |
| An **H.265** file will not open, H.264 files do | Your graphics card or driver lacks hardware HEVC decoding: update the graphics driver, or install **HEVC Video Extensions** from the Microsoft Store. |
| `npm ci` fails on a corporate network | Electron is downloaded from GitHub; allow that, or set `ELECTRON_MIRROR`. |
| `Save conformed copy` is slow | Only when frames must be duplicated or dropped, which needs a re-encode. On PCs without a supported AMD GPU this uses the software encoder (libx265). A pure re-timing is lossless and instant. |

## Using it

| Key | View |
|---|---|
| `1` | **Side by side** (a grid for 3 or more videos) |
| `2` | **Wipe**: draggable divider(s); the same picture region on either side |
| `3` | **Flip**: one video at a time; `Tab` or `A` `B` `C` to switch |
| `4` | **Difference**: heatmap or amplified difference, adjustable gain, any video against the reference |

Mouse wheel zooms at the cursor, dragging pans (all videos move together, matched by picture position, so a 1080p original
and a 4K upscale line up). `0` fits, double-click toggles **1:1 with the largest video's pixels**. Scaling: nearest
(raw pixels), bilinear or bicubic. `Space` plays, `←`/`→` step a frame (Shift = 10), `Home`/`End`, `↑`/`↓` change speed,
`M` cycles audio, `H` opens File health, `C` toggles conforming, `[` `]` nudge the other video by one frame (to fix a trim
the timestamps cannot reveal), `S` suspends, `?` shows all shortcuts.

**Files are opened read-only and never modified.** Nothing is written next to your videos unless you choose to export, and
the app keeps no list of the files you have opened.

## Frame-rate and timing conforming

One video is the **reference**: the one with clean, monotonic timestamps (if several are clean, the first). Every other video
is lined up to its clock, non-destructively, at playback time:

- **Retime**: same frame count but a different rate (59.98 vs 60, 23.976 vs 24). Every frame is kept and time is stretched by
  the ratio, so frame *N* stays paired with frame *N*. Without this, a 59.98/60 pair drifts a whole frame apart in about 15 s.
- **Resample**: frames are genuinely missing or extra, or the timestamps are irregular. Pairing is by timestamp, so the picture
  holds through a gap instead of shifting every later frame.

A banner names the adjusted video and explains why. A checkbox turns conforming off and a dropdown changes the reference.

## File health (press H)

Per file, side by side, with `≠` where the files differ: container, codec, profile, bit depth, colour tags, scan type,
measured vs nominal frame rate, cadence, frame count vs header vs duration, **timing gaps (dropped frames)**, **bursts (extra
frames)**, jitter, duplicate or missing timestamps, **non-monotonic DTS**, keyframe structure, bitrate and peaks,
bits-per-pixel, corrupt packets, **audio/video start and end offset**, audio discontinuities. Problem locations are marked on
the scrubber. **Deep scan** decodes a file to find *repeated or frozen frames* (which have perfect timestamps) and duplicate
cadence such as 30 fps content in a 60 fps container. These are diagnostics, not a quality score.

## Export

- **Save current frames (PNG)**: each video's frame at native resolution plus the composite view.
- **Save conformed copy**: the adjusted video re-timed to the reference rate. A *retime* is **lossless** (stream copy: only
  timestamps are rewritten and the decoded frames are bit-identical to the source). A *resample* must duplicate or drop
  frames, so it re-encodes to H.265 at high quality (AMD hardware encoder when it works, otherwise software libx265; set
  `VIDEO_COMPARE_ENCODER=hevc_amf` or `libx265` to force one).

## Start, stop and suspend

Shortcuts (step 6) and the taskbar icon control the running app: hover the taskbar icon for **Previous frame, Play/Pause,
Next frame, Suspend/Resume**; right-click it for **Play/pause, Suspend, Resume, Quit**. From a terminal:
`video-compare.cmd --suspend`, `--resume`, `--toggle-play`, `--quit`. With nothing running they do nothing.

**Suspend** (button, `S`, or the shortcut) pauses playback and releases the video decoders and GPU context; **Resume**
restores the exact frame, view, zoom, audio choice and frame offsets, all kept in memory only. Measured with two 4K 10-bit
videos: dedicated GPU memory dropped from 672 to 237 MB, while system RAM dropped only about 45 MB. Only Quit returns the
roughly 370 MB the app itself needs.

## Limits worth knowing

- While **playing**, videos stay within one frame of each other (the status bar shows any offset). **Paused or stepping, pairs are
  exact**, so use stepping for pixel-level judgements.
- Everything is shown through an 8-bit sRGB path: fine for SDR, HDR is not tone-mapped. Non-square pixels are not corrected.
- Audio/video offset precision is about one audio frame (about 21 ms for AAC), because container start times ignore encoder priming.

## Development

```
npm test                                 # unit + integration tests
npm run selftest                         # drives the real app: pixel-level frame pairing, sync, views, exports, suspend/resume
npm run fixtures                         # regenerate the synthetic test clips (add -- --uhd for two 4K clips)
npm run analyze -- file.mp4              # headless health report
npm run icon                             # regenerate assets/icon.png and icon.ico
powershell -File tools\e2e-commands.ps1 a.mp4 b.mp4   # real launch + suspend/resume/quit in an isolated profile, prints RAM/VRAM
```

Test clips are generated patterns with the frame number burned in (no real media is needed), written to `test/fixtures/`.
`npm test` includes a check that every Electron method the main process calls exists in Electron's own type definitions.

`src/main` is the Node side (ffprobe/ffmpeg, timestamp analysis, the conform planner, the exporter, a loopback media
server); `src/renderer` is the UI (`view.js` layout maths, `gl.js` WebGL2 compositor, `engine.js` synchronisation engine);
`src/preload` is the narrow bridge between them.

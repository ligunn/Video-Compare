@echo off
rem Launches Video Compare. Double-click to open empty, or pass videos:
rem   video-compare.cmd a.mp4 b.mp4
rem A running instance is reused, so a second launch just adds the files to it.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*

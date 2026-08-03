@echo off
REM ==========================================================================
REM  THE MICROPHONE - one double-clickable starter.
REM  Runs the node server from this folder and opens the page in the browser.
REM  Pure ASCII (PS 5.1 / cmd safe - no em-dashes, no smart quotes).
REM ==========================================================================
cd /d "%~dp0"
echo Starting THE MICROPHONE on http://127.0.0.1:8080 ...
start "" "http://127.0.0.1:8080"
node server.js
pause

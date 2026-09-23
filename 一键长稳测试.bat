@echo off
rem ============================================================
rem  AnniePlayer SVLX - One-click Soak Test (8 hours)
rem  Double-click to run. Do NOT close this window.
rem  To stop early: press Ctrl+C, answer N when asked.
rem  (Keep this file pure ASCII: cmd parses .bat in the console
rem   codepage, Chinese bytes break parsing under UTF-8/GBK mix.)
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo  AnniePlayer SVLX - Soak Test (8 hours)
echo  Working dir: %CD%
echo  Tip: you may mute Windows volume; the test tone is quiet
echo  and muting does NOT affect the measurement.
echo  Do NOT close this window. Ctrl+C then N to stop early.
echo ============================================================
echo.

echo [1/3] Disable sleep / hibernate on AC power...
powercfg /change standby-timeout-ac 0 >nul
powercfg /change hibernate-timeout-ac 0 >nul

echo [2/3] Running soak test (8 hours, sample every 15s)...
echo       (Chinese progress output below comes from Node)
echo.
node scripts\soak-test.js --minutes 480 --interval 15

echo.
echo [3/3] Restore power settings (30min sleep / 60min hibernate)...
powercfg /change standby-timeout-ac 30 >nul
powercfg /change hibernate-timeout-ac 60 >nul

echo.
echo ============================================================
echo  Finished. Find the Markdown soak report in this folder
echo  and send it to the developer for analysis.
echo ============================================================
pause

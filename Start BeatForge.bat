@echo off
title BeatForge
cd /d "%~dp0"
echo.
echo   BeatForge — uruchamiam...
echo   (Zamknij to okno albo Ctrl+C zeby zatrzymac.)
echo.
call npm start
echo.
pause
exit /b 0

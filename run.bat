@echo off
title Clean Manga Reader Server
chcp 65001 >nul
cls
echo ==========================================================
echo   Clean Manga Reader Server (No Ads)
echo   Open your browser to: http://localhost:7777
echo ==========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local_server.ps1"
pause

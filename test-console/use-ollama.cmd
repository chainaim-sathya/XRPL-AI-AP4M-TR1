@echo off
rem Switches the local test gateway to the local Ollama models listed in
rem config\local-models.json (the one file to edit). Ollama must be running on this PC.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-models.ps1" -To ollama
pause

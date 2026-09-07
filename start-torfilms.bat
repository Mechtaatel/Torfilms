@echo off
cd /d "%~dp0"
if not exist node_modules npm install
start "Torfilms" http://127.0.0.1:18181/
npm start

@echo off
setlocal

set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if exist "%NODE_EXE%" (
  "%NODE_EXE%" "%~dp0standalone-server.mjs"
) else (
  node "%~dp0standalone-server.mjs"
)

exit /b %ERRORLEVEL%

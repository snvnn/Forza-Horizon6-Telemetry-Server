@echo off
setlocal

set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if exist "%NODE_EXE%" (
  "%NODE_EXE%" "%~dp0smoke-standalone.mjs"
) else (
  node "%~dp0smoke-standalone.mjs"
)

exit /b %ERRORLEVEL%

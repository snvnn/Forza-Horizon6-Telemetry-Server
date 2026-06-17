@echo off
setlocal

set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if exist "%NODE_EXE%" (
  "%NODE_EXE%" "%~dp0validate-env.mjs"
) else (
  node "%~dp0validate-env.mjs"
)

exit /b %ERRORLEVEL%

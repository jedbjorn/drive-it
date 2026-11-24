@echo off
rem Drive-It's stdio MCP server for a client on another machine over SSH (spec #10 "Remote Stdio
rem over SSH"):   ssh -T <user>@<vm> drive-it-stdio
rem Every install places it in %LOCALAPPDATA%\DriveIt\app; a Dev Mode install also puts that folder
rem on the user's PATH. It runs the same server as the desktop clients' entries, with the same
rem environment, and writes nothing to stdout but MCP. Each SSH session starts its own server;
rem when SSH drops, stdin closes and the server's normal shutdown runs.
setlocal
for %%I in ("%~dp0..") do set "DRIVE_IT_DATA_DIR=%%~fI"
set "DRIVE_IT_PYTHON=%~dp0runtimes\python\python.exe"
set "DRIVE_IT_LAUNCH_ROOT=%USERPROFILE%\Drive-It"
"%~dp0runtimes\node\node.exe" "%~dp0server\index.js"
exit /b %ERRORLEVEL%

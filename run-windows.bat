@echo off
rem OrderNote CLI launcher for Windows.
rem   Double-click: runs the 20 sample orders and opens the output folder.
rem   Drag an orders .txt file onto this file: runs that file instead.
rem This file is ASCII-only on purpose so cmd.exe parses it under any code page.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo === OrderNote CLI ===
echo.

if not exist "requirements.txt" (
  echo This file must be run from the EXTRACTED folder, not from inside the ZIP.
  echo Right-click the downloaded ZIP, choose "Extract All", open the new
  echo folder (and the folder inside it with the same name), then double-click run-windows there.
  echo.
  pause
  exit /b 1
)

rem --- 1. find Python 3.11+ (py launcher first; plain "python" may be the Store stub)
set "PY="
py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo Python 3.11 or newer was not found on this PC.
  echo.
  echo   1. Open  https://www.python.org/downloads/
  echo   2. Click the big yellow "Download Python 3.x.x" button and run the file it downloads.
  echo      ^(any 3.11+ release is fine; do not pick an "alpha"/"beta" build^)
  echo   3. On the first installer screen tick "Add python.exe to PATH", then "Install Now".
  echo   4. Close this window and double-click run-windows again.
  echo.
  echo Python found on this PC right now ^(if any^):
  py -0 2>nul
  python --version 2>nul
  echo   ^(If a Python older than 3.11 is listed, install a newer one. If you installed Python
  echo    without "Add python.exe to PATH", run the installer again, choose Modify, and tick it.^)
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('%PY% -c "import sys; print(sys.version.split()[0])"') do echo Python %%v found.

rem --- 2. virtual environment + packages (first run only; later runs are quick)
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys" >nul 2>&1 || rmdir /s /q ".venv"
)
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment ...
  %PY% -m venv .venv || goto :fail
)
set "VPY=.venv\Scripts\python.exe"
if not exist ".venv\.deps-ok" (
  echo Installing packages ^(openpyxl, pydantic, rapidfuzz, anthropic^) ...
  echo This takes 1-3 minutes on the first run only. Please wait, even if nothing moves.
  "%VPY%" -m pip install --disable-pip-version-check -r requirements.txt || goto :fail
  echo ok> ".venv\.deps-ok"
)

rem --- 3. optional LLM key (Enter = skip, rule engine runs offline)
if defined LLM_API_KEY (
  echo LLM_API_KEY is set: using the LLM engine.
) else (
  echo.
  echo Anthropic API key ^(sk-ant-...^) for the AI engine. Press Enter to skip and run offline.
  set /p "LLM_API_KEY=LLM_API_KEY: "
)
if defined LLM_API_KEY set "LLM_API_KEY=%LLM_API_KEY: =%"
if defined LLM_API_KEY set "LLM_API_KEY=%LLM_API_KEY:"=%"
if defined LLM_API_KEY if /i not "%LLM_API_KEY:~0,7%"=="sk-ant-" echo Warning: the key does not start with sk-ant- ; API calls may fail.

rem --- 4. run
echo.
if "%~1"=="" (
  "%VPY%" -m ordernote --eval data\expected.json
) else (
  echo Processing "%~1"
  "%VPY%" -m ordernote --orders "%~1"
)
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo Done. Files are in:  %CD%\output
) else if "%RC%"=="1" (
  echo Finished. Exit code 1 here usually means the answer-key check found differences
  echo ^(see the "잘못 매칭" line above^); the files were still written to  %CD%\output
) else (
  echo Finished with exit code %RC%. See the messages above.
)
if exist "output" start "" explorer "output"
pause
exit /b %RC%

:fail
echo.
echo Something went wrong. Select the text above, copy it, and paste it to Claude.
pause
exit /b 1

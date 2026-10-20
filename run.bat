@echo off
rem OrderNote demo launcher for Windows.
rem   Double-click: runs the 20 sample orders and opens the output folder.
rem   Drag an orders .txt file onto this file: runs that file instead.
rem This file is ASCII-only on purpose so cmd.exe parses it under any code page.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo === OrderNote demo ===
echo.

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
  echo   1. Open  https://www.python.org/downloads/windows/
  echo   2. Download "Windows installer (64-bit)" for Python 3.12 or 3.13.
  echo   3. In the installer, tick "Add python.exe to PATH", then click "Install Now".
  echo   4. Close this window and double-click run.bat again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('%PY% -c "import sys; print(sys.version.split()[0])"') do echo Python %%v found.

rem --- 2. virtual environment + packages (first run only; later runs are quick)
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment ...
  %PY% -m venv .venv || goto :fail
)
set "VPY=.venv\Scripts\python.exe"
if not exist ".venv\.deps-ok" (
  echo Installing packages ^(openpyxl, pydantic, rapidfuzz, anthropic^) ...
  "%VPY%" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail
  echo ok> ".venv\.deps-ok"
)

rem --- 3. optional LLM key (Enter = skip, rule engine runs offline)
if defined LLM_API_KEY (
  echo LLM_API_KEY is set: using the LLM engine.
) else (
  echo.
  echo Anthropic API key ^(sk-ant-...^) for the LLM engine.
  echo Press Enter to skip and run the offline rule engine.
  set /p "LLM_API_KEY=LLM_API_KEY: "
)

rem --- 4. run
echo.
if "%~1"=="" (
  "%VPY%" -m ordernote --eval data\expected.json
) else (
  "%VPY%" -m ordernote --orders "%~1"
)
set "RC=%errorlevel%"
echo.
if exist "output" start "" explorer "output"
if "%RC%"=="0" (
  echo Done. Files are in the "output" folder ^(it just opened^).
) else (
  echo Finished with exit code %RC%. See the messages above.
)
pause
exit /b %RC%

:fail
echo.
echo Something went wrong. Select the text above, copy it, and paste it to Claude.
pause
exit /b 1

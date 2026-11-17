@echo off
rem Builds the engine as one .exe and copies it into the Tauri app as a sidecar.
rem Run from this folder in Command Prompt:  build-engine.cmd
setlocal
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  py -3.12 -m venv .venv || goto :fail
)
.venv\Scripts\python -m pip install --disable-pip-version-check -q -r requirements.txt -r requirements-build.txt || goto :fail
.venv\Scripts\python -m unittest discover -s tests -t . || goto :fail
.venv\Scripts\pyinstaller --noconfirm --clean --onefile --console --name farewatch-engine ^
  --add-data "farewatch_engine\data;farewatch_engine\data" ^
  --collect-all fast_flights --collect-all primp --collect-all selectolax ^
  entry.py || goto :fail
if not exist ..\app\src-tauri\binaries mkdir ..\app\src-tauri\binaries
copy /y dist\farewatch-engine.exe ..\app\src-tauri\binaries\farewatch-engine-x86_64-pc-windows-msvc.exe >nul || goto :fail
dist\farewatch-engine.exe selftest || goto :fail
echo.
echo Engine built and copied to app\src-tauri\binaries.
exit /b 0
:fail
echo.
echo BUILD FAILED. Read the error above.
exit /b 1

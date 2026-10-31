@echo off
:startover
echo (%time%) app started.
call ".\start.bat"
echo (%time%) WARNING: App closed or crashed, restarting.
rem Wait first, so a bad token can't hammer Discord with logins
timeout /t 5 /nobreak >nul
goto startover
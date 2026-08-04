@echo off
:startover
echo (%time%) app started.
call ".\start.bat"
echo (%time%) WARNING: App closed or crashed, restarting.
goto startover
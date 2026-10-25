@echo off
rem Starts the analyst for "03 Private chat + analysis": exact cross-file analysis of a data folder (DuckDB, in memory).
rem It listens on 127.0.0.1:8740 only, reads only the folders allowed in config\data-sources.json, never calls a model
rem and holds no keys. Keep this window open while you use the console. Extra flags are passed on, for example:
rem   start-analyst.cmd --period quarter --variance-pct 3
setlocal
cd /d "%~dp0..\services\analyst" || (echo services\analyst not found & pause & exit /b 1)
if not exist "node_modules\@duckdb\node-api\package.json" (
  if exist "package-lock.json" (
    echo Installing the analyst's dependencies ^(DuckDB^) from package-lock.json...
    call npm ci || (echo npm ci failed. & pause & exit /b 1)
  ) else (
    echo Installing the analyst's dependencies ^(DuckDB^) for the first time; this creates package-lock.json - commit it.
    call npm install || (echo npm install failed. & pause & exit /b 1)
  )
)
node src\main.ts %*
pause

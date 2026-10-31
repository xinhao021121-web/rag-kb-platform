@echo off
title 企业级 RAG 知识库平台 · 本地服务
cd /d "%~dp0"

echo ================================================
echo   企业级 RAG 知识库平台 - 真实项目版
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node.js。
  echo 请先安装 node.js 22.5 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -p "process.versions.node"') do set nODE_MAJOR=%%a
if not defined nODE_MAJOR set nODE_MAJOR=0
if %nODE_MAJOR% LSS 22 (
  echo [错误] node.js 版本过低：当前为
  node --version
  echo 请安装 22.5 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行：正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

if not exist .env (
  echo 未找到 .env，正在从 .env.example 复制...
  copy .env.example .env >nul
)

echo.
echo 正在启动服务，请稍候...
echo 浏览器会自动打开：http://127.0.0.1:8787
echo.
echo  请保持此窗口开启；关闭窗口即停止服务。
echo  注意：不要直接双击 web 目录里的 index.html。
echo.

start "" powershell -noProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8787/api/health | Out-null; Start-Process 'http://127.0.0.1:8787'; break}catch{Start-Sleep -Milliseconds 500}}"

node --env-file-if-exists=.env server/index.js

echo.
echo 服务已停止（代码 %errorlevel%）。
pause

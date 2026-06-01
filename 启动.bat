@echo off
cd /d "%~dp0"

echo ============================================
echo     艾宾浩斯背单词 - 一键启动
echo ============================================
echo.

python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] 检测到 Python，正在启动服务器...
    echo.
    echo   * 数据将自动保存到 vocabulary-data.json
    echo.
    start "VocabularyServer" python server.py
    timeout /t 2 /nobreak >nul
    echo [OK] 正在打开浏览器...
    start http://localhost:3000/
    echo.
    echo ============================================
    echo  服务器已启动！
    echo  如果浏览器未自动打开，请手动访问：
    echo    http://localhost:3000/
    echo.
    echo  关闭此窗口即可停止服务器
    echo ============================================
    echo.
    echo  按任意键关闭服务器...
    pause >nul
) else (
    echo [!] 未检测到 Python，将使用浏览器模式
    echo.
    echo   * 数据保存在浏览器中（关闭网页不会丢失）
    echo   * 建议定期点击「保存到文件」备份数据
    echo.
    echo [OK] 正在打开 index.html ...
    start index.html
    echo.
    echo ============================================
    echo  已打开 index.html！
    echo  如果浏览器未自动打开，请手动双击 index.html
    echo ============================================
    echo.
    echo  按任意键关闭...
    pause >nul
)

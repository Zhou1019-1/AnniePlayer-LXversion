@echo off
rem ============================================================
rem  安妮播放器 · 一键长稳测试（8 小时）
rem  双击运行即可。窗口请勿关闭；想提前结束按 Ctrl+C 再输 N，
rem  测试会正常收尾并生成报告。
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   安妮播放器 · 一键长稳测试（8 小时）
echo   报告输出：%CD%\长稳测试报告.md
echo   提示：测试音为低音量正弦波，可把系统音量静音，不影响数据
echo ============================================================
echo.

echo [1/3] 禁止系统睡眠/休眠（插电状态）...
powercfg /change standby-timeout-ac 0 >nul
powercfg /change hibernate-timeout-ac 0 >nul

echo [2/3] 开始长稳测试（8 小时，采样间隔 15s）...
echo.
node scripts\soak-test.js --minutes 480 --interval 15

echo.
echo [3/3] 恢复电源设置（30 分钟睡眠 / 60 分钟休眠）...
powercfg /change standby-timeout-ac 30 >nul
powercfg /change hibernate-timeout-ac 60 >nul

echo.
echo ============================================================
echo   测试结束，报告见：长稳测试报告.md
echo   把报告发给开发即可分析结果
echo ============================================================
pause

@echo off
set project=D:\VocabularyLearningWebsite
for /f "skip=10 delims=" %%d in ('dir "%project%\server_backup" /b /ad /o-n 2^>nul') do (
    rmdir /s /q "%project%\server_backup\%%d"
)
echo Done

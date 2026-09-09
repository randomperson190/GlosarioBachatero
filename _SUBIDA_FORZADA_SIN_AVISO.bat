@echo off
git add .
git commit -m "Subida forzada directa automatizada"
git branch -M main
git push -f https://github.com/randomperson190/GlosarioBachatero.git main
exit
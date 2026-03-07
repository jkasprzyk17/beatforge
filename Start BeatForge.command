#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  BeatForge — uruchamiam..."
echo "  (Zamknij to okno albo Ctrl+C żeby zatrzymać.)"
echo ""
npm start
echo ""
echo "  Zatrzymano. Możesz zamknąć to okno."
read -p "  Naciśnij Enter..."
exit 0

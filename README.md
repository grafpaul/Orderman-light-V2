# Orderman Light V2 (v0.3)

## Neu in v0.3
- **Echter Thermodruck (Windows, RAW/ESC-POS)** über Windows-Druckername (Default: **POS-80C**)
- **Split-Bons nach Abholstation** (Default: **Ausschank** + **Buffet**) – editierbar in Einstellungen
- Bon-Layout:
  - Veranstaltungsname (groß/fett)
  - Abholstation (sehr groß/fett)
  - Datum+Uhrzeit, Bon-Nr (K1-000123)
  - Positionen: Anzahl + Gesamtpreis pro Position
  - Summe je Bon
  - Zahlart (BEZAHLT – BAR/KARTE)

## Start
```bash
npm install
npm run tauri dev
```

## Wichtig
- In **Einstellungen**: Druckername muss exakt wie in Windows heißen (z.B. POS-80C).
- Für Alkohol: Produkte in Abholstation „Ausschank“ setzen, alles andere auf „Buffet“.

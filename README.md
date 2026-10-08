# Krypto Markt

Live-Kurse der Top 1000 Kryptowährungen mit Prognose-Score, Kauf-/Verkaufssignal, Markt-Index, Portfolio und Portfolio-Manager. Reine statische Website (HTML, CSS, JavaScript-Module) – kein Build-Schritt.

**Keine Anlageberatung.** Die Signale sind Rechenwerte aus vergangenen Kursen und können falsch liegen.

## Lokal starten

```bash
python -m http.server 8123
```

Danach `http://localhost:8123` öffnen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `js/app.js` | Ansichten (Markt, Detail, Portfolio, Konto) und Datenabruf |
| `js/model.js` | Prognosemodell: Indikatoren, Bewertungskurven, Markt-Index, Rückblick-Test |
| `js/manager.js` | Portfolio-Manager: Regeln für Kaufen, Verkaufen, Tauschen, Gewinnmitnahme |
| `js/api.js` | Datenquellen: CoinGecko (Kurse), Binance (Kursgeschichte), alternative.me (Fear & Greed), cryptocurrency.cv (Nachrichten) |
| `js/portfolio.js` | Speicherung im Browser und CSV-Import |
| `js/auth.js` | Konten und Speicherung im Konto (Firebase) |
| `js/firebase-config.js` | Zugangsdaten des Firebase-Projekts |
| `firestore.rules` | Zugriffsregeln: Jede Person sieht nur ihr eigenes Portfolio |

## Konten einrichten (Firebase)

Das Portfolio ist nur angemeldet nutzbar. Ohne diese Schritte bleiben Kurse und Prognosen sichtbar, das Portfolio aber gesperrt.

1. Auf <https://console.firebase.google.com> ein Projekt anlegen (kostenloser Spark-Tarif reicht).
2. **Build → Authentication → Sign-in method:** „E-Mail/Passwort“ und „Google“ einschalten.
3. **Authentication → Settings → Authorized domains:** die Adresse der Website hinzufügen, z. B. `aporti1705-cmd.github.io`.
4. **Build → Firestore Database:** Datenbank im Produktionsmodus anlegen und unter „Regeln“ den Inhalt von `firestore.rules` einfügen und veröffentlichen.
5. **Projekteinstellungen → Meine Apps → Web-App hinzufügen:** die angezeigte Konfiguration in `js/firebase-config.js` eintragen (statt `null`).
6. Committen und pushen.

Die Werte in `firebase-config.js` sind keine Geheimnisse; der Schutz läuft über die Firestore-Regeln.

### Konten lokal testen

Mit den Firebase-Emulatoren, ohne echtes Projekt (benötigt Node und Java):

```bash
npx firebase-tools@13.29.1 emulators:start --only auth,firestore --project demo-krypto
```

Dann in der Browser-Konsole der lokalen Seite einmal `localStorage.setItem('krypto-markt-emulator', '1')` ausführen und neu laden. Der Schalter wirkt nur auf `localhost`.

## Wie das Modell geprüft wurde

- Bewertungskurven aus 4 Jahren Tageskursen (10/2022–10/2026) von 38 großen Coins.
- Gegenprüfung an Daten, die nicht zur Anpassung dienten: dieselben Coins 2018–2022 und 48 weitere Coins. Dort liegt das Modell schwächer, aber in derselben Richtung. 30 Tage nach dem Signal stand der Kurs höher: bei „Kaufen“ in 57–58 % der Fälle, bei „Halten“ in 39–48 %, bei Verkaufssignalen in 32–38 %. Das schwächere „Eher kaufen“ war uneinheitlich (60 % in den früheren Jahren, nur 41 % bei den anderen Coins).
- Nach dieser Gegenprüfung wurden die Gewichte angepasst (Marktphase stärker, langfristiger Baustein schwächer) und ein Bärenmarkt-Filter ergänzt: Liegt Bitcoin unter seinem 200-Tage-Schnitt im Abwärtstrend, gibt es keine Kaufsignale.
- Portfolio-Regeln mit 0,25 % Gebühr je Handel zurückgerechnet, wöchentlich geprüft, 2018–2026: mit der ausgewogenen Reserve rund +69 % pro Jahr bei 45 % größtem Rückgang, mit der vorsichtigen rund +61 % bei 37 % (Bitcoin halten: +38 % pro Jahr, 77 % Rückgang). Enthalten ist eine Schutzregel: Verkauf, wenn ein Coin 25 % unter sein Hoch seit dem Kauf fällt.
- Getestete Alternativen (engere Stops, Stop-Loss ab Kaufpreis, tägliches Prüfen, nur 3 große Positionen) lagen alle bei rund 4–5 % im Monatsdurchschnitt. Kein Monat der Rückrechnung erreichte +100 %; ein Durchschnitt von 50 % pro Monat ist nicht erreichbar.
- Antizyklischer Test: Auf Jahressicht stand Bitcoin aus Ständen von mehr als 55 % unter dem Allzeithoch in 96–100 % der Fälle höher, nahe am Hoch nur in 37 %. Auf 30 Tage gilt das Gegenteil (Trend setzt sich fort), und der Fear-&-Greed-Index allein war kein brauchbares Signal. Eine rein antizyklische Reserve brachte im Portfolio nur rund +29 % pro Jahr; deshalb hängt der Reserve-Vorschlag je zur Hälfte an Zyklus und Marktphase, und die Marktphase wird über 14 Tage geglättet.
- Prüfung der Coin-Auswahl (welcher Coin läuft besser als der Markt, 174 000 Coin-Tage, zwei getrennte Zeiträume): Die bisherigen Coin-Merkmale halfen im zweiten Zeitraum kaum. Das einzige Merkmal, das in beiden Zeiträumen klar trug, ist die Schwankung – ruhigere Coins lagen 30 Tage später im Mittel 2–7 Prozentpunkte vor dem Markt, stark schwankende dahinter. Sie fließt deshalb in alle drei Zeithorizonte ein. In der Portfolio-Rückrechnung sank damit der größte Rückgang 2022–2026 von 33 % auf 23 %.
- Verworfen, weil nur in einem der beiden Zeiträume hilfreich: stärkere Belohnung für Nähe zum Jahreshoch, Abzug für stark gestiegene Coins.
- Kleine Tagesrückgänge (1–5 %) sind kein Signal: Der Kurs 7 und 30 Tage später unterschied sich nicht von Tagen mit kleinen Anstiegen.
- Prozent-Prognosen: Für jeden Score ist hinterlegt, wie sich Coins danach entwickelt haben (mittleres Ergebnis, mittlere Hälfte der Fälle, Anteil höherer Kurse), gemessen in Einheiten der Schwankung des Coins. Beide Zeiträume zählen je zur Hälfte. Die Kaufschwelle liegt bei 15, weil das mittlere Ergebnis erst ab dort nach 7 und 30 Tagen im Plus lag. Auf 12 Monate bestimmt der Stand im Zyklus die Prognose; dort widersprechen sich die beiden Zyklen teils stark.
- Token auf Aktien, Fonds, Edelmetalle und Währungen sowie Paare, die Binance nicht mehr handelt, erhalten keine Prognose bzw. keine veralteten Tageskurse.

Grenzen: Die Rückrechnung enthält nur Coins, die heute noch gehandelt werden, ein Teil des Zeitraums diente zur Abstimmung, und Steuern sowie Kursabweichungen beim Handeln fehlen. Echte Ergebnisse werden schlechter ausfallen.

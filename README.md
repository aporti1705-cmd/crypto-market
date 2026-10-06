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

Ohne diese Schritte läuft die Seite normal, speichert das Portfolio aber nur im Browser.

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
- Portfolio-Regeln mit 0,25 % Gebühr je Handel zurückgerechnet, wöchentlich geprüft, 2018–2026: rund +59 % pro Jahr bei 49 % größtem Rückgang (Bitcoin halten: +38 % pro Jahr, 77 % Rückgang).

Grenzen: Die Rückrechnung enthält nur Coins, die heute noch gehandelt werden, ein Teil des Zeitraums diente zur Abstimmung, und Steuern sowie Kursabweichungen beim Handeln fehlen. Echte Ergebnisse werden schlechter ausfallen.

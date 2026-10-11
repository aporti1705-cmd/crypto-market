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
- Portfolio-Regeln mit 0,25 % Gebühr je Handel zurückgerechnet, wöchentlich geprüft, 2018–2026, mit denselben Einstellungen wie die Seite (Marktphase über 14 Tage geglättet) und als Mittel aus 7 Starttagen – je nach Starttag schwankt das Ergebnis um rund ±10 Prozentpunkte pro Jahr. Reserve-Strategien: „Mit dem Trend“ rund +86 % pro Jahr bei 40 % größtem Rückgang (2018–22: +115 %, 2022–26: +61 %), „Antizyklisch“ +67 % bei 40 %, „Vorsichtig“ +59 % bei 25 % (Bitcoin halten: +38 % pro Jahr, 77 % Rückgang). Enthalten ist eine Schutzregel: Verkauf, wenn ein Coin 25 % unter sein Hoch seit dem Kauf fällt. Frühere Angaben (rund 70 % pro Jahr für die damalige Mischung) stammten aus einem Lauf ohne Glättung und mit nur einem Starttag; mit den Einstellungen der Seite lag diese Mischung bei rund 60 %.
- Getestete Alternativen (engere Stops, Stop-Loss ab Kaufpreis, tägliches Prüfen, nur 3 große Positionen) lagen alle bei rund 4–5 % im Monatsdurchschnitt. Kein Monat der Rückrechnung erreichte +100 %; ein Durchschnitt von 50 % pro Monat ist nicht erreichbar.
- Antizyklischer Test: Auf Jahressicht stand Bitcoin aus Ständen von mehr als 55 % unter dem Allzeithoch in 96–100 % der Fälle höher, nahe am Hoch nur in 37 %. Auf 30 Tage gilt das Gegenteil (Trend setzt sich fort), und der Fear-&-Greed-Index allein war kein brauchbares Signal. Die Marktphase wird über 14 Tage geglättet.
- Reserve-Vorschlag, 40 Varianten verglichen: Am besten schnitt in beiden Zeiträumen eine Reserve ab, die der Marktphase folgt (im Bärenmarkt höchstens 15 % investiert, die Bremse greift über 5 Tage verteilt). Je antizyklischer, desto schlechter: Mischung aus Marktphase und Zyklus +60 % pro Jahr bei 46 % Rückgang, nur Zyklus +39 % bei 54 %, nur Fear & Greed (bei Angst investiert, bei Gier in Reserve) +29 % bei 56 %.
- Fear & Greed (alternative.me, Tageswerte seit 2018). Was trug: (1) Nach langer Angst (mindestens 54 der letzten 60 Tage unter 45, oder fast 14 Tage unter 25) und mit Bitcoin mindestens 40 % unter dem Allzeithoch mehr investieren, und zwar in Bitcoin und Ethereum – brachte in beiden Zeiträumen mehr Rendite (+72 % → +86 % pro Jahr). Nach mindestens 60 Tagen Angst stand Bitcoin ein Jahr später in 84–100 % der Fälle höher. (2) Bei einem 7-Tage-Schnitt von 75–85 keine Kaufsignale: Der mittlere Coin stand 30 Tage später nur in 20–33 % der Fälle höher (Median −19 bis −21 %), in beiden Zeiträumen und in jeder Marktphase. Was nicht trug: Altcoins in extremer Angst kaufen (ein Jahr später meist tiefer), bei extremer Gier die Reserve erhöhen (kostete 2018–22 viel Rendite, weil die Kurse Ende 2020 trotz Gier monatelang stiegen; 2022–26 kostete es kaum und senkte den Rückgang leicht – deshalb nur in der Strategie „Antizyklisch“), über 85 gibt es nur eine einzige Phase und damit keine Regel.
- Fear & Greed von CoinMarketCap: erst seit Juni 2023 verfügbar, also nicht über mehrere Zyklen prüfbar. Er läuft zu rund 90 % gleich wie der Index von alternative.me, löst die Regeln aber nur an etwa zwei Dritteln derselben Tage aus. Gerechnet wird deshalb mit alternative.me; der Wert von CoinMarketCap wird angezeigt, wenn ein API-Schlüssel hinterlegt ist.
- Stimmung je Coin (eigener Wert aus RSI, Lage in der 30-Tage-Spanne und 30-Tage-Veränderung): sagte für sich wenig voraus. Unter 15 folgte in 59 % der Fälle eine Erholung über 7 Tage, nach 30 Tagen stand der Kurs aber nur in 43 % der Fälle höher. Der Wert wird angezeigt, fließt aber nicht in den Score ein.
- Prüfung der Coin-Auswahl (welcher Coin läuft besser als der Markt, 174 000 Coin-Tage, zwei getrennte Zeiträume): Die bisherigen Coin-Merkmale halfen im zweiten Zeitraum kaum. Das einzige Merkmal, das in beiden Zeiträumen klar trug, ist die Schwankung – ruhigere Coins lagen 30 Tage später im Mittel 2–7 Prozentpunkte vor dem Markt, stark schwankende dahinter. Sie fließt deshalb in alle drei Zeithorizonte ein. In der Portfolio-Rückrechnung sank damit der größte Rückgang 2022–2026 von 33 % auf 23 %.
- Verworfen, weil nur in einem der beiden Zeiträume hilfreich: stärkere Belohnung für Nähe zum Jahreshoch, Abzug für stark gestiegene Coins.
- Kleine Tagesrückgänge (1–5 %) sind kein Signal: Der Kurs 7 und 30 Tage später unterschied sich nicht von Tagen mit kleinen Anstiegen.
- Prozent-Prognosen: Für jeden Score ist hinterlegt, wie sich Coins danach entwickelt haben (mittleres Ergebnis, mittlere Hälfte der Fälle, Anteil höherer Kurse), gemessen in Einheiten der Schwankung des Coins. Beide Zeiträume zählen je zur Hälfte. Die Kaufschwelle liegt bei 15, weil das mittlere Ergebnis erst ab dort nach 7 und 30 Tagen im Plus lag. Auf 12 Monate bestimmt der Stand im Zyklus die Prognose; dort widersprechen sich die beiden Zyklen teils stark.
- Token auf Aktien, Fonds, Edelmetalle und Währungen sowie Paare, die Binance nicht mehr handelt, erhalten keine Prognose bzw. keine veralteten Tageskurse.
- Daytrading-Register: rund 40 kurzfristige Muster (davon über 20 Short) mit Ziel und Stopp an Tageskerzen mit Hoch und Tief geprüft, 0,5 % Gebühren je Handel, in vier Zwei-Jahres-Abschnitten. In allen vier Abschnitten im Plus lagen nur zwei Long-Muster: (1) Erholung nach einem Wochen-Ausverkauf von mindestens 25 %, wenn der Markt mitfiel, kein Bärenmarkt herrscht und Fear & Greed nicht in der Angstzone steht (Ziel 2-fache, Stopp 3-fache Tagesschwankung, 7 Tage; 83 % der Handel im Plus, im Mittel +7,3 %; im jüngsten Abschnitt über die Signaltage gemittelt aber etwa null) und (2) ein Score ab +40 (Ziel 4-fach, Stopp 3-fach, 14 Tage; 57 % im Plus, im Mittel +2,7 %). Kein Short-Muster bestand die Prüfung – auch nicht „bei extremer Gier shorten“ (2022–26 im Plus, 2020/21 im Minus). Hebel: Bis 3-fach wuchsen Ertrag und Rückgang im Gleichschritt, ab 5-fach häuften sich Zwangsauflösungen; die Seite schlägt deshalb höchstens 3-fach vor.

Grenzen: Die Rückrechnung enthält nur Coins, die heute noch gehandelt werden, die Regeln wurden an denselben Jahren ausgewählt, an denen sie gemessen sind, und Steuern sowie Kursabweichungen beim Handeln fehlen. Echte Ergebnisse werden schlechter ausfallen.

## Fear & Greed Index von CoinMarketCap anzeigen (optional)

Die Seite rechnet mit dem Index von alternative.me. Zusätzlich kann sie den Index von CoinMarketCap anzeigen. Dafür braucht die zentrale Berechnung einen eigenen, kostenlosen API-Schlüssel:

1. Auf <https://coinmarketcap.com/api/> ein kostenloses Konto anlegen und den API-Schlüssel kopieren.
2. Im GitHub-Projekt unter *Settings → Secrets and variables → Actions* ein Secret mit dem Namen `CMC_API_KEY` anlegen und den Schlüssel einfügen (oder im Terminal `gh secret set CMC_API_KEY` ausführen).

Beim nächsten Lauf von „Daten berechnen“ erscheint der Wert unter der Fear-&-Greed-Anzeige.

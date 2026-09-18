# jev-ask

Vraag Jev iets over een bestand in plaats van het bestand te lezen.

Een agent heeft vaak één feit nodig, niet een bestand. Zelf lezen kost ongeveer twaalfduizend
tokens, en die tekst wordt daarna bij elke beurt opnieuw meegestuurd. Jev leest het bestand, de
agent krijgt een kans terug, en het bestand komt nooit in het gesprek.

## Twee gereedschappen

**`ask_file`** — één bestand, één tot tien ja-nee-vragen. Alle vragen gaan in één verzoek, dus tien
vragen kosten hetzelfde als één.

```
0.99  Staat er een wachtwoord of sleutel hard in dit bestand?
0.98  Is er een uitzondering die stil wordt weggeslikt?
0.56  Beschrijft de docstring iets anders dan de functie doet?
0.05  Bevat dit bestand tests?

/tmp/betaling.py · 299 tekens · 570 tokens · jev-1.13.0
```

**`filter_files`** — dezelfde vraag over veel bestanden, gesorteerd op waarschijnlijkheid. Om een
lijst te versmallen voordat je iets opent.

```
Doet dit bestand een netwerkaanroep naar een externe dienst?

0.90  src/qlab/calibrate.py
0.85  src/qlab/corpus_checks.py
…
0.03  src/qlab/__init__.py

17 files · 29787 tokens · jev-latest
```

Zeventien bestanden beoordeeld; de context van de agent groeide met twintig regels.

## Hoe je de uitkomst leest

Boven 0,70 is ja. Onder 0,30 is nee. Daartussen betekent: lees het bestand zelf. Een kans is geen
vonnis — hij zegt waar je moet kijken.

## Installeren

```bash
claude plugin marketplace add ~/Projects/jev-ask
claude plugin install jev-ask@jev-ask
```

De sleutel komt uit de omgeving, nooit uit een bestand. Start Claude Code met de sleutel erin:

```bash
TYPESAFE_API_KEY=$(op read "op://Calq/TypeSafe API/credential") claude
```

## Instellingen

| | Standaard | |
|---|---|---|
| `model` | `jev-latest` | welk Jev-model |
| `maxChars` | 60000 | langer bestand wordt afgekapt; het antwoord zegt dat erbij |

## Grenzen

- Ja-nee-vragen, geen open vragen. Stel één ding per vraag.
- Een bestand dat niet in één verzoek past, wordt afgekapt. Splits het dan zelf.
- Het bestand gaat naar TypeSafe. Doe dit niet met bestanden die daar niet heen mogen.
- Geen afhankelijkheden: één bestand Node, gebruikt `fetch`.

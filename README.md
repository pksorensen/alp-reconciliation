# alp-reconciliation

En ALP-samlebåndslinje der hver morgen henter posteringerne ud af netbanken og skriver
dem ind i et versioneret posteringsregnskab i projektets eget repo.

Det ene sted et menneske skal ind, er MitID — og det bliver stående dér. Opskriften
trykker aldrig godkend. I stedet parkerer kørslen, linjen sender en notifikation med
engangskoden, og et menneske godkender i appen. Så kører den videre af sig selv.

Det er hele formen: **en linje der kan alt undtagen det ene, den ikke må kunne.**

## Importér den

```
https://agentics.dk/import?repo=https://github.com/pksorensen/alp-reconciliation
```

Vælg projektet, importér. Linjen har tre stationer, og der skal ikke sættes noget op i
dem: **Hent posteringer** er den der arbejder — opgaven lander der, og kun der kører der
et job. **Afstemt** og **Fejlet** er endestationer uden trigger; opgaven flyttes selv
derhen af linjens to overgange, alt efter om jobbet melder `success` eller `failure`.

Melder jobbet hverken det ene eller det andet — timeout, afbrudt session — flytter
platformen **ikke** opgaven. Den bliver stående på `Hent posteringer` med sin konklusion
på kortet, og det er det rigtige signal: agenten nåede aldrig at fælde en dom, så
posteringerne kan ikke antages hentet.

Importen læser repoet uden token, så linje-repoet skal være offentligt. Det er derfor
alt kundespecifikt — aftalenavn, kontoform, hvilken bank — ligger i **projektets** repo
og ikke her.

Importen tilbyder to ting, begge tændt fra start: en **startopgave**, så den første
afstemning kan køres med det samme, og en **tidsplan** — hver dag kl. 08:00 dansk tid.

Projektet skal have et git-repo tilknyttet (`gitUrl`). Det er dét repo jobbet kloner,
og det er dér posteringerne bliver committet. **Det repo skal være privat.** Linjen
skriver kontoudtog ind i det.

## Hvad projektet skal indeholde

Et tomt repo er nok til at komme i gang. Regnskabet er kørslens *resultat* —
`parse-exports.mjs` opretter `postings/`, `accounts.json`, `counterparties.json`,
`index.json` og `raw/` fra ingenting — så den første afstemning i et nyt projekt skal
ikke vente på, at nogen har lagt en mappestruktur.

To værdier kan kørslen ikke skaffe ved at gætte: **aftalenavnet** og **kontonavnene**.
Aftalenavnet er assertionen, der forhindrer, at en fremmed virksomheds posteringer havner
i regnskabet, og kontonavnene er det, kørslen åbner. De står ikke i denne opskrift, for
den ligger i et offentligt repo, og de er kundens.

De skal heller ikke tastes af et menneske, der husker forkert. **De står i banken.** Så
den allerførste kørsel i et nyt projekt logger på én gang og *spørger banken*:

```
node tools/run-recipe.mjs --phase start  --goal discover --out ./ud   # parkerer ved MitID
node tools/run-recipe.mjs --phase resume --keep           --out ./ud   # skriver ud/discovery.json
```

`--goal discover` henter ingenting og ændrer ingenting. Den åbner bankens aftalevælger,
læser hvilke aftaler brugeren kan se og hvilke konti der ligger under den, der er valgt
nu, og lukker den igen. Resultatet er fire lister: `aktuelAftale`, `aftaletyper`,
`aftaler` og `konti`.

Først *derefter* spørger stationen mennesket — og nu er spørgsmålet et **valg** mellem
strenge, banken selv har skrevet. Det er ikke en detalje: svaret på et `AskUserQuestion`
føres ind ved at navigere i en radioliste, så fri tekst, der ikke matcher en mulighed,
vælger tavst den første. Et aftalenavn kan aldrig komme ind ad den vej. En liste kan.

`--keep` lader sessionen stå åben, så eksporten kan køre på den samme pålogning:

```
node tools/run-recipe.mjs --phase again --goal export --config <ledger>/config.json --out ./ud
```

Uden den ville en førstegangsopsætning koste to MitID-tryk — ét til at finde ud af, hvad
der skal hentes, og ét til at hente det. En kørsel *er* et verbum på sessionen hos
browser-servicen, og pålogningen hører til sessionen; det er hele mekanikken.

Svarer ingen — fordi klokken er 08:00, og ingen ser med — stopper første kørsel med at
skrive listerne i sin konklusion. Så kan `config.json` lægges i repoet i hånden, og i
morgen kører linjen den korte vej.

En regnskabsmappe — navnet er lige meget, stationen finder den — med en `config.json`:

```json
{
  "bank": "spard",
  "agreement": "Firmanavn ApS",
  "accounts": ["Erhvervskonto", "MasterCard Business"],
  "period": "Seneste 12 måneder",
  "formats": ["CSV"],
  "persistProfile": "spard-firmanavn",
  "ledger": "."
}
```

| Felt | Hvad det gør |
| --- | --- |
| `bank` | Hvilken opskrift der køres (`recipes/<bank>.json`). Feltet stationen genkender mappen på. |
| `agreement` | Aftalen i netbanken. Kørslen **stopper**, hvis den er logget ind på en anden — et kontoudtog fra det forkerte selskab er værre end intet kontoudtog. |
| `accounts` | Kontonavnene som banken skriver dem på oversigten. Navne, ikke `accountId` — et id, der skifter, ville knække linjen tavst, og navnet er alligevel det, mennesket kan genkende. |
| `period` | Bankens egen forudindstilling. Standarden i netbanken er "I dag", og uden det her eksporterer man én dag og tror det gik godt. |
| `formats` | `["CSV"]` er nok til posteringerne. `"PDF"` koster 25-46 sekunder pr. konto og er kun et bilag. |
| `persistProfile` | Navnet på den huskede browserprofil. Uden den møder banken en ny enhed hver morgen — og en ny enhed betyder ekstra verifikation, hver morgen. |

Resten af mappen laver kørslen selv:

```
<ledger>/postings/<konto>/<ÅÅÅÅ-MM>.jsonl   én postering pr. linje
<ledger>/accounts.json                       konti, saldo, sidste postering
<ledger>/counterparties.json                 modparter og hvad de fylder
<ledger>/index.json                          hvad hver kørsel hentede
<ledger>/raw/<ÅÅÅÅ-MM-DD>/…                  eksporten som den blev hentet
```

### Hvorfor filer og ikke en database

Fordi en postering, der er committet, kan sammenlignes med gårsdagens med `git diff`.
Ændrer en linje sig, er det synligt. En database ville skjule præcis dét, og en
afstemning, hvor historikken kan ændre sig usynligt, afstemmer ingenting.

Det er en append-only filbutik med indhold-adresserede id'er — ikke en grafdatabase.
Modpartsregisteret er en projektion, der bygges forfra ved hver kørsel, så det aldrig
kan komme til at sige noget andet end posteringerne selv.

Kørslen er idempotent: hver postering får et id fra sha256 over konto, dato, tekst,
beløb og saldo, og et id, der allerede står i filen, skrives ikke igen. Det er dét, der
gør, at eksporten godt må dække tolv måneder hver eneste dag — overlappet forsvinder af
sig selv, og en dag, der blev sprunget over, bliver samlet op i morgen i stedet for at
være tabt.

## MitID-bruger-id'et

Det står **aldrig** i en opskrift. Opskriften ligger i et offentligt repo; bruger-id'et
er personhenførbart. Værktøjet læser det fra `MITID_USER_ID` i miljøet.

I en station kommer det fra vaulten (ADR 0011 — stationen *er* vaultens agentidentitet):

```
vault agent run --vault "$VAULT_ID" --item "$VAULT_ITEM_ID" --env MITID_USER_ID=userId -- \
  node /tmp/rec/tools/run-recipe.mjs --phase start --config <ledger>/config.json
```

Det kræver en ceremoni, der kun udføres én gang, og som er kryptografisk tvunget i den
rækkefølge: `vault agent add` → kør stationen én gang i hånden, den enrollerer og
blokerer → `vault agent approve --fingerprint …` → `vault agent grant`. Der er ikke
noget at godkende, før nøglen findes.

Uden vault-opsætning skal `MITID_USER_ID` bare stå i miljøet. Det er den rigtige form til
en hånd-kørsel og den forkerte til en daglig, uovervåget station.

## Kør den i hånden

Værktøjet er afhængighedsfrit og kræver kun Node 20+.

```bash
git clone https://github.com/pksorensen/alp-reconciliation
cd alp-reconciliation

BROWSER_URL=https://browser.agentics.dk BROWSER_TOKEN=… MITID_USER_ID=… \
  node tools/run-recipe.mjs --config ~/regnskab/config.json --out ./ud

node tools/parse-exports.mjs --in ./ud --ledger ~/regnskab
```

`--goal export` er standard, og `--phase run` gør begge faser i én proces. Som job køres de hver for sig,
med notifikationen imellem — det er hele grunden til opdelingen: en agent, der sad og
pollede, kunne ikke sende noget imens, og en notifikation efter godkendelsen ville være
ubrugelig.

Mod en lokal browser-service: `--server http://127.0.0.1:8099`.

## Adgangen til browser-servicen

Kører linjen som et job, veksler `run-recipe.mjs` selv runnerens `AGENTICS_TOKEN` til et
5-minutters token udstedt til netop denne browser-service — samme model som npm's trusted
publishers. Der ligger ingen langlivet hemmelighed i containeren.

Det kræver, at ejeren én gang har bundet linjen til de to scopes hos browser-servicen:

```
PUT /v1/owners/<owner>/trust        (med driftstokenet, ikke et fødereret)
{ "bindings": [{ "projectOwner": "<owner>", "project": "<projekt>",
                 "assemblyLineIds": ["<linjens id>"],
                 "scopes": ["browser:sessions", "browser:artifacts:read"] }] }
```

`projectOwner` skal være den samme ejer som i stien — en ejer kan ikke skrive en
binding, der giver en andens linje adgang. Udelades `stationIds`, gælder bindingen
alle stationer på linjen. Ruten tager kun imod driftstokenet: kunne en linje skrive
sin egen binding, var hele modellen pynt.

Linjens id findes først efter importen. **Bemærk:** en ny import laver en *ny* linje med
et nyt id — den opdaterer ikke den gamle. Bind derfor først, når linjen står som den skal,
og tag opdateringer ved at rette i den eksisterende linje, ikke ved at importere igen.

Uden føderation falder værktøjet tilbage på `BROWSER_TOKEN`. Det er reserven til
hånd-kørsler, ikke til stationen.

## Hvad linjen ikke gør

- **Den bogfører ikke.** Den henter og skriver ned. Afstemning mod et bogholderi —
  Dinero eller andet — er ikke bygget. Navnet er en retning, ikke en påstand.
- **Den godkender ikke MitID.** Ikke fordi det er svært, men fordi det ikke *må*: en
  opskrift, der trykkede godkend selv, ville være en opskrift på at give en tjeneste
  kundens identitet.
- **Den kan kun én bank.** `recipes/spard-*.json` er Sparekassen Danmark. En anden bank er
  en ny opskrift ved siden af og et `bank`-felt, der peger på den.

## Opskrifterne

Tre filer, ikke én. Login er sin egen, fordi det er den halvdel, begge mål deler — og
fordi motoren ingen betingelser har: der findes ikke én opskrift, der både kan logge på
og lade være. Værktøjet lægger dem i forlængelse af hinanden.

| Fil | Hvad den gør |
| --- | --- |
| `recipes/spard-login.json` | MitID-pålogningen. Slutter, når netbanken står åben. |
| `recipes/spard-discover.json` | Kigger: aftaler og konti. Henter og ændrer intet. |
| `recipes/spard-export.json` | Den daglige eksport for kontiene i `config.json`. |

De er lister af trin, ikke programmer: ingen udtryk, ingen betingelser, ingen model i
afspilningen. En håndfuld ting i dem ser ud som pynt og er det ikke — de står som
`comment` i filerne selv, hver især fundet ved at flytte en optagelse fra en rigtig
Chrome over i tjenestens Playwright, eller ved at måle på den åbne session bagefter. De
vigtigste:

- **Cookie-muren** sætter `role="alert"` på knappen, så `getByRole('button')` finder
  intet. `#declineButton` virker. Trinnet er `optional`, fordi anden kørsel på en husket
  profil ikke møder muren.
- **MitID's bruger-id er ti `visibility: hidden` inputs.** Playwright nægter `fill` på
  noget usynligt og har ret. Derfor verbet `type`.
- **MitID sender ingen push af sig selv.** Efter FORTSÆT viser den et *valg*. Uden klikket
  på "åbn app på anden enhed" sker der ingenting, og siden ser ud som om den venter.
- **Engangskoden kommer først, når appen har åbnet forespørgslen** — derfor `watch` på
  selve ventetrinnet i stedet for et opslag før.
- **Periodevælgeren skal åbnes først.** `role=menuitemcheckbox` matcher intet, før
  trækkeren er klikket. Og standarden er "I dag": uden de to trin eksporterer man én dag
  og tror, det gik godt.
- **Aftalevælgerens modal har ingen lukkeknap, og `Escape` er en fælde.** Escape lukker
  indholdet, men `ReactModal__Overlay` bliver stående og opsnapper hvert eneste klik
  derefter — netbanken er reelt frosset for automatik, og fejlen kommer først flere trin
  senere som en timeout på en knap, der tydeligvis er der. En navigation river React-træet
  ned og er den eneste rene vej ud. Derfor `goto` og ikke `press`.
- **De to aftaletyper er ikke faneblade.** Et klik på "Erhverv" eller "Privat" skifter
  aftale med det samme, lukker modalen og ændrer brugerens egen netbank. Opdagelsen
  klikker dem derfor aldrig — den læser dem.
- **Konti åbnes på navn, ikke på `accountId`.** `role=link` + `exact` rammer den rigtige
  konto fra oversigten, og så er der ingen id'er at holde ved lige.

### Hvordan en liste slipper ud af en kørsel

`waiting.data` på et `human`-trin er den eneste kanal, og motoren sletter feltet igen i
sit `finally`. Listerne kan altså kun læses, *mens* trinnet står parkeret. Derfor slutter
opdagelsen med et `human`-trin, hvis `until` aldrig matcher, med et kort timeout og
`optional: true`: klienten poller kørslen, fanger listerne i vinduet, og trinnet bliver
sprunget over, så kørslen ender `done` og ikke `failed`.

Skelnen mellem hvad der gemmes, er formen: `collect` giver lister, `watch` giver strenge.
Derfor havner MitID-engangskoden aldrig i `discovery.json`, mens aftale- og kontolisterne
gør.

Det koster også seks sekunder om dagen i eksporten, som gør det samme med kontolisten. Det
er prisen for at kunne opdage, at banken har fået en konto mere, som linjen ikke henter.

Motoren er dør B i `pks-agent-browser`. Dens egne noter står i
`projects/pks-agent-browser/docs/recipes.md`.

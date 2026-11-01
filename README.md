# Døgnrytmelys (com.oystein.circadian)

Homey-app som styrer fargetemperatur og lysstyrke på lys gjennom døgnet.
Lysene organiseres i grupper, og hver gruppe følger enten soloppgang og
solnedgang, eller egne sjekkpunkter på en 24-timers klokke.

## Funksjoner

- **Grupper**: hver med egne lys og egen modus.
  - *Følg sol*: varmt om natta, kaldt midt på dagen, basert på
    soloppgang/solnedgang (eller faste klokkeslett). Lysstyrke valgfritt.
  - *Manuelle punkter*: sjekkpunkter på en klokke med varme og lysstyrke.
    Verdiene glir jevnt mellom punktene, også over midnatt.
- **Riktige verdier ved påslag**: slår du på et lys, får det fargen og
  lysstyrken døgnrytmen har akkurat nå, i stedet for å vente på neste runde
  (hvert 2. minutt).
- **Egen plan for helg og røde dager** (per rom): gjelder fra kl. 12 dagen
  før en lørdag, søndag eller rød dag til kl. 12 på dagen. Altså fredag og
  lørdag kveld, lørdag og søndag morgen, og det samme rundt helligdager
  (påske, Kristi himmelfart, 1. og 17. mai, pinse, jul og nyttår, også
  julaften og nyttårsaften). Kvelden før en arbeidsdag følger hverdagsplanen.
  I *Følg sola* settes egne våkne- og legge seg-tider, med *Egne punkter*
  egne punkter.
- **Soloppgangsvekking** (per rom): lys som er av, slås på helt svakt og
  varmt før vekketid og glir opp til planens verdier. Egen vekketid for
  helg og røde dager (tom = ingen vekking da). Lys som allerede er på,
  røres ikke, og slår du et lys av underveis, stopper vekkingen for det.
- **Fargeområde per lampe**: lampemerker bruker ulike fargeområder (f.eks.
  IKEA 2200–4000 K, Philips Hue 2200–6500 K), så samme verdi gir ulik farge.
  Oppgir du lampens område under «Lys i rommet», regner appen om så alle
  lampene viser samme farge, så langt området rekker.
- **Myk overgang** (per gruppe, 0–5 sekunder): lysene glir over til nye
  verdier i stedet for å hoppe, på lys som støtter det.
- **Lys uten fargetemperatur** kan være med og følger bare lysstyrkekurven.
- **Ikke rør lys som er slått av** (per gruppe).
- **Lås ved manuell justering**: dimmer eller endrer du farge selv, står
  lyset urørt til du låser det opp.
- **Simulering**: kjører hele døgnet på ca. 1 minutt på de ekte lysene.
- **Innstillingssiden** åpner med en oversikt over rommene: lysfargen nå,
  døgnet som en fargestripe, og hver lampe i fargen og styrken den har. Trykk
  på en låst lampe for å låse den opp, eller skru døgnrytmen av for et rom.
  «Endre plan» åpner rommets døgnklokke: ringen viser lysfargen, strekene
  lysstyrken, og viseren står på nå (dra den for å se en annen tid). Med egne
  punkter trykker du på ringen for å legge til et punkt, drar for å flytte,
  og drar inn i midten for å slette.
- **Mørk modus** på innstillingssiden, etter innstillingen på telefonen eller PC-en.
- **Tokens** for hver gruppe: «[gruppe]: varme (%)» og «[gruppe]: lysstyrke (%)»
  (0 = kaldest, 100 = varmest), til bruk i andre flows.
- **Insights**: varme og lysstyrke for hvert rom logges hvert 2. minutt, så
  du kan se grafer over dem i Homey under Insights.

### Flow-kort

| Når … | Hva den gjør |
|---|---|
| Et lys ble låst etter manuell justering | Kjører når du endrer lysstyrke eller farge selv. Token: lysets navn |

| Og … | Hva den sjekker |
|---|---|
| [lys] er / er ikke låst | Om appen har sluttet å styre lyset (manuell lås eller pause) |

| Så … | Hva den gjør |
|---|---|
| Skru døgnrytme av/på for [gruppe] | Mens den er av, lar appen lysene i gruppen være i fred |
| Aktiver døgnrytmestyring (alle lys) | Låser opp alle lys |
| Aktiver døgnrytmestyring for ett lys | Låser opp ett lys |
| Slå på [gruppe] og start døgnrytme | Slår på alle lys i gruppen med verdiene døgnrytmen har nå, og låser dem opp |
| Sett døgnrytme på pause for [lys/gruppe] til det slås av | Appen rører ikke lyset før det slås av, f.eks. for nattlys styrt av bevegelse |

## Oppdatere på Homey

Kjør i PowerShell:

```
C:\Homeyprojects\com.oystein.circadian\oppdater.ps1
```

Skriptet henter siste versjon fra GitHub, installerer avhengigheter og kjører
`homey app install`. PC-en må være på samme nettverk som Homey. Sier den at
Homey er offline, kjør `homey logout` og `homey login` først.

## Automatisk testing

Hver gang en endring pushes til GitHub, kjører GitHub Actions testene i
`test/run-tests.js` og `homey app validate`. Resultatet vises som en grønn
hake eller rødt kryss ved commiten på GitHub. Testene kan også kjøres lokalt
med `node test/run-tests.js`.

## Se loggen

```
homey app run --remote
```

Avslutt med Ctrl+C. Den installerte versjonen fortsetter å kjøre.

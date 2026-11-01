# Daylight Rhythm (com.oystein.circadian)

*English:* Daylight Rhythm is a Homey app for circadian lighting. It adjusts
the colour temperature and brightness of your lights through the day, room by
room: following sunrise and sunset or your own points on a 24-hour clock, with
weekend and holiday plans, a sunrise wake-up, daylight-aware brightness and a
history graph. The app is available in English and Norwegian. Issues and
suggestions: https://github.com/oysteineliassen/com.oystein.circadian/issues

*Norsk:* resten av dokumentet er på norsk.

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
- **Språk**: appen og innstillingssiden er på engelsk og norsk, etter
  språket Homey er satt til. Navnet er Daylight Rhythm på alle språk.
- **Røde dager** (nederst på forsiden): Norge eller ingen. Nye installasjoner
  får Norge når Homey er på norsk, ellers ingen.
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
- **Testfarge**: «Vis testfarge» under «Lys i rommet» setter alle lampene i
  rommet til samme kelvin i 30 sekunder, så du kan sammenligne dem og
  justere fargeområdet. Etterpå får lampene tilbake det de hadde.
- **Dagslys** (per rom): med en lyssensor (lux) i rommet skrus lysstyrken
  ned når det er lyst ute, og opp igjen når det er mørkt og grått. Bruker
  snittet de siste 10 minuttene og endrer bare når forskjellen er over 5 %.
- **Siste melding fra lyset**: hver lampe viser når Homey sist meldte en
  endring («endret kl. 14:02»). Endrer du et lys med en fjernkontroll og
  tidspunktet ikke endrer seg, har ikke Homey fått beskjed; da kan det hjelpe
  å starte lysets egen app i Homey på nytt.
- **Lås opp** virker med en gang: bare den lampen får nye verdier, og en ring
  rundt lampen viser at appen jobber.
- **Varsler**: en melding i Homeys tidslinje når et lys ikke finnes lenger,
  en lyssensor ikke har målt noe på over et døgn, eller et lys ikke har latt
  seg oppdatere tre ganger på rad. Hvert problem varsles én gang. Kan skrus
  av nederst på forsiden.
- **Sikkerhetskopi**: nederst på forsiden kan du kopiere alle innstillingene
  som tekst og gjenopprette dem senere, f.eks. etter at appen er installert
  på nytt.
- **Historikk**: det planen ber om (varme og lysstyrke, med dagslys regnet
  inn), lysstyrken og varmen lysene faktisk har (snittet av de som er på; 0 i
  lysstyrke når alle er av), og målt dagslys, logges hvert 2. minutt. I
  grafen er den faktiske linjen farget med den faktiske lysfargen. Grafen ligger på rommets side
  («Historikk», siste døgn eller uke), og de samme tallene finnes i Homey
  under Insights.

### Flow-kort

| Når … | Hva den gjør |
|---|---|
| Et lys ble låst etter manuell justering | Kjører når du endrer lysstyrke eller farge selv. Token: lysets navn |
| Soloppgangsvekking startet i [rom] | Token: rommets navn |
| Soloppgangsvekking ferdig i [rom] | Ved vekketid, når lysene har nådd planens verdier |

| Og … | Hva den sjekker |
|---|---|
| [lys] er / er ikke låst | Om appen har sluttet å styre lyset (manuell lås eller pause) |

| Så … | Hva den gjør |
|---|---|
| Skru døgnrytme av/på for [gruppe] | Mens den er av, lar appen lysene i gruppen være i fred |
| Start soloppgangsvekking i [rom] over [minutter] minutter | F.eks. fra vekkerklokka på telefonen. Virker også når rommets faste vekking er av |
| Aktiver døgnrytmestyring (alle lys) | Låser opp alle lys |
| Aktiver døgnrytmestyring for ett lys | Låser opp ett lys |
| Slå på [gruppe] og start døgnrytme | Slår på alle lys i gruppen med verdiene døgnrytmen har nå, og låser dem opp |
| Sett døgnrytme på pause for [lys/gruppe] til det slås av | Appen rører ikke lyset før det slås av, f.eks. for nattlys styrt av bevegelse |

## Oppdatere på Homey fra PC (gammel måte)

Appen oppdateres nå fra Homey App Store, se «Oppdatere uten PC» under.
Det som står her, gjelder bare hvis du går tilbake til å installere fra PC-en.

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

## Oppdatere uten PC (Homey App Store, testkanalen)

GitHub laster opp en ny versjon til Homey App Store hver gang appen endres
på `main` (`.github/workflows/publish.yml`). Versjonen er ikke offentlig:
den blir et utkast som bare du ser, og kan slippes til testkanalen, som bare
de med testlenken kan installere fra.

**Én gang:**

1. Logg inn på https://tools.developer.homey.app med Homey-kontoen din. Under
   kontoen din (https://tools.developer.homey.app/me) lager du en
   «Personal Access Token». Kopier den.
2. På GitHub: repoet → Settings → Secrets and variables → Actions →
   New repository secret. Navn: `HOMEY_PAT`, verdi: tokenet.
3. På GitHub: Actions → «Publiser til Homey App Store» → Run workflow. Da
   lastes første versjon opp.
4. På https://tools.developer.homey.app → appen → den nye versjonen: slipp
   den til Test. Der står også testlenken.
5. Ta en sikkerhetskopi av innstillingene først (nederst på forsiden av
   innstillingssiden). Åpne så testlenken på telefonen og installer appen.
   Den erstatter versjonen du har installert fra PC-en.

**Etterpå:** når en ny versjon er lastet opp, slipper du den til Test i
utviklerportalen og oppdaterer appen i Homey-appen. Bruk ikke `oppdater.ps1`
etter dette, for den installerer PC-versjonen over App Store-versjonen.

Versjonsnummeret settes av GitHub (`1.1.<kjøringsnummer>`), og endringsloggen
er commit-meldingen. Ingen av dem lagres i git, så `app.json` sier fortsatt
`1.0.0`.

## Se loggen

```
homey app run --remote
```

Avslutt med Ctrl+C. Den installerte versjonen fortsetter å kjøre.

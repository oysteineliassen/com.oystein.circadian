# Notater for Claude

Homey-app (SDK v3, Node.js) for døgnrytmestyring av lys. Brukeren er Øystein,
skriv til ham på norsk. Han utvikler på Windows og har en Homey Pro (Early 2023).

## Arbeidsflyt

- Endringer pushes til `main` på GitHub. Appen er installert fra Homey App
  Store (testkanalen): `publish.yml` laster opp hver endring som utkast, og
  Øystein slipper den til Test i utviklerportalen og oppdaterer i Homey-appen.
  Si fra til ham når en ny versjon er lastet opp. `oppdater.ps1` (PC) skal
  ikke brukes lenger, den installerer PC-versjonen over App Store-versjonen.
- Du kan ikke teste mot ekte Homey. Kjør `node test/run-tests.js` (falske
  `homey`, `homey-api`, `suncalc`; sjekker også syntaks i innstillingssiden og
  at Flow-kort/API-ruter i `app.json` finnes i koden). Legg til tester for ny
  logikk der.
- GitHub Actions (`.github/workflows/test.yml`) kjører testene og
  `homey app validate --level debug` på hver push. Sjekk at den er grønn.
- `.github/workflows/publish.yml` laster opp hver endring i appens filer på
  `main` til Homey App Store som utkast (krever hemmeligheten `HOMEY_PAT`).
  Den setter versjon `1.1.<run_number>` og en endringslogg fra commit-
  meldingen uten å committe dem, og kjører Homey CLI direkte (Athoms egen
  action krever `package-lock.json`, som er utelatt med vilje). Commit-
  meldingen blir endringsloggen i App Store: første linje på engelsk, og en
  linje `NO: …` med norsk tekst (ellers brukes den engelske for norsk også).
- Hold `README.md` oppdatert når funksjoner eller Flow-kort endres.

## Filer

- `app.js`: all logikk. Tick hvert 2. minutt, gruppeverdier, skriving til lys,
  låser, simulering, Flow-kort.
- `settings/circadian.js`: rene funksjoner på "minutter siden midnatt"
  (0–1439), inkl. `groupValues()` og helgeregelen. Brukes av appen (via
  `lib/circadian.js`, som bare re-eksporterer) OG av innstillingssiden
  (`window.Circadian`), så klokka viser nøyaktig det appen gjør. Ligger i
  `settings/` fordi Homey bare serverer den mappa til siden. Hold den fri for
  Node-ting (ingen `require`).
- `test/run-tests.js`: tester. Ekskludert fra appen via `.homeyignore`.
- `api.js`: tynne ruter for innstillingssiden.
- `settings/index.html`: innstillingssiden (vanilla JS, ingen byggesteg).
  To visninger: rom-oversikt (status fra `/status`) og rommets døgnklokke
  (`buildDial`), som også er redigereren for egne punkter. Lagre-linja nederst
  sammenligner `config` med sist lagrede versjon. Bryterne i oversikten
  lagrer med en gang.
- `app.json`: manifest, API-ruter og Flow-kort.

## Språk (appen er for et internasjonalt publikum)

- Appen heter **Daylight Rhythm** på alle språk («Circadian Lighting» er tatt
  av en annen app). App-ID `com.oystein.circadian` må ikke endres.
- Alle tekster brukeren ser, står i `locales/en.json` og `locales/no.json`
  (samme nøkler, testen sjekker det). Innstillingssiden bruker
  `tr('settings.x', { var })`, appen `this._t('app.x', { var })`; `{var}` i
  teksten byttes ut. Insights-titler lagres på alle språk med `_titles()`.
  Aldri skriv norsk eller engelsk tekst rett i koden.
- Søk: stikkordene i `app.json` (`tags`) og «Circadian lighting» i
  beskrivelsen gjør at appen kommer opp når noen søker på «circadian».
- `config.holidays`: `'NO'` eller `'none'` (`HOLIDAY_CALENDARS` i
  `settings/circadian.js`). Gamle oppsett uten valget får `'NO'`, nye får
  `'NO'` når Homey er på norsk. Flere land legges til i `HOLIDAY_CALENDARS`.

## Lærdommer (ikke gjør disse feilene på nytt)

- **Kapabilitetsverdier**: `homeyApi.devices.on('device.update')` gir IKKE
  endringer i onoff/dim/light_temperature. Bruk
  `device.makeCapabilityInstance(cap, cb)` per enhet (se
  `_syncCapabilityListeners`). Appen holder egen live-tilstand i `_capState`;
  `device.capabilitiesObj` fra `getDevice()` kan være utdatert.
- **`this.homey.settings.set()` er synkron** og returnerer ikke et promise.
  Aldri `.catch()` på den; bruk try/catch (`_persistLocks`).
- **Tidssone**: containeren kjører i UTC. Bruk `this.homey.clock.getTimezone()`
  og `zonedMinutesOfDay()`; aldri `Date.getHours()`.
- **Sol**: `ManagerGeolocation` har ikke getSunrise. Bruk `suncalc` med
  `getLatitude()/getLongitude()`.
- **Skriving**: kall `device.setCapabilityValue(cap, v)` på enhetsobjektet.
  Sett `_lastAppliedAt` og `_lastWritten` FØR skriving, ellers tolkes ekkoet
  som manuell justering og lyset låses.
- **Mange lys tolker "sett dim" som "slå på".** Sjekk av-tilstand rett før
  skriving (settle-vent på 3 s), og slå lyset av igjen hvis det ble slått av
  mens appen skrev (`_offAt`).
- **Cachen kan lyve.** Mens socketen er tilkoblet returnerer
  `devices.getDevice()` det cachede objektet, så den og `_capState` kan begge
  si "på" hvis en av-hendelse gikk tapt. Rett før skriving hentes fersk
  tilstand med `getDevice({ id, $cache: false, $updateCache: false })`. Sier
  den av, hoppes lyset over og lytterne bygges på nytt
  (`_resetCapabilityListeners`).
- **Slettede/omparede lys** blir liggende i `group.deviceIds` (ny paring gir
  ny ID). `getDevice` kaster «Not Found»; `_markIfMissing` husker dem i
  `_missing`, tick hopper over dem, og `/status` gir `missing: true`, så
  innstillingssiden kan tilby å fjerne dem. Sjekkes på nytt ved lagring.
- **Helg/røde dager**: `freeDays(date, tz, holidays)` + `isWeekendAt()` (morgen:
  er i dag fri? fra kl. 12: er i morgen fri?). Norske helligdager inkl.
  julaften og nyttårsaften; påske regnes ut. `isWeekendPlan(weekday, …)` finnes bare
  for testene og gamle kall.
- **Fargeområde** (`config.calibration[deviceId] = { warmK, coolK }`):
  planen bruker skalaen 0 = 6500 K .. 1 = 2200 K. `toDeviceTemp()` regnes om
  først i `_applyValuesToDevice` (og i `turnOnGroup`/vekking), så alt videre,
  inkl. `_lastWritten` og låsdeteksjon, er i lampens egne enheter. `/status`
  regner tilbake med `fromDeviceTemp()`.
- **Vekking** (`_checkWakeUps` i tick, `_startWakeUp`): bare lys som er av ved
  start; `_waking[id]` gjør at tick, påslag og låsdeteksjon lar dem være.
  Fremdrift regnes fra starttidspunktet, ikke ved å lese klokka på nytt.
- **Dagslys** (`luxEnabled`, `luxSensorId`): `_syncLuxListeners` lytter på
  `measure_luminance`, `_luxNow` gir snitt over 10 min, `luxFactor()` (felles
  fil) gir andelen av planens lysstyrke. `_groupTarget()` er det lysene
  faktisk skal få (plan + dagslys) og brukes av tick, påslag og «slå på
  gruppe»; tokens/Insights viser planen uten dagslys. `dimTolerance` hindrer
  blafring.
- **Testfarge** (`showTestColor`): lagrer forrige tilstand per lys i
  `_testing.before` og skriver den tilbake etter 30 s; tick, påslag og
  låsdeteksjon hopper over lys som testes (`_isTesting`).
- Den falske Homey-en i testene må ha alt appen bruker (`setTimeout`,
  `clearTimeout`, `insights` …): mangler noe, feiler appen bare i testen.
- **Insights**: logg-ID `${groupId}-temp` / `-dim` / `-lux`, med verdiene
  lysene faktisk får (`_groupTarget`). Ryddes i `_pruneInsights` ved lagring.
  Historikkgrafen leser dem tilbake med
  `homeyApi.insights.getLogEntries({ id: 'homey:app:<app-id>:<logg-id>', resolution: 'last24Hours' | 'last7Days' })`
  (`/history`). Lux har egen graf (log-skala), aldri samme akse som prosent.
- Låser: `true` = manuell (til opplåsing), `'untilOff'` = pause til lyset
  slås av.
- `light_temperature`: 0 = kaldest, 1 = varmest. Sett `light_mode` til
  `'temperature'` først på lys som har det.
- Lys uten `light_temperature` skal bare få dim.
- **Fade** (`fadeSeconds`) er begrenset til 5 s: lys som rapporterer
  mellomverdier under fading må komme innenfor `LOCK_GRACE_MS` (8 s), ellers
  låses de som manuelt justert. Ved påslag brukes ingen fade.
- **Påslag** (`_onSwitchedOn`) venter 1 s før skriving, så en flow som slår på
  og deretter pauser et lys rekker å pause det først.
- **Flow-tokens** kan ikke endre tittel; ved nytt gruppenavn fjernes tokenet og
  lages på nytt (`_doUpdateTokens`, kjøres i kø).
- **Mørk modus** i innstillingssiden: bruk CSS-variablene i `:root`, ikke
  faste farger. SVG-farger settes med `el.style.fill/stroke = 'var(--x)'`
  (presentasjonsattributter støtter ikke `var()`).

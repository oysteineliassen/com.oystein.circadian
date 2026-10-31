# Notater for Claude

Homey-app (SDK v3, Node.js) for døgnrytmestyring av lys. Brukeren er Øystein,
skriv til ham på norsk. Han utvikler på Windows og har en Homey Pro (Early 2023).

## Arbeidsflyt

- Endringer pushes til `main` på GitHub. Øystein kjører `oppdater.ps1` på PC-en,
  som gjør `git pull` + `npm install` + `homey app install`.
- Du kan ikke teste mot ekte Homey. Kjør `node test/run-tests.js` (falske
  `homey`, `homey-api`, `suncalc`; sjekker også syntaks i innstillingssiden og
  at Flow-kort/API-ruter i `app.json` finnes i koden). Legg til tester for ny
  logikk der.
- GitHub Actions (`.github/workflows/test.yml`) kjører testene og
  `homey app validate --level debug` på hver push. Sjekk at den er grønn.
- Hold `README.md` oppdatert når funksjoner eller Flow-kort endres.

## Filer

- `app.js`: all logikk. Tick hvert 2. minutt, gruppeverdier, skriving til lys,
  låser, simulering, Flow-kort.
- `lib/circadian.js`: rene funksjoner på "minutter siden midnatt" (0–1439),
  inkl. `groupValues()` (brukes av tick, Flow og simulering) og helgeregelen.
- `test/run-tests.js`: tester. Ekskludert fra appen via `.homeyignore`.
- `api.js`: tynne ruter for innstillingssiden.
- `settings/index.html`: innstillingssiden (vanilla JS, ingen byggesteg).
- `app.json`: manifest, API-ruter og Flow-kort.

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

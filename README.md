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
- **Lys uten fargetemperatur** kan være med og følger bare lysstyrkekurven.
- **Ikke rør lys som er slått av** (per gruppe).
- **Lås ved manuell justering**: dimmer eller endrer du farge selv, står
  lyset urørt til du låser det opp.
- **Simulering**: kjører hele døgnet på ca. 1 minutt på de ekte lysene.

### Flow-handlinger

| Handling | Hva den gjør |
|---|---|
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

## Se loggen

```
homey app run --remote
```

Avslutt med Ctrl+C. Den installerte versjonen fortsetter å kjøre.

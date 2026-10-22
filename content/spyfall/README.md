# Casus Kim? — mekânlar ve roller

`locations.json` holds the content for the Spyfall-style game "Casus Kim?" (see PLAN.md §4.1).

## Schema

```json
{
  "version": 1,
  "locations": [
    { "id": "hastane", "name": "Hastane", "emoji": "🏥", "roles": ["Doktor", "Hemşire", "..."] }
  ]
}
```

| Field   | Type     | Rule |
|---------|----------|------|
| `id`    | string   | Lowercase ASCII slug (`a-z0-9` and `-`), unique. Stable key, safe to store in game state. |
| `name`  | string   | Turkish display name, unique (case/diacritic-insensitive). |
| `emoji` | string   | One emoji (one grapheme; ZWJ sequences like 🏴‍☠️ are allowed). |
| `roles` | string[] | 8–10 distinct roles specific to the place. |

## Counts

- 51 locations, 463 roles (8–10 per location, average about 9).
- Roughly half are classic Spyfall places (uçak, denizaltı, uzay istasyonu, korsan gemisi, sirk, banka…). The other half are Turkish places (Kapalıçarşı, vapur, düğün salonu, sünnet düğünü, askerlik şubesi, KYK yurdu, Doğu Ekspresi, bayram ziyareti…).

## Notes for the game code

- Games have up to 12 players and at most 10 roles per location. When there are more non-spy players than roles, hand out roles again (shuffle, then cycle).
- The spy sees the full list of location `name`s (with emoji) when guessing. Roles are never shown to the spy.
- Locations were picked so that no two are near-duplicates. For example, there is a single wedding venue (Düğün Salonu) next to the distinct Nikâh Dairesi and Sünnet Düğünü, and one school (Lise) next to the distinct Dershane and KYK Yurdu.
- All content was written by hand for this project. There is no external source.

## Validation

```
node content/spyfall/validate.mjs
```

The script checks the schema, unique ids and names, 8–10 roles per location, no duplicate roles within a location (Turkish-aware, case- and diacritic-insensitive), at least 45 locations, and a single emoji. It prints the counts and exits with code 1 on any error.

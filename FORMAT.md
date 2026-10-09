# AiM `.drk` (RDX v2) layout

Reverse-engineered from Solo DL files and RaceStudio2 samples. All integers are little-endian.

## File header (0x000 – 0x420)

| Offset | Type | Meaning |
|---|---|---|
| 0x000 | `RDX\x02` | magic + version (older loggers use `RD\x90\x01` / `RD\xF4\x01`; different format) |
| 0x024 | cstr | original file name |
| 0x040–0x074 | text | logger date `dd-mm-yy hh:mm:ss` (position varies; scan for it) |
| 0x074 | u32 | file size |
| 0x078 | u32 | logged duration in ms (all sessions back-to-back) |
| 0x080 | u16, u16 | channel count, lap count |

## Blocks

Starting at 0x420, a run of blocks. Each block starts with a 4-byte tag (`XXX\x02`) and a 0x20-byte header, followed by a fixed-size body:

| Tag | Body | Count | Content |
|---|---|---|---|
| `PPX` | 0x400 | 1 | vehicle (+0x00), track (+0x28), driver (+0x50), session name (+0x78); 40-byte strings |
| `IIX` | 0x80 | 1 | logger info (not used) |
| `MMX` | 0x400 | one per channel | channel descriptor |
| `GGX` | 0x100 | one per lap | lap record |
| `RRX` | 0x1000 | one per session (run) | session record (not needed for decoding) |

Some RaceStudio2 versions tag the `PPX` and `IIX` blocks as `RDX`, so identify those two by position (they always come first, in that order) rather than by tag.

Sample data starts right after the last block.

### Channel descriptor (`MMX` body)

| Offset | Type | Meaning |
|---|---|---|
| 0x00 | cstr[0x14] | name (truncated to 14 chars) |
| 0x15 | char[5] | unit code `CCSSD`: unit class, sub-unit, display decimals |
| 0x40 | u16 | sensor type id (selects the raw → engineering conversion) |
| 0x48 | u32 | number of samples |
| 0x4C, 0x50 | f32 | display min / max |
| 0x5C, 0x60 | f32 | accelerometer zero point / gain-sign (internal accelerometers) |

### Lap record (`GGX` body)

| Offset | Type | Meaning |
|---|---|---|
| 0x00 | u32 | lap start, ms from start of log |
| 0x04 | u32 | coarse lap time, ms (when the logger noticed the crossing; start + this = next lap's start) |
| 0x10 | u32 | lap number within session |
| 0x26 | u8 | 0x08 = out lap, 0x02 = in lap, 0x20 = timed lap |
| 0x53 | u8 | session number |
| 0x76 | u32 | precise lap time, ms (interpolated crossing; what RaceStudio2 displays; unaligned) |

## Sample data

Channels are stored one after another in descriptor order, each as `count` × int16.
A channel's rate is `count / (duration_ms / 1000)` and sample *k* is at time *k / rate*.
`0xCFFE` (-12290) marks a missing sample (e.g. ECU not responding).

## Conversions (raw → value)

| Type id | Channel(s) | Conversion |
|---|---|---|
| 341 | battery | raw / 1000 V |
| 120 | RPM | raw |
| 121, 3001 | wheel/vehicle speed, GPS speed | raw / 10 km/h |
| 150 | pedal, engine load | raw / 10 % |
| 122 | water temp | raw / 10 °C |
| 123 | oil / outside temp | raw °C |
| 315 | fuel | raw / 100 l |
| 336 | GPS position accuracy | raw / 100 m |
| 3003, 3004 | GPS lateral / longitudinal acc | (raw − 16000) / 1570.8 g |
| 3005 | GPS slope | (raw − 15708) × 1e-4 rad |
| 3006 | GPS heading | raw / 5000 − π rad (compass bearing) |
| 3007 | GPS gyro (yaw rate) | (raw − 15708) / 2500 rad/s |
| class `04`, id < 1000 | internal accelerometers | ±(raw − zero@0x5C) / 440 g, sign from f32@0x60 |
| others | switches, steering angle, etc. | raw |

## `.gpk` (GPS positions, saved by RaceStudio2 next to each `.drk`)

| Offset | Type | Meaning |
|---|---|---|
| 0x00, 0x10 | `PROV` | headers |
| 0x1E | 3 × f64 | ECEF X, Y, Z (m) of the local reference point |
| 0x50 | `PSOL` | header; records start at 0x60, 144 bytes each |

`PSOL` record: `PSOL`, u32 time on the `.drk` timeline (ms; sessions back to back like the `.drk`), u16 GPS week, u32 iTOW,
u8 fix, u8 flags, then f64 east, north, up (m from the reference point), f64 ?, f64 velocity east, north, ... Records are 8 Hz.

# AiM `.xrk` (RaceStudio3) layout

A stream of tagged messages and sample records. All integers are little-endian; times are logger milliseconds.

## Messages

`"<h"` + 4-char tag + u32 payload length + u8 version + `">"`, the payload, then `"<"` + tag + u16 checksum + `">"`.
`CNF` contains the configuration as nested messages.

| Tag | Content |
|---|---|
| `CHS` (in `CNF`) | channel: u16 index (+0x00), unit code (+0x0C, low 7 bits), value format (+0x14), short name (+0x18, 8), long name (+0x20, 32), sample period in µs (+0x40), sample size in bytes (+0x48) |
| `GRP` (in `CNF`) | u16 group id, u16 count, count × u16 channel indexes |
| `LAP` | u16, u16 lap number, u32 lap time ms, u32, u8, u8 flag (1 = out, 2 = timed, 3 = in), u16, u32 lap end time |
| `GPS` | u32 logger time + u-blox NAV-SOL from iTOW (iTOW, fTOW, week, fix, flags, ECEF X/Y/Z cm, pAcc, ECEF VX/VY/VZ cm/s, sAcc, pDOP, -, numSV, -) |
| `RCR` / `VEH` / `TRK` / `TMD` / `TMT` | driver, vehicle, track, date (mm/dd/yyyy), time |

## Sample records

| Record | Layout |
|---|---|
| `(S` | u32 time, u16 channel, one sample, `)` |
| `(M` | u32 time, u16 channel, u16 count, count samples spaced by the channel period, `)` |
| `(G` | u32 time, u16 group id, one sample of each channel in the group, `)` |

2-byte samples are IEEE half floats; 4-byte samples are float32 (format 3 = int32). Batteries are logged in mV.

Unit codes: 1 %, 3 g, 4 deg, 5 deg/s, 8 m, 11 raw, 14 bar, 15 rpm, 16 km/h, 17 °C, 18 ms, 19 Nm, 21 V, 22 l, 31 gear.

# Racelogic `.vbo` layout

Plain text (CRLF, Latin-1). The first line is `File created on DD/MM/YYYY @ HH:MM:SS`, then `[section]` blocks:

| Section | Contents |
|---|---|
| `[header]` | Long channel names, one per line (informational) |
| `[channel units]` | Units, either one per column or only for the non-GPS columns (writers differ) |
| `[comments]` | Free text. Some converters add `Track: ...`, `Vehicle: ...`, `Driver: ...` lines, which Lapline uses for the session info |
| `[laptiming]` | `Start  x1 y1 x2 y2 ¬ name`: the two ends of the start/finish line in minutes. Optional `Finish` and `Split` lines in the same form |
| `[column names]` | Short column names, space separated; these define the `[data]` columns |
| `[data]` | One sample per line, space (sometimes comma) separated, to end of file |

Standard columns:

| Column | Meaning |
|---|---|
| `sats` | Satellites in the low 6 bits; bit 6 = brake trigger, bit 7 = DGPS |
| `time` | UTC as `HHMMSS.SS`; wraps at midnight |
| `lat` | Latitude in minutes (degrees × 60), north positive |
| `long` | Longitude in minutes, **west positive** (negated for the usual east-positive degrees) |
| `velocity` | km/h |
| `heading` | Degrees, 0 = north |
| `height` | Metres |

Everything else (CAN, analog, IMU, `avi*` video sync) follows. Writers disagree on the coordinate order and longitude
sign in `[laptiming]`, so the reader tries each interpretation and keeps the one whose line lies on the driven path.
Line crossings are interpolated between samples, so lap times aren't quantised to the sample rate.

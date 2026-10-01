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
| 0x04 | u32 | lap time, ms |
| 0x10 | u32 | lap number within session |
| 0x26 | u8 | 0x08 = out lap, 0x02 = in lap, 0x20 = timed lap |
| 0x53 | u8 | session number |

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

# Lapline

A fast, modern viewer for AiM `.drk` log files (Solo, Solo DL and other RaceStudio2 GPS loggers).
It runs entirely in your browser: no install, no server, and your data never leaves your machine.

## Run it

**Online:** https://landonh12.github.io/Lapline/ works on any computer (Windows, Mac, Linux) in Chrome, Edge, Safari or Firefox.
Files are still read locally in the browser and never uploaded.

**Offline:** double-click `index.html` in a copy of this repo.

Then drag in one or more `.drk` files. On Windows, RaceStudio2 stores downloads in `C:\AIM_SPORT\RaceStudio2\DATA`.

## Features

- **Track map** built from GPS speed + heading, colored by speed, with live cursor dots for every compared lap.
  Hover the map to scrub through the lap.
- **Lap overlays** against distance or time, with any channels, any number of chart panes.
  Each channel gets its own y scale. Drag to zoom, wheel to zoom, shift+wheel to pan, double-click to reset;
  arrow keys nudge the cursor.
- **Time delta** vs a reference lap (first selected; right-click a compared lap to make it the reference).
- **G-G diagram** for the visible range.
- **Cursor readout** of every channel for every compared lap.
- **Laps table** with lap and delta times, top speed, peak lateral and braking g, full-throttle %, max RPM, water and oil temps,
  plus a **theoretical best** built from the best of 12 equal-distance segments.
- **Channels table** with rate, sample count, % valid, and min/mean/max, so a dead sensor is obvious at a glance.
- Compare laps **across days**: open several files from the same track.
- Click a session header to view the **whole session** (handy for temps and battery).
- Imperial/metric toggle, light/dark theme, and **CSV export** of the selected laps.

## Notes and limits

- Lap times are the logger's own beacon times. RaceStudio2 re-times laps from GPS, so its numbers can differ by a few hundredths.
- The map is dead-reckoned from GPS speed/heading (lat/long isn't stored in the `.drk`), so it shows the track's shape, not a satellite overlay.
- Scaling for the BMW CAN channels, GPS channels, batteries and internal accelerometers was calibrated against RaceStudio2 CSV exports.
  Channels from other ECUs/sensors whose type id isn't known yet are shown raw. Add them to `converter()` in `js/drk.js`.
- The pre-2006 `.drk` format (non-GPS loggers) isn't supported.

See `FORMAT.md` for the file layout.

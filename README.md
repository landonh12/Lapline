# Lapline

A fast, modern viewer for AiM log files: RaceStudio2 `.drk` (Solo, Solo DL, ...) and RaceStudio3 `.xrk` (MXS, Solo 2 DL, ...),
plus Racelogic `.vbo` files from VBOX loggers and apps that export the format (RaceChrono, Harry's LapTimer, TrackAddict, ...).
It runs entirely in your browser: no install, no server, and your data never leaves your machine.

## Run it

**Online:** https://landonh12.github.io/Lapline/ works on any computer (Windows, Mac, Linux) in Chrome, Edge, Safari or Firefox.
Files are still read locally in the browser and never uploaded.

**Offline:** double-click `index.html` in a copy of this repo.

Then drag in one or more `.drk`, `.xrk` or `.vbo` files. For `.drk` logs, also drop in the `.gpk` file with the same name (RaceStudio2 saves it next to the `.drk`) to get real GPS positions. On Windows, RaceStudio2 stores downloads in `C:\AIM_SPORT\RaceStudio2\DATA`.

## Features

- **Track map** built from GPS speed + heading, colored by speed, with live cursor dots for every compared lap.
  Hover the map to scrub through the lap.
- **Lap overlays** against distance or time, with any channels, any number of chart panes.
  Each channel gets its own y scale. Drag to zoom, wheel to zoom, shift+wheel to pan, double-click to reset;
  arrow keys nudge the cursor.
- **Time delta** vs a reference lap (first selected; right-click a compared lap to make it the reference).
- **Map tab**: every compared lap's racing line on satellite imagery, with cursor dots synced to a speed and time-delta chart. Drag on the chart to zoom the map into a corner; hover the map to scrub.
- **G-G diagram** for the visible range.
- **Cursor readout** of every channel for every compared lap.
- **Laps table** with lap and delta times, top speed, peak lateral and braking g, full-throttle %, max RPM, water and oil temps,
  plus a **theoretical best** built from the best of 12 equal-distance segments.
- **Channels table** with rate, sample count, % valid, and min/mean/max, so a dead sensor is obvious at a glance.
- Compare laps **across days and drivers**: open several files from the same track, even a mix of `.drk`, `.xrk` and `.vbo`.
- Click a session header to view the **whole session** (handy for temps and battery).
- Imperial/metric toggle, light/dark theme, and **CSV export** of the selected laps.

## Notes and limits

- Lap times are the logger's precise line-crossing times (lap block offset +0x76), so they match RaceStudio2 to the millisecond.
- A `.drk` doesn't store latitude/longitude; Lapline reads them from the matching `.gpk`. Without it, the Track card falls back to a shape dead-reckoned from GPS speed/heading and the Map tab can't place that lap.
- The Map tab loads satellite tiles from Esri, so it needs an internet connection and Esri sees which area you're viewing. Your log data still stays in the browser.
- Scaling for the BMW CAN channels, GPS channels, batteries and internal accelerometers was calibrated against RaceStudio2 CSV exports.
  Channels from other ECUs/sensors whose type id isn't known yet are shown raw. Add them to `converter()` in `js/drk.js`.
- `.vbo` laps come from the start/finish line in the file's `[laptiming]` section (a `Finish` line too makes it a point-to-point run).
  Without one, the whole log is shown as a single lap. `.vbo` has no standard track or vehicle field; Lapline reads `Track:`, `Vehicle:` and `Driver:` lines from `[comments]` if present.
- The pre-2006 `.drk` format (non-GPS loggers) isn't supported.

See `FORMAT.md` for the file layout.

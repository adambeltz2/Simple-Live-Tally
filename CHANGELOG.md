# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2026-08-07
### Added
- **Scrolling Top Leaders Ticker:** Added a continuous animated marquee ticker in the header highlighting the top 1-N leaders (Top 5 frontrunners) at a glance, perfect for events with dozens of teams.

## [1.7.0] - 2026-08-07
### Changed
- **Inline Bar Totals:** Moved team dollar totals from the right side into the colored progress bars, left-justified in bold white text (rendered only when the total is greater than $0).
### Fixed
- **Gauge Text Contrast:** Fixed an issue where gauge chart text could become difficult to read or hidden depending on light/dark theme modes.

## [1.6.0] - 2026-08-07
### Added
- **Factory Reset Function:** Added a one-click factory reset button inside Global Settings to completely wipe sample data before going live.
- **Delete Team (Entity Purge):** Added the ability to permanently delete an individual Team/Entity from the Data Management portal.
### Fixed
- **Dark Mode Configuration:** Fixed an issue where the Tailwind CDN configuration was not applying the `.dark` class correctly.
- **Empty State Protections:** Added safeguards so the dashboard gracefully handles a completely empty database without crashing.

## [1.5.0] - 2026-08-07
### Added
- Global Settings Module, Transaction Management, Event Purging, and Dark Mode toggle.

## [1.4.0] - 2026-08-07
### Added
- Optional goal amounts for Events and animated SVG Gauge Chart.
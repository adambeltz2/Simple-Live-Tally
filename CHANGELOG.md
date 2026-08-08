# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-08-07
### Fixed
- **Management Input Compression:** Fixed a layout bug in the Data Management tab where the browser's native `datetime-local` input field was forcing the "Goal" number input to collapse on small screens. The event editing controls now utilize `flex-wrap` and explicit minimum widths to ensure all inputs remain usable.

## [1.10.0] - 2026-08-07
### Changed
- **TV Mode Top 10 Scaling:** Redesigned the sizing algorithm for TV Mode elements. The leaderboard view is now explicitly restricted to the Top 10 entities to perfectly fit standard 1080p display aspect ratios without ever showing a scrollbar. 
- **Absolute Bar Label Positioning:** Changed the rendering structure of the progress bars. The dollar amounts overlay is now positioned absolutely within the row relative to the background track, rather than inside the constrained width wrapper of the colored bar fill, preventing text cut-off on fractional percentages. 
### Fixed
- **TV Mode Ticker Display:** Fixed an issue where the top leaders ticker bar was forcefully hidden by an overly aggressive display state check in TV mode.

## [1.9.0] - 2026-08-07
### Changed
- **Optimistic UI Data Sync:** Overhauled the transaction submission logic. The dashboard updates instantly (0ms latency).
- **Viewport Constraints (Scrollbar Fix):** Re-engineered the application layout using strict flexbox boundaries (`h-screen`, `flex-1`, `min-h-0`). 
### Fixed
- **Ticker Overflow:** Fixed an issue where the top leaders scrolling ticker would clip its text against the bottom of the header container.

## [1.8.1] - 2026-08-07
### Fixed
- **Entity Uniqueness Validation:** Enforced strict case-insensitive uniqueness checks for public team names.
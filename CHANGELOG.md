# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-08-07
### Changed
- **Optimistic UI Data Sync:** Overhauled the transaction submission logic. The dashboard leaderboard now updates instantly (0ms latency) upon clicking "Submit Vote," while the JSON data syncs to Dropbox invisibly in the background. This eliminates visual lag, "flicker," and UI reverts when managing thousands of transactions over a network.
- **Viewport Constraints (Scrollbar Fix):** Re-engineered the application layout using strict flexbox boundaries (`h-screen`, `flex-1`, `min-h-0`). The application container now perfectly snaps to the monitor height without triggering browser-level scrollbars, and intelligently enables internal scrollbars only within the leaderboard and management lists themselves.
### Fixed
- **Ticker Overflow:** Fixed an issue where the top leaders scrolling ticker would clip its text against the bottom of the header container.

## [1.8.1] - 2026-08-07
### Fixed
- **Entity Uniqueness Validation:** Enforced strict case-insensitive uniqueness checks for public team names during both entity creation (`addEntity`) and modification (`editEntity`) to prevent duplicates.

## [1.8.0] - 2026-08-07
### Added
- **Scrolling Top Leaders Ticker:** Added a continuous animated marquee ticker in the header highlighting the top 1-N leaders (Top 5 frontrunners) at a glance.

## [1.7.0] - 2026-08-07
### Changed
- **Inline Bar Totals:** Moved team dollar totals from the right side into the colored progress bars.
### Fixed
- **Gauge Text Contrast:** Fixed an issue where gauge chart text could become difficult to read.

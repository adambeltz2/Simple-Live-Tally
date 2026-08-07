# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-08-07
### Added
- Optional goal amounts for Events.
- Dynamic, animated SVG Gauge Chart on the leaderboard to track total event progress against the active event's goal.
- Graceful re-authentication handling. The app now detects expired Dropbox tokens (401 Unauthorized responses), safely clears local storage, and prompts the user to log in again.
### Fixed
- Resolved a race condition in the Data Management tab where incoming 60-second Dropbox data fetches would overwrite user text input before it could be saved.

## [1.3.0] - 2026-08-07
### Added
- Data Export functionality. Administrators can now download a point-in-time snapshot of the database as a timestamped `.zip` archive (powered by JSZip) directly from the Data Management tab.

## [1.2.0] - 2026-08-07
### Added
- Tabbed Navigation UI, cleanly separating the "Live Dashboard" from "Data Management".
- Full CRUD (Create, Read, Update) interface for managing Events and Entities directly from the browser.
- Real-time countdown timer that actively counts down to the selected event's end date/time.

## [1.1.0] - 2026-08-07
### Added
- Dedicated TV Display Mode (`/#tv` hash route) for high-contrast, fullscreen viewing on projectors and large monitors.
- Relational data model strictly linking Transactions to specific Entities and active Events.
- Footer configuration with versioning, GitHub repository links, and creator support links.

## [1.0.0] - 2026-08-07
### Added
- Initial release of the BYOS (Bring-Your-Own-Storage) architecture.
- Single-file HTML/JS framework designed for GitHub Pages deployment.
- Integration with Dropbox App Folders via OAuth 2.0 PKCE for backend-less state management.
- Auto-refreshing leaderboard with conflict-resolution logic for concurrent transaction entries.
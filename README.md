# Simple Live Tally

**Simple Live Tally** is a serverless, near real-time fundraising and voting display web application designed for live events. It uses a **Bring-Your-Own-Storage (BYOS)** architecture, running entirely as a static site on GitHub Pages and storing all data securely inside your own personal Dropbox account using an App Folder.

---

## Features

* **Serverless & Zero Maintenance:** Hosted for free on GitHub Pages with no backend server or database infrastructure required.
* **Dropbox App Folder Integration:** Authenticates securely via OAuth 2.0 PKCE. Data is safely stored in a single `data.json` file inside your Dropbox `/Apps/Simple Live Tally/` folder.
* **Optimistic UI Zero-Latency Updates:** Submitting transactions updates the live dashboard instantly without network delay, managing data syncs quietly in the background for a perfectly smooth operator experience.
* **Strict Uniqueness Validation:** Prevents duplicate public team names during creation and modification processes.
* **Scrolling Top Leaders Ticker:** An animated marquee ticker in the header showcases the top 1-N frontrunners continuously.
* **Live Dashboard & Leaderboard:** Automatically polls Dropbox every 60 seconds to update totals, re-sort leaders dynamically, and render smooth progress bars with absolute text positioning to prevent layout clipping.
* **Dynamic Event Goals:** Set financial goals for your events and watch an animated SVG Gauge Chart fill up in real-time. 
* **Custom Branding & Dark Mode:** Toggle between light and dark themes, upload a custom logo, and inject your own custom title and primary brand colors directly from the UI.
* **Dedicated TV / Projector Display Mode:** Append `#tv` to the URL to instantly switch to a high-contrast mode with a specifically scaled-down Top 10 leaderboard designed to display on 1080p projectors without scrolling.
* **Full Data Management & Factory Resets:** Easily create, edit, or delete Events and Teams. Purge sample data with a single click before going live.
* **Point-in-Time Backups:** Instantly export your entire database as a timestamped `.zip` package right from the management panel.

---

## Quick Start & Deployment Guide

If you want to deploy your own instance of this application on GitHub Pages, follow these steps:

### 1. Fork or Clone the Repository
Clone or fork this repository into your own GitHub account and enable **GitHub Pages** pointing to the `main` branch.

### 2. Register a Dropbox App
1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps).
2. Click **Create app**.
3. Choose **Scoped access**.
4. Choose **App folder** (this restricts the application to only access its own dedicated folder for privacy and security).
5. Name your app (e.g., `Simple Live Tally`).

### 3. Configure Redirect URIs
1. In your Dropbox App settings, scroll down to the **OAuth 2** section.
2. Under **Redirect URIs**, add your exact GitHub Pages URL (trailing slash required):
   `https://<your-username>.github.io/<repository-name>/`
   *(Optional: You can also add `http://localhost:8000/` or `http://127.0.0.1:5500/` for local testing).*

### 4. Connect Your App Key
Open `index.html`, locate the configuration block at the top of the script, and ensure your Dropbox App Key is set:

```javascript
const CLIENT_ID = 'your_dropbox_app_key_here';
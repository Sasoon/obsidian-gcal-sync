# Obsidian Google Calendar Sync

## Overview

Obsidian Google Calendar Sync is a plugin for Obsidian that syncs your Obsidian Tasks to Google Calendar as events. It is currently only a one way sync from Obsidian to Google Calendar, with plans to implement bidirectional sync in the future. The plugin supports syncing reminders, task start/end times, full mobile support and has auto-sync functionality. There's also a repair option which will strip all events in Google Calendar created by this plugin and recreate them, which can be helpful if you experience inconsistencies in the sync process. and You can configure a bunch of options in the settings such as default reminder time, limit sync to specific folders/files and optional verbose logging.

A quick note on metadata and task IDs: 

The plugin uses IDs in the form of HTML comments included as part of the task content in order to reliably  and persistently track tasks across different lines, files, app reboots or even across vaults. You'll see the IDs at the end each task line, and throughout your editing the ID will always be pushed to the end of the line for clarity. The IDs themselves are protected so you don't accidentally delete them, however they are deletable if you delete the entire task line (this is by design). The IDs are saved into the metadata, which itself lives in the plugin settings along with your oauth tokens. This keeps your task metadata and auth status consistent across sessions and devices. 

## Authentication & Setup

### Desktop Setup (Windows, macOS, Linux)
1. Install the plugin from the Obsidian Community Plugins or GitHub
2. Enable the plugin in Obsidian settings
3. Click the plugin icon in the ribbon or status bar to connect
4. The plugin will authenticate using a local web server (port 8085)
5. Authorize the plugin when prompted in your browser
6. Your tasks will now sync with Google Calendar

### Mobile Setup (iOS, Android)
1. Install the plugin from the Obsidian Community Plugins
2. Enable the plugin in Obsidian settings 
3. Click the plugin icon in the ribbon or status bar to connect
4. The plugin will open your browser to authenticate with Google
5. You'll be redirected to the plugin's Netlify authentication service
6. After authentication, return to Obsidian when prompted
7. Your tasks will now sync with Google Calendar

### Mobile Without Netlify Option
If you prefer not to use the Netlify authentication service on mobile:
1. Authenticate on desktop first using the steps above
2. Ensure your Obsidian vault syncs between devices (using Obsidian Sync or another sync method)
3. The authentication tokens will sync to your mobile device
4. Open Obsidian on mobile and you should be authenticated

## Security and Privacy

- OAuth 2.0 authentication with PKCE for enhanced security
- Credentials are never stored in the plugin
- OAuth tokens are stored locally in your Obsidian vault
- Direct communication between Obsidian and Google Calendar
- The Netlify service only exchanges authentication codes for tokens and never stores your credentials

## Technical Implementation

The plugin is built using TypeScript and integrates with:
- Google Calendar API for event management
- Obsidian API for task parsing and metadata handling
- OAuth 2.0 with PKCE for secure authentication
- Netlify serverless functions for secure token exchange on mobile

## Requirements

- Obsidian v0.15.0 or higher
- Google account with Calendar access
- Internet connection for synchronization

## Support

For issues, questions, or feature requests, please visit the [GitHub repository](https://github.com/sasoon/obsidian-gcal-sync).

## License

MIT
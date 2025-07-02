# Obsidian Google Calendar Sync

## Overview

Obsidian Google Calendar Sync is a plugin for Obsidian that syncs your Obsidian Tasks to Google Calendar as events. It is currently only a one way sync from Obsidian to Google Calendar. The plugin supports syncing reminders, task start/end times, full mobile support and has auto-sync functionality. There's also a repair option which will strip all events in Google Calendar created by this plugin and recreate them, which can be helpful if you experience inconsistencies in the sync process. You can configure a bunch of options in the settings such as default reminder time, limit sync to specific folders/files and optional verbose logging

A quick note on metadata and task IDs: 

The plugin uses IDs in the form of HTML comments included as part of the task content in order to reliably  and persistently track tasks across different lines, files, app reboots or even across vaults. You'll see the IDs at the end each task line, and throughout your editing the ID will always be pushed to the end of the line for clarity. The IDs themselves are protected so you don't accidentally delete them, however they are deletable if you delete the entire task line (this is by design). The IDs are saved into the metadata, which itself lives in the plugin settings along with your oauth tokens. This keeps your task metadata and auth status consistent across sessions and devices

## Installation

### Requirements
[Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)

### Installing the Plugin
Currently the plugin has not been added to the Obsidian Community plugins yet, this will happen after some testing and feedback from early users

#### Manual Installation
1. Download the latest release from [GitHub Releases](https://github.com/sasoon/obsidian-gcal-sync/releases)
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins/` directory
3. Restart Obsidian and enable the plugin in Settings > Community Plugins

## Authentication & Setup
Desktop authenticates using your local server, however mobile does not support this so I have created a Netlify landing page with a serverless function that will authenticate your device. If you have security concerns, feel free to bypass the Netlify layer by authenticating via desktop and syncing your auth tokens to mobile via Obsidian Sync, git or any other method you prefer. You do not need to setup your own Google Cloud project to authenticate, however you can if you want to. The Google verification page currently says "Google hasn’t verified this app", I am currently working on verifying the app

### Desktop Setup (Windows, macOS, Linux)
1. Click the plugin icon in the ribbon or status bar
3. The plugin will open your browser for authentication
4. A local web server will handle the OAuth callback (port 8085)
5. Grant the requested permissions
6. Return to Obsidian - you should see a success message
7. Your tasks will now sync with Google Calendar

### Mobile Setup (iOS, Android)
1. Click the plugin icon in the ribbon or status bar
3. The plugin will open your browser for authentication
4. After authorizing, you'll be redirected to a Netlify authentication service
5. The service will send you back to Obsidian
6. The plugin will complete authentication and show a success message
7. Your tasks will now sync with Google Calendar

## Usage

### Basic Usage
1. Create tasks in Obsidian using the checkbox syntax `- [ ] Task description`
2. The plugin will automatically add a task ID to the end of each task line
3. Tasks will sync to Google Calendar based on your settings
4. Changes to task descriptions, dates, or completion status will sync automatically

![image](https://github.com/user-attachments/assets/aa9d9790-7cb5-4d5f-be0e-c38c47edff3b)


### Date and Time Formats
The plugin recognizes these date formats in your tasks:
- `📅 YYYY-MM-DD` - Task date without time
- `⏰ HH:MM` - Start time
- `➡️ 15:30` - End time
- `📅 YYYY-MM-DD ⏰ HH:MM` - Task date with time
- `⏳ YYYY-MM-DD` - Start date for tasks with a duration

### Reminders
- Set a reminder with `🔔XX` where XX is the time before the task. It accepts minutes, hours and days in the following syntax: `🔔25m`, `🔔9h`, `🔔3d`. Make sure the reminder follows the emoji with no space in between them. The reminder can be anywhere in the task
- Example: `- [ ] Buy keyboard 🔔1d 📅 2025-03-04`
- If no reminder value is specified, the default reminder time from settings is used

### Configuration Options
In the plugin settings, you can:
- Enable/disable auto-sync
- Set a default reminder time (in minutes)
- Limit sync to specific folders
- Enable verbose logging for troubleshooting
- Adjust mobile optimizations and file scan limits

![image](https://github.com/user-attachments/assets/93756ab2-ef72-40ba-9d26-410cee7335c3)


### Ribbon
The plugin adds a ribbon on desktop and mobile which can be used to initiate a manual sync, toggle auto-sync, repair and disconnect from Google Calendar. The auto-sync will sync your changes to Gcal on demand. If you experience a sync disruption of any kind, run the repair command to strip your Gcal of Obsidian Tasks and recreate them. This should generally fix most desynchronization issues. Disconnect will delete your oauth tokens, and will prompt you to reconnect. The ribbon also acts as a status indicator on desktop, and will update dynamically to indicate sync status and active syncs

![image](https://github.com/user-attachments/assets/8d23e5da-224c-4f70-9a60-5b761b11d727)

![image](https://github.com/user-attachments/assets/af2f3c1c-fe60-463f-a23d-8c8134ecea55)

![image](https://github.com/user-attachments/assets/03ea4bc3-b8eb-4ddb-b0f0-82ffe3e09064)


## Security and Privacy

- **OAuth 2.0 with PKCE**: Secure authentication without storing your Google password
- **Local Token Storage**: OAuth tokens are stored only in your Obsidian vault settings
- **No External Data Storage**: The plugin only communicates directly with Google APIs
- **Mobile Authentication**: The Netlify service only exchanges auth codes for tokens and never stores your credentials

## Support

For issues, questions, or feature requests, please visit the [GitHub repository](https://github.com/sasoon/obsidian-gcal-sync).

## License

GNU General Public License v3.0 (GPL-3.0)

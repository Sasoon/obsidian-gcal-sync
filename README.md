# Obsidian Google Calendar Sync

## Overview

Obsidian Google Calendar Sync is a plugin for Obsidian that enables seamless synchronization between your Obsidian tasks and Google Calendar. This integration allows you to manage your tasks in Obsidian while having them automatically appear in your Google Calendar, helping you maintain a unified view of your schedule and commitments.

## Key Features

- **Bidirectional Sync**: Synchronize tasks between Obsidian and Google Calendar
- **Task Formatting**: Format tasks with date, time, and duration specifications
- **Reminders**: Set custom reminders for your tasks
- **Auto-Sync**: Tasks automatically sync when they change
- **Mobile Support**: Full functionality on both desktop and mobile devices
- **Secure Authentication**: OAuth 2.0 with PKCE for secure Google account access

## Task Formatting

Create tasks in Obsidian using the following syntax:

```
- [ ] Task description =E YYYY-MM-DD p HH:MM ! HH:MM = XXm
```

Where:
- `=E` sets the date (YYYY-MM-DD)
- `p` sets the start time (HH:MM)
- `!` sets the end time (HH:MM) - optional
- `=` sets the reminder time (number + m/h/d for minutes/hours/days) - optional

## Security and Privacy

- OAuth 2.0 authentication with PKCE for enhanced security
- Credentials are never stored in the plugin
- OAuth tokens are stored locally in your Obsidian vault
- Direct communication between Obsidian and Google Calendar
- No data sent to third-party servers

## Technical Implementation

The plugin is built using TypeScript and integrates with:
- Google Calendar API for event management
- Obsidian API for task parsing and metadata handling
- OAuth 2.0 for secure authentication

## Requirements

- Obsidian v0.15.0 or higher
- Google account with Calendar access
- Internet connection for synchronization

## Installation

1. Install from Obsidian Community Plugins or download from GitHub
2. Enable the plugin in Obsidian settings
3. Connect to Google Calendar using the welcome screen or ribbon icon
4. Authorize the plugin when prompted
5. Begin creating and syncing tasks

## Support

For issues, questions, or feature requests, please visit the [GitHub repository](https://github.com/sasoon/obsidian-gcal-sync).

## License

MIT

## Google Cloud Console Configuration

For the OAuth flow to work correctly, you need to configure your Google Cloud Console project with the following settings:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project
3. Navigate to "APIs & Services" > "Credentials"
4. Edit your OAuth 2.0 Client ID
5. Add the following authorized redirect URIs:
   - For desktop: `http://127.0.0.1:8085/callback`
   - For mobile: `https://obsidian-gcal-sync-netlify-oauth.netlify.app/redirect.html`
6. Add the following authorized JavaScript origins:
   - `https://obsidian-gcal-sync-netlify-oauth.netlify.app`
   - `https://obsidian.md`
7. Make sure your application type is set to "Web application" (not Android or iOS)
8. Save your changes

**Important**: The redirect URIs must match exactly what's configured in the code. The mobile authentication flow uses Obsidian's built-in URL handling to capture the OAuth callback.

## Performance Optimizations

This plugin includes several optimizations to make synchronization efficient and reliable:

1. **Task Queue Deduplication**: Prevents duplicate tasks from being added to the sync queue, reducing redundant processing.

2. **Smart Change Detection**: Tasks are only synced when they've actually changed, significantly reducing unnecessary API calls.
  
3. **Adaptive Debouncing**: Dynamically adjusts sync timing based on queue size and recent sync activity.

4. **Efficient File Reading**: Processes tasks by file rather than individually, greatly reducing redundant file reads.

5. **Task Batching**: Groups similar tasks together in batches for more efficient processing.

6. **Enhanced Caching**: Improved caching of task states and file contents reduces redundant parsing.

7. **Improved Process Management**: Better handling of concurrent sync processes prevents orphaned intervals and lock states.

These optimizations help ensure that synchronization is fast, stable, and resource-efficient, even with large numbers of tasks.
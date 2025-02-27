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
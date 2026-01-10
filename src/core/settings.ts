import { App, PluginSettingTab, Setting } from 'obsidian';
import type GoogleCalendarSync from './main';
import { GoogleCalendarSettings } from './types';
import { useStore } from './store';
import { Notice } from 'obsidian';

export const DEFAULT_SETTINGS: GoogleCalendarSettings = {
    clientId: '',
    clientSecret: '',
    oauth2Tokens: undefined,
    syncEnabled: true,
    defaultReminder: 30,
    includeFolders: [],  // Empty by default to scan all folders
    taskMetadata: {},
    taskIds: {},
    verboseLogging: true,  // Default to false for new users
    hasCompletedOnboarding: true,  // Set to true to prevent welcome modal on startup
    mobileSyncLimit: 100,  // Default to 100 files on mobile
    mobileOptimizations: true,  // Enable mobile optimizations by default
};

export class GoogleCalendarSettingsTab extends PluginSettingTab {
    plugin: GoogleCalendarSync;

    constructor(app: App, plugin: GoogleCalendarSync) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Google Calendar Sync Settings' });

        // Sync Settings Section
        containerEl.createEl('h3', { text: 'Sync Settings' });

        new Setting(containerEl)
            .setName('Auto-sync')
            .setDesc('Automatically sync tasks when they are created or modified')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.syncEnabled = value;
                    useStore.getState().setSyncEnabled(value);
                    await this.plugin.saveSettings();
                    this.plugin.updateStatusBar();
                    new Notice(`Auto-sync ${value ? 'enabled' : 'disabled'}`);
                }));

        new Setting(containerEl)
            .setName('Folders to Sync')
            .setDesc('Specify folders to scan for tasks. One folder per line. Leave empty to scan all folders.')
            .addTextArea(text => text
                .setPlaceholder('folder1\nfolder2/subfolder')
                .setValue(this.plugin.settings.includeFolders.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.includeFolders = value
                        .split('\n')
                        .map(folder => folder.trim())
                        .filter(folder => folder.length > 0);
                    await this.plugin.saveSettings();
                }));

        // Calendar Settings Section
        containerEl.createEl('h3', { text: 'Calendar Settings' });

        new Setting(containerEl)
            .setName('Default Reminder')
            .setDesc('Default reminder time in minutes before the task (if no specific reminder is set)')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(this.plugin.settings.defaultReminder.toString())
                .onChange(async (value) => {
                    const reminder = parseInt(value);
                    if (!isNaN(reminder) && reminder >= 0) {
                        this.plugin.settings.defaultReminder = reminder;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Verbose Logging')
            .setDesc('Enable detailed debug logging (useful for troubleshooting)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.verboseLogging)
                .onChange(async (value) => {
                    this.plugin.settings.verboseLogging = value;
                    await this.plugin.saveSettings();
                }));

        // Mobile Settings Section
        containerEl.createEl('h3', { text: 'Mobile Optimizations' });

        new Setting(containerEl)
            .setName('Enable Mobile Optimizations')
            .setDesc('Apply mobile-specific optimizations for better performance on mobile devices')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.mobileOptimizations ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.mobileOptimizations = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Mobile Sync File Limit')
            .setDesc('Maximum number of files to scan for tasks on mobile devices (lower values improve performance)')
            .addText(text => text
                .setPlaceholder('100')
                .setValue((this.plugin.settings.mobileSyncLimit ?? 100).toString())
                .onChange(async (value) => {
                    const limit = parseInt(value);
                    if (!isNaN(limit) && limit > 0) {
                        this.plugin.settings.mobileSyncLimit = limit;
                        await this.plugin.saveSettings();
                    }
                }));

        // Custom OAuth Credentials Section
        containerEl.createEl('h3', { text: 'Custom OAuth Credentials (Advanced)' });

        const oauthDesc = containerEl.createEl('div', { cls: 'setting-item-description' });
        oauthDesc.style.marginBottom = '1em';
        oauthDesc.innerHTML = `
            <p>If you're seeing "This app is blocked" errors, you can use your own Google Cloud OAuth credentials:</p>
            <ol>
                <li>Go to <a href="https://console.cloud.google.com/">Google Cloud Console</a></li>
                <li>Create a new project (or select existing)</li>
                <li>Enable the Google Calendar API</li>
                <li>Go to "Credentials" → "Create Credentials" → "OAuth client ID"</li>
                <li>Choose "Desktop app" as the application type</li>
                <li>Copy the Client ID and Client Secret below</li>
                <li>Add <code>http://127.0.0.1:8085/callback</code> to Authorized redirect URIs</li>
            </ol>
            <p><strong>Note:</strong> After changing credentials, disconnect and reconnect your Google account.</p>
        `;

        new Setting(containerEl)
            .setName('Custom Client ID')
            .setDesc('Your Google OAuth Client ID (leave empty to use default)')
            .addText(text => text
                .setPlaceholder('xxxxxx.apps.googleusercontent.com')
                .setValue(this.plugin.settings.clientId || '')
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Custom Client Secret')
            .setDesc('Your Google OAuth Client Secret (leave empty to use default)')
            .addText(text => {
                text.setPlaceholder('GOCSPX-xxxxxx')
                    .setValue(this.plugin.settings.clientSecret || '')
                    .onChange(async (value) => {
                        this.plugin.settings.clientSecret = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
            });
    }
}
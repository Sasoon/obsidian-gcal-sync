import { Plugin, Notice, Menu, MenuItem, Editor, TFile, TAbstractFile, MarkdownView, Modal, App, Platform } from 'obsidian';
import { GoogleAuthManager } from '../calendar/googleAuth';
import { TaskParser } from '../tasks/taskParser';
import { CalendarSync } from '../calendar/calendarSync';
import { RepairManager } from '../repair/repairManager';
import { GoogleCalendarSettingsTab, DEFAULT_SETTINGS } from './settings';
import type { GoogleCalendarSettings, Task } from './types';
import { loadGoogleCredentials } from '../config/config';
import { useStore, store, type TaskStore } from './store';
import debounce from 'just-debounce-it';
import { MetadataManager } from '../metadata/metadataManager';
import { TokenController } from '../tasks/TokenController';
import { EditorView } from '@codemirror/view';
// Import dotenv for environment variables
import * as dotenv from 'dotenv';
// Removed UUID dependency for mobile compatibility
import { LogUtils } from '../utils/logUtils';
import { initializeStore } from './store';

// Welcome Modal for first-time users
class WelcomeModal extends Modal {
    plugin: GoogleCalendarSyncPlugin;

    constructor(app: App, plugin: GoogleCalendarSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;

        // Create welcome header
        contentEl.createEl('h2', { text: 'Welcome to Google Calendar Sync!' });
        contentEl.createEl('p', {
            text: 'This plugin synchronizes your Obsidian tasks with Google Calendar, helping you stay organized across platforms.'
        });

        // Create task formatting guide
        const taskGuide = contentEl.createDiv('task-guide');
        taskGuide.createEl('h3', { text: 'Task Formatting Guide' });
        taskGuide.createEl('p', { text: 'Your tasks need specific formatting to sync with Google Calendar:' });

        const exampleContainer = taskGuide.createDiv('example-container');
        exampleContainer.createEl('pre', { text: '- [ ] Meeting with team 📅 2023-11-15 ⏰ 10:00 🔔 15m' });

        // Create formatting explanation
        const formatList = taskGuide.createEl('ul');
        formatList.createEl('li', { text: '📅 Date (YYYY-MM-DD format)' });
        formatList.createEl('li', { text: '⏰ Start time (HH:MM format)' });
        formatList.createEl('li', { text: '➡️ End time - optional (HH:MM format)' });
        formatList.createEl('li', { text: '🔔 Reminder - optional (number + m/h/d for minutes/hours/days)' });

        // Create authentication section
        const authSection = contentEl.createDiv('auth-section');
        authSection.createEl('h3', { text: 'Connect with Google Calendar' });
        authSection.createEl('p', {
            text: 'To use this plugin, you\'ll need to connect to your Google Calendar account.'
        });

        // Sample task button
        const buttonDiv = contentEl.createDiv('button-container');

        // Sample task button
        const sampleButton = buttonDiv.createEl('button', {
            text: 'Insert Sample Task',
            cls: 'mod-cta'
        });
        sampleButton.addEventListener('click', () => {
            this.close();
            this.plugin.insertSampleTask();
        });

        // Auth button
        const authButton = buttonDiv.createEl('button', {
            text: 'Connect to Google Calendar',
            cls: 'mod-cta'
        });
        authButton.addEventListener('click', () => {
            this.close();
            if (this.plugin.authManager) {
                this.plugin.authManager.authorize();
            }
        });

        // Skip button
        const skipButton = buttonDiv.createEl('button', {
            text: 'Skip for now',
            cls: ''
        });
        skipButton.addEventListener('click', () => {
            this.close();
        });

        // Mark as completed
        this.plugin.settings.hasCompletedOnboarding = true;
        this.plugin.saveSettings();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export default class GoogleCalendarSyncPlugin extends Plugin {
    settings: GoogleCalendarSettings;
    public metadataManager: MetadataManager | null = null;
    public authManager: GoogleAuthManager | null = null;
    public calendarSync: CalendarSync | null = null;
    public repairManager: RepairManager | null = null;
    public taskParser: TaskParser;
    public tokenController: TokenController;
    private statusBarItem: HTMLElement | null = null;
    private ribbonIcon: HTMLElement | null = null;
    private unsubscribeStore: (() => void) | undefined = undefined;
    private lastContent: Record<string, string> = {};
    private cleanupInterval: number | null = null;

    // Flag to track mobile auth state in memory (not persisted)
    public mobileAuthInitiated: boolean = false;

    async onload() {
        try {
            console.log('Loading Google Calendar Sync plugin...');

            // Mobile-specific initialization and safety measures
            if (Platform.isMobile) {
                // Initialize global state registry for protocol handler safety
                (window as any).__GCAL_SYNC_STATE = {
                    disableProtocolHandlers: true, // Default: block all protocol handlers
                    debugInfo: {
                        version: this.manifest.version,
                        loadTime: Date.now(),
                        platform: 'Mobile'
                    }
                };

                // Override protocol handler registration with safety wrapper
                this.setupSafeProtocolHandling();

                // Perform startup cleanup to prevent unwanted redirects
                this.performMobileStartupCleanup();

                // Schedule staggered follow-up cleanups for extra safety
                this.scheduleFollowupCleanups();
            }

            // Reset mobile auth flag on startup
            this.mobileAuthInitiated = false;

            // Load settings first
            await this.loadSettings();
            const credentials = loadGoogleCredentials();
            this.settings.clientId = credentials.clientId;
            // We no longer store the client secret in the plugin settings
            // as it's now securely stored in the Netlify function

            // Always disable welcome modal
            this.settings.hasCompletedOnboarding = true;
            await this.saveSettings();

            // Initialize LogUtils
            LogUtils.initialize(this);

            // Initialize TaskParser first
            this.taskParser = new TaskParser(this);

            // Initialize auth manager and await token loading
            this.authManager = new GoogleAuthManager(this);

            // IMPORTANT: Log diagnostic info for debugging
            if (Platform.isMobile) {
                await this.authManager.logOAuthState('onload - after AuthManager init');
            }

            // Make sure any previous protocol handlers are cleaned up first
            await this.authManager.cleanup();
            await new Promise(resolve => setTimeout(resolve, 5000)); // Mobile auth cooldown

            try {
                await this.authManager.loadSavedTokens();
            } catch (e) {
                console.error('Failed to load saved tokens, clearing authentication state:', e);
                if (this.settings.oauth2Tokens) {
                    this.settings.oauth2Tokens = undefined;
                    await this.saveSettings();
                }
            }
            const isAuthenticated = this.authManager.isAuthenticated();

            // Initialize metadata manager
            this.metadataManager = new MetadataManager(this);

            // Initialize store with complete initial state
            useStore.setState({
                syncEnabled: this.settings.syncEnabled,
                authenticated: isAuthenticated,
                status: isAuthenticated ? 'connected' : 'disconnected',
                tempSyncEnableCount: 0,
                error: null,
                processingTasks: new Set(),
                taskVersions: new Map(),
                locks: new Set(),
                lockTimeouts: new Map(),
                lastSyncTime: null,
                syncInProgress: false,
                syncQueue: new Set(),
                failedSyncs: new Map(),
                plugin: this
            });

            // Initialize UI components
            this.initializeStatusBar();
            this.ribbonIcon = this.initializeRibbonIcon();

            // Initialize TokenController
            this.tokenController = new TokenController(this);
            const extension = this.tokenController.getExtension();
            this.registerEditorExtension([extension]);

            // Initialize UI state
            this.updateRibbonStatus(useStore.getState().status);

            // Subscribe to store changes
            this.unsubscribeStore = useStore.subscribe((state) => {
                this.updateRibbonStatus(state.status);
                this.updateStatusBar();
            });

            // Initialize calendar sync if authenticated
            if (isAuthenticated) {
                await this.initializeCalendarSync();
            }

            // Register event handlers
            this.registerEventHandlers();

            // Register file deletion and rename handlers
            this.registerEvent(
                this.app.vault.on('delete', (file: TAbstractFile) => {
                    if (file instanceof TFile && file.path in this.lastContent) {
                        delete this.lastContent[file.path];
                    }
                })
            );

            this.registerEvent(
                this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
                    if (file instanceof TFile) {
                        if (oldPath in this.lastContent) {
                            // Move the content to the new path
                            this.lastContent[file.path] = this.lastContent[oldPath];
                            delete this.lastContent[oldPath];
                        }
                    }
                })
            );

            // Start periodic cleanup
            this.startPeriodicCleanup();

            // Register file change monitoring
            this.registerEvent(
                this.app.vault.on('modify', async (file: TAbstractFile) => {
                    if (file instanceof TFile && this.isTaskFile(file)) {
                        const state = useStore.getState();

                        // First invalidate the cache
                        state.invalidateFileCache(file.path);

                        // Wait a small amount of time for the file system to settle
                        await new Promise(resolve => setTimeout(resolve, 50));

                        try {
                            try {
                                // Force a fresh read of the file content
                                const content = await state.getFileContent(file.path);

                                // Get the previous content from our cache
                                const previousContent = this.lastContent[file.path] || "";

                                // Update the cache with current content
                                this.lastContent[file.path] = content;

                                // If this is the first time we're seeing this file, don't process it
                                if (!previousContent) return;

                                // Find lines that were modified
                                const currentLines = content.split('\n');
                                const previousLines = previousContent.split('\n');

                                // Find modified task lines
                                const modifiedTaskLines: string[] = [];

                                // Compare line by line to find changes
                                const maxLines = Math.max(currentLines.length, previousLines.length);
                                for (let i = 0; i < maxLines; i++) {
                                    const currentLine = currentLines[i] || "";
                                    const previousLine = previousLines[i] || "";

                                    // If the line changed and is a task line, add it to our list
                                    if (currentLine !== previousLine && this.taskParser.isTaskLine(currentLine)) {
                                        modifiedTaskLines.push(currentLine);
                                    }
                                }

                                if (modifiedTaskLines.length === 0) return;

                                // Parse tasks from modified task lines only
                                const tasks = [];
                                for (const line of modifiedTaskLines) {
                                    const task = await this.taskParser.parseTask(line, file.path);
                                    if (task && task.id) {
                                        tasks.push(task);
                                    }
                                }

                                if (tasks.length > 0) {
                                    await state.enqueueTasks(tasks);
                                }
                            } catch (fileError) {
                                // Safely handle file reading errors
                                LogUtils.error(`Failed to read file ${file.path}:`, fileError);
                                new Notice(`Failed to read file: ${file.path}`);
                            }
                        } catch (error) {
                            LogUtils.error(`Failed to process file changes for ${file.path}:`, error);
                        }
                    }
                })
            );

            // Initialize store with plugin instance
            initializeStore(this);

            // Never show welcome modal on startup
            // if (!this.settings.hasCompletedOnboarding) {
            //     this.showWelcomeModal();
            // }

            LogUtils.debug('Plugin loaded successfully');
        } catch (error) {
            LogUtils.error('Failed to load plugin:', error);
            useStore.getState().setStatus('error', error as Error);
        }
    }

    /**
     * Sets up safe protocol handler registration for mobile
     * Prevents unauthorized protocol handler registration
     */
    private setupSafeProtocolHandling(): void {
        const originalRegisterMethod = this.registerObsidianProtocolHandler;
        this.registerObsidianProtocolHandler = function (protocol: string, handler: (params: any) => any): void {
            console.log(`🔒 Protocol handler registration attempt: ${protocol}`);

            // Only allow registration during explicit auth flow
            if ((window as any).__GCAL_SYNC_STATE?.disableProtocolHandlers || !this.mobileAuthInitiated) {
                console.log(`🛑 BLOCKED: Protocol handler for ${protocol}`);

                // Store handler for potential later use
                (window as any).__GCAL_SYNC_STATE.pendingHandler = {
                    protocol,
                    handler,
                    timestamp: Date.now()
                };
                return;
            }

            // Legitimate auth flow, proceed with registration
            console.log(`✅ ALLOWED: Protocol handler for ${protocol}`);
            originalRegisterMethod.call(this, protocol, handler);
        }.bind(this);
    }

    /**
     * Performs critical startup cleanup for mobile
     * Prevents unwanted redirects on app startup
     */
    private performMobileStartupCleanup(): void {
        // Check if current URL is a legitimate auth callback
        const currentUrl = window.location.href;
        const isAuthCallback = currentUrl.includes('gcalsync') && currentUrl.includes('code=');

        if (!isAuthCallback) {
            // Force unregister any existing protocol handler
            try {
                this.app.unregisterProtocolHandler?.('auth/gcalsync');
                console.log('🔥 Unregistered protocol handler on startup');
            } catch (e) {
                console.log('Protocol handler cleanup error:', e);
            }

            // Clear all auth-related localStorage items
            const keysToRemove = [
                'gcal_auth_interrupted',
                'gcal_auth_url',
                'gcal_auth_in_progress',
                'gcal_pending_auth',
                'gcal_redirect_url',
                'gcal_handler_registered',
                'gcal_auth_state',
                'gcal_auth_code_verifier'
            ];

            keysToRemove.forEach(key => localStorage.removeItem(key));

            // Set version info for debugging
            localStorage.setItem('gcal_plugin_version', this.manifest.version);
            localStorage.setItem('gcal_safe_start_time', Date.now().toString());
            localStorage.setItem('gcal_plugin_version_antiloop', '1.1.0');

            console.log('🔥 Cleared auth state on startup');
        } else {
            console.log('✅ Auth callback detected, preserving state');
            localStorage.setItem('gcal_plugin_version', this.manifest.version);
        }
    }

    /**
     * Schedules staggered follow-up cleanups for extra safety
     */
    private scheduleFollowupCleanups(): void {
        // Schedule multiple cleanups at staggered intervals
        [50, 150, 250].forEach(delay => {
            setTimeout(() => {
                try {
                    this.app.unregisterProtocolHandler?.('auth/gcalsync');
                    console.log(`Follow-up cleanup at ${delay}ms`);
                } catch (e) {
                    // Silently ignore errors in scheduled cleanup
                }
            }, delay);
        });
    }

    public showWelcomeModal() {
        new WelcomeModal(this.app, this).open();
    }

    public async insertSampleTask() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            new Notice('Open a markdown file first to insert a sample task');
            return;
        }

        const cursor = activeView.editor.getCursor();
        const today = new Date().toISOString().split('T')[0];
        const sampleTask = `- [ ] Sample task synchronized with Google Calendar 📅 ${today} ⏰ 15:00 🔔 30m`;

        activeView.editor.replaceRange(sampleTask + '\n', cursor);
        new Notice('Sample task created!');
    }

    private registerEventHandlers() {
        // Register file change events with shorter debounce
        this.registerEvent(
            this.app.vault.on('modify',
                debounce(async (file: TFile) => {
                    if (!useStore.getState().isSyncAllowed()) return;
                    if (!file.path.endsWith('.md')) return;

                    try {
                        // Get the file content
                        const state = useStore.getState();
                        state.invalidateFileCache(file.path);
                        const content = await state.getFileContent(file.path);

                        // Get the previous content from our cache
                        const previousContent = this.lastContent[file.path] || "";

                        // Update the cache with current content
                        this.lastContent[file.path] = content;

                        // If this is the first time we're seeing this file, don't process it
                        if (!previousContent) return;

                        // Find lines that were modified
                        const currentLines = content.split('\n');
                        const previousLines = previousContent.split('\n');

                        // Find modified task lines
                        const modifiedTaskLines: string[] = [];

                        // Compare line by line to find changes
                        const maxLines = Math.max(currentLines.length, previousLines.length);
                        for (let i = 0; i < maxLines; i++) {
                            const currentLine = currentLines[i] || "";
                            const previousLine = previousLines[i] || "";

                            // If the line changed and is a task line, add it to our list
                            if (currentLine !== previousLine && this.taskParser.isTaskLine(currentLine)) {
                                modifiedTaskLines.push(currentLine);
                            }
                        }

                        if (modifiedTaskLines.length === 0) return;

                        // Parse tasks from modified task lines only
                        const tasks = [];
                        for (const line of modifiedTaskLines) {
                            const task = await this.taskParser.parseTask(line, file.path);
                            if (task && task.id) {
                                tasks.push(task);
                            }
                        }

                        if (tasks.length === 0) return;

                        // Batch process tasks
                        const taskBatch = tasks.map(task => ({
                            id: task.id,
                            task,
                            queued: false
                        }));

                        // First pass: Queue non-locked tasks
                        for (const item of taskBatch) {
                            if (!state.isTaskLocked(item.id)) {
                                await state.enqueueTasks([item.task]);
                                item.queued = true;
                            }
                        }

                        // Second pass: Try to queue locked tasks after a short delay
                        setTimeout(async () => {
                            const currentState = useStore.getState();
                            const unqueuedTasks = taskBatch
                                .filter(item => !item.queued && !currentState.isTaskLocked(item.id))
                                .map(item => item.task);

                            if (unqueuedTasks.length > 0) {
                                await currentState.enqueueTasks(unqueuedTasks);
                            }
                        }, 1000); // Try again after 1 second for locked tasks
                    } catch (error) {
                        LogUtils.error(`Failed to process file changes for ${file.path}:`, error);
                    }
                }, 1000) // Reduced to 1 second for more responsive sync
            )
        );

        // Register settings tab
        this.addSettingTab(new GoogleCalendarSettingsTab(this.app, this));

        // Register file menu events
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
                if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;

                menu.addItem((item) => {
                    item
                        .setTitle('Sync Tasks with Google Calendar')
                        .setIcon('calendar-clock')
                        .onClick(async () => {
                            const state = useStore.getState();
                            try {
                                state.enableTempSync();
                                state.startSync();
                                const tasks = await this.taskParser.parseTasksFromFile(file);
                                await state.enqueueTasks(tasks.filter(t => t?.id));
                                await state.processSyncQueueNow();
                                state.endSync(true);
                                new Notice('Tasks synced with Google Calendar');
                            } catch (error) {
                                LogUtils.error(`Failed to sync tasks from ${file.path}:`, error);
                                state.endSync(false);
                                new Notice('Failed to sync tasks with Google Calendar');
                            } finally {
                                state.disableTempSync();
                            }
                        });
                });
            })
        );

        // Register editor change events for auto-sync with improved batching
        this.registerEvent(
            this.app.workspace.on('editor-change',
                debounce(async (editor: Editor) => {
                    if (!useStore.getState().isSyncAllowed()) return;

                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view || !view.file) return;

                    // Check if the cursor is on a task line
                    const cursorPos = editor.getCursor();
                    const currentLine = editor.getLine(cursorPos.line);

                    // Only proceed if the current line is a task line
                    if (!this.taskParser.isTaskLine(currentLine)) {
                        return;
                    }

                    const state = useStore.getState();
                    if (state.syncInProgress) {
                        LogUtils.debug('Sync in progress, will retry after current sync');
                        setTimeout(() => {
                            if (view.file) {
                                this.processEditorChanges(view.file);
                            }
                        }, 500); // Reduced retry time to 500ms
                        return;
                    }

                    if (view.file) {
                        await this.processEditorChanges(view.file);
                    }
                }, 500) // Reduced to 500ms for more responsive sync
            )
        );
    }

    private async processEditorChanges(file: TFile) {
        const state = useStore.getState();
        try {
            // First check if we can read the file
            try {
                // Force fresh content read
                await state.invalidateFileCache(file.path);
                await state.getFileContent(file.path);
            } catch (fileError) {
                LogUtils.error(`Failed to read file ${file.path} during editor changes:`, fileError);
                return; // Exit early if we can't read the file
            }

            // Get the current cursor position and line
            const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
            if (!editor) return;

            const cursorPos = editor.getCursor();
            const currentLine = editor.getLine(cursorPos.line);

            // Only process the task at the current line
            if (this.taskParser.isTaskLine(currentLine)) {
                const task = await this.taskParser.parseTask(currentLine, file.path);

                if (task && task.id) {
                    const taskBatch = [{
                        id: task.id,
                        task,
                        queued: false
                    }];

                    // Process non-locked task immediately
                    if (!state.isTaskLocked(task.id)) {
                        await state.enqueueTasks([task]);
                        taskBatch[0].queued = true;
                    }

                    // Retry locked task
                    const retryLockedTasks = async () => {
                        const currentState = useStore.getState();
                        const unqueuedTasks = taskBatch
                            .filter(item => !item.queued && !currentState.isTaskLocked(item.id))
                            .map(item => {
                                item.queued = true;
                                return item.task;
                            });

                        if (unqueuedTasks.length > 0) {
                            await currentState.enqueueTasks(unqueuedTasks);
                            return taskBatch.some(item => !item.queued);
                        }
                        return false;
                    };

                    // Retry a few times with exponential backoff
                    let retryCount = 0;
                    const maxRetries = 3;
                    const retryWithBackoff = async () => {
                        if (await retryLockedTasks()) {
                            retryCount++;
                            if (retryCount < maxRetries) {
                                setTimeout(retryWithBackoff, 500 * Math.pow(2, retryCount));
                            }
                        }
                    };

                    retryWithBackoff();
                }
            }
        } catch (error) {
            LogUtils.error(`Failed to process editor changes for ${file.path}:`, error);
        }
    }

    public async handleTaskDeletion(taskId: string, eventId: string | undefined) {
        const { isTaskLocked, isSyncEnabled, addProcessingTask, removeProcessingTask } = useStore.getState();

        if (isTaskLocked(taskId)) {
            LogUtils.debug(`Task ${taskId} is locked, skipping deletion`);
            return;
        }

        // Skip deletion handling if sync is disabled
        if (!isSyncEnabled()) {
            LogUtils.debug(`🔒 Sync is disabled, skipping deletion handling for ${taskId}`);
            return;
        }

        try {
            addProcessingTask(taskId);
            if (eventId) {
                console.log('Deleting calendar event:', eventId);
                await this.calendarSync?.deleteEvent(eventId);
                console.log('Successfully deleted event:', eventId);
            }
            await this.metadataManager?.removeTaskMetadata(taskId);
            console.log('Cleaned up task metadata');
        } finally {
            removeProcessingTask(taskId);
        }
    }

    public async initializeCalendarSync() {
        if (!this.authManager) return;

        try {
            this.calendarSync = new CalendarSync(this);
            await this.calendarSync.initialize();

            // Initialize repair manager if needed
            if (!this.repairManager) {
                this.repairManager = new RepairManager(this);
            }

            // Skip initial cleanup on load - only do this during manual repair
            LogUtils.debug('Skipping initial cleanup during load');
            useStore.getState().setStatus('connected');
        } catch (error) {
            LogUtils.error('Failed to initialize calendar sync:', error);
            useStore.getState().setStatus('error', error as Error);
        }
    }

    private async ensureMetadataConsistency() {
        const { setStatus } = useStore.getState();

        try {
            // Get all tasks
            const tasks = await this.getAllTasks();
            const taskIdMap = new Map(tasks.map(t => [t.id, t]));

            // Get all metadata entries
            const metadataEntries = Object.entries(this.settings.taskMetadata);

            // Identify orphaned metadata (no matching task)
            const orphanedMetadata = metadataEntries.filter(([id]) => !taskIdMap.has(id));

            // Remove orphaned metadata
            for (const [id] of orphanedMetadata) {
                const metadata = this.settings.taskMetadata[id];

                // Delete associated calendar event if it exists
                if (metadata?.eventId && this.calendarSync) {
                    try {
                        await this.calendarSync.deleteEvent(metadata.eventId);
                    } catch (e) {
                        LogUtils.error(`Failed to delete event for orphaned metadata ${id}:`, e);
                    }
                }

                delete this.settings.taskMetadata[id];
                delete this.settings.taskIds[id];
            }

            // Verify remaining tasks have valid metadata
            for (const task of tasks) {
                if (!task.id) continue;

                const metadata = this.settings.taskMetadata[task.id];
                if (!metadata) continue;

                // Check basic consistency
                if (metadata.title !== task.title ||
                    metadata.date !== task.date ||
                    metadata.time !== task.time ||
                    metadata.completed !== task.completed) {

                    // Requeue task for sync to correct inconsistency
                    useStore.getState().addToSyncQueue(task.id);
                }
            }

            await this.saveSettings();
            setStatus('connected');
            LogUtils.debug(`Metadata consistency check completed: removed ${orphanedMetadata.length} orphaned entries`);
        } catch (error) {
            LogUtils.error('Metadata consistency check failed:', error);
            setStatus('error', error as Error);
            new Notice('Failed to verify task states');
        }
    }

    private startPeriodicCleanup() {
        // Run cleanup every 5 minutes
        this.cleanupInterval = window.setInterval(() => {
            useStore.getState().clearStaleProcessingTasks();

            // Clean up lastContent cache for files that haven't been accessed in a while
            // Get all markdown files in the vault
            const allFiles = new Set(this.app.vault.getMarkdownFiles().map(file => file.path));

            // Remove entries for files that no longer exist
            Object.keys(this.lastContent).forEach(path => {
                if (!allFiles.has(path)) {
                    delete this.lastContent[path];
                }
            });
        }, 5 * 60 * 1000);
    }

    private async cleanupOrphanedMetadata() {
        const state = useStore.getState();
        if (!state.isSyncEnabled()) return;

        try {
            const tasks = await this.getAllTasks();
            const allTaskIds = new Set(tasks.map(t => t.id));
            const orphanedIds = Object.keys(this.settings.taskMetadata)
                .filter(id => !allTaskIds.has(id));

            for (const id of orphanedIds) {
                if (state.isTaskLocked(id)) {
                    LogUtils.debug('Orphaned task is locked, skipping cleanup:', id);
                    continue;
                }

                try {
                    state.addProcessingTask(id);
                    const metadata = this.settings.taskMetadata[id];
                    if (metadata?.eventId) {
                        await this.calendarSync?.deleteEvent(metadata.eventId);
                    }
                    delete this.settings.taskMetadata[id];
                    delete this.settings.taskIds[id];
                } finally {
                    state.removeProcessingTask(id);
                }
            }

            await this.saveSettings();
        } catch (error) {
            LogUtils.error('Failed to cleanup orphaned metadata:', error);
        }
    }

    private async getAllTasks(): Promise<Task[]> {
        const tasks: Task[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            if (this.settings.includeFolders.length > 0 &&
                !this.settings.includeFolders.some(folder => file.path.startsWith(folder))) {
                continue;
            }
            try {
                const fileTasks = await this.taskParser.parseTasksFromFile(file);
                tasks.push(...fileTasks);
            } catch (error) {
                LogUtils.error(`Failed to parse tasks from ${file.path}:`, error);
            }
        }
        return tasks;
    }

    async onunload() {
        try {
            console.log('🔄 Unloading Google Calendar Sync plugin...');

            // Clean up any pending sync operations
            useStore.getState().clearSyncQueue();

            // Clean up metadata
            if (this.metadataManager) {
                await this.metadataManager.cleanup();
            }

            // Clean up UI elements
            if (this.statusBarItem) {
                this.statusBarItem.remove();
            }

            if (this.ribbonIcon) {
                this.ribbonIcon.remove();
                this.ribbonIcon = null;
            }

            // Clean up store subscription
            if (this.unsubscribeStore) {
                this.unsubscribeStore();
            }

            // Clean up auth and sync components
            if (this.authManager) {
                await this.authManager.cleanup();
            }

            // Explicitly unregister protocol handlers when unloading - critical on mobile
            try {
                if (Platform.isMobile) {
                    // Thorough protocol handler cleanup on unload
                    try {
                        this.app.unregisterProtocolHandler?.('auth/gcalsync');
                        console.log('Explicitly unregistered auth/gcalsync handler on plugin unload');
                    } catch (e) {
                        console.log('Error unregistering protocol handler:', e);
                    }

                    // Clean up after a short delay to ensure it completes even during plugin unload
                    setTimeout(() => {
                        try {
                            this.app.unregisterProtocolHandler?.('auth/gcalsync');
                            console.log('Second cleanup of auth/gcalsync handler on unload');
                        } catch (e) {
                            // Silent error - just a backup attempt
                        }
                    }, 50);

                    // Clear all auth state from localStorage to prevent redirects on next app open
                    localStorage.removeItem('gcal_auth_interrupted');
                    localStorage.removeItem('gcal_auth_url');
                    localStorage.removeItem('gcal_auth_in_progress');
                    localStorage.removeItem('gcal_auth_flow_id');
                    localStorage.removeItem('gcal_auth_flow_started_at');
                    localStorage.removeItem('gcal_auth_started_intentionally');
                    localStorage.removeItem('gcal_auth_flow_last_active');
                    localStorage.removeItem('gcal_handler_registered');
                    localStorage.removeItem('gcal_auth_state');
                    localStorage.removeItem('gcal_auth_code_verifier');

                    // Don't remove version marker - keep it for debugging
                    // But update a flag to know we did a clean shutdown
                    localStorage.setItem('gcal_clean_shutdown', Date.now().toString());

                    console.log('Cleared all auth-related localStorage items on unload');

                    // Set a SPECIAL flag that will be checked on next startup to prevent any immediate auth
                    localStorage.setItem('gcal_prevent_next_startup_auth', 'true');

                    // Final desperate attempt to prevent any redirects on next app open
                    (window as any).__GCAL_DISABLE_PROTOCOL_HANDLERS = true;
                }
            } catch (e) {
                console.log('Error during protocol handler cleanup:', e);
            }

            // Clear the lastContent cache
            this.lastContent = {};

            // Clear references
            this.calendarSync = null;
            this.authManager = null;
            this.metadataManager = null;
            this.statusBarItem = null;

            // Reset store state last
            useStore.getState().reset();

            console.log('Plugin cleanup completed');
        } catch (error) {
            console.error('❌ Error during plugin cleanup:', error);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    private initializeRibbonIcon() {
        // Create the main ribbon icon
        this.ribbonIcon = this.addRibbonIcon('calendar-clock', `Google Calendar Sync v${this.manifest.version}`, (e: MouseEvent) => {
            if (!this.authManager?.isAuthenticated()) {
                this.authManager?.authorize();
            } else {
                this.showSyncMenu(e);
            }
        });

        // Also add a version indicator for debugging mobile issues
        if (Platform.isMobile) {
            this.addRibbonIcon('info', `GCal Version: ${this.manifest.version}`, () => {
                new Notice(`Plugin version: ${this.manifest.version}\nRuntime: ${Platform.isDesktop ? 'Desktop' : 'Mobile'}`);
            });

            // Add debugging button for OAuth flow issues
            this.addRibbonIcon('bug', 'Debug OAuth', async () => {
                const debugInfo = this.authManager?.dumpOAuthDebugInfo() || 'Auth manager not initialized';

                // Create a more detailed debug message
                const debugDetails = {
                    pluginVersion: this.manifest.version,
                    platform: Platform.isDesktop ? 'Desktop' : 'Mobile',
                    authenticated: this.authManager?.isAuthenticated() || false,
                    protocolHandlerInterception: !!(window as any).__GCAL_SYNC_STATE,
                    protocolHandlersDisabled: (window as any).__GCAL_SYNC_STATE?.disableProtocolHandlers || false,
                    pendingHandler: !!(window as any).__GCAL_SYNC_STATE?.pendingHandler,
                    mobileAuthInitiated: this.mobileAuthInitiated
                };

                new Notice('Debug info copied to clipboard. Check console for details.');
                console.log('🐞 OAuth Debug Information:');
                console.log(JSON.stringify(debugDetails, null, 2));
                console.log('Full OAuth State:');
                console.log(debugInfo);

                // Add a copy to clipboard option
                await navigator.clipboard.writeText(JSON.stringify({
                    debugDetails,
                    fullState: JSON.parse(debugInfo)
                }, null, 2)).catch(() => {
                    console.log('Could not copy to clipboard');
                });

                // Force reset the protocol handlers if there are issues
                if (Platform.isMobile) {
                    const resetHandlers = window.confirm('Reset protocol handlers? This can help fix redirect issues.');
                    if (resetHandlers) {
                        // Total reset of protocol handler state
                        if ((window as any).__GCAL_SYNC_STATE) {
                            (window as any).__GCAL_SYNC_STATE.disableProtocolHandlers = true;
                            (window as any).__GCAL_SYNC_STATE.pendingHandler = null;
                        }

                        try {
                            this.app.unregisterProtocolHandler?.('auth/gcalsync');
                            localStorage.removeItem('gcal_auth_interrupted');
                            localStorage.removeItem('gcal_auth_url');
                            localStorage.removeItem('gcal_auth_in_progress');
                            localStorage.removeItem('gcal_auth_flow_id');
                            localStorage.removeItem('gcal_auth_flow_started_at');
                            localStorage.removeItem('gcal_auth_started_intentionally');
                            localStorage.removeItem('gcal_auth_explicit_start_timestamp');

                            new Notice('Protocol handlers reset. Try restarting Obsidian.');
                        } catch (e) {
                            console.error('Error resetting protocol handlers:', e);
                            new Notice('Error resetting protocol handlers. See console for details.');
                        }
                    }
                }
            });
        }

        return this.ribbonIcon;
    }

    private updateRibbonStatus(status: TaskStore['status']): void {
        if (!this.ribbonIcon) return;

        // Remove existing classes
        this.ribbonIcon.removeClass('is-connected', 'is-syncing', 'is-error', 'is-disconnected');

        // Add new class and tooltip
        switch (status) {
            case 'connected':
                this.ribbonIcon.addClass('is-connected');
                this.ribbonIcon.setAttribute('aria-label', 'Connected to Google Calendar');
                break;
            case 'syncing':
                this.ribbonIcon.addClass('is-syncing');
                this.ribbonIcon.setAttribute('aria-label', 'Syncing with Google Calendar...');
                break;
            case 'error':
                this.ribbonIcon.addClass('is-error');
                this.ribbonIcon.setAttribute('aria-label', 'Google Calendar Sync Error');
                break;
            case 'disconnected':
            default:
                this.ribbonIcon.addClass('is-disconnected');
                this.ribbonIcon.setAttribute('aria-label', 'Connect to Google Calendar (click to connect)');
        }
    }

    public updateStatusBar() {
        if (!this.statusBarItem) return;

        const state = useStore.getState();
        let text = '';
        let tooltip = '';

        switch (state.status) {
            case 'connected':
                if (state.syncInProgress) {
                    text = '🔄 GCal: Syncing...';
                    tooltip = `Syncing tasks with Google Calendar (${state.syncQueue.size} remaining)`;
                } else {
                    text = state.syncEnabled ? '🟢 GCal: Auto-sync On' : '🟡 GCal: Ready';
                    tooltip = state.syncEnabled ? 'Auto-sync is enabled' : 'Auto-sync is paused';
                    if (state.lastSyncTime) {
                        tooltip += ` (Last sync: ${new Date(state.lastSyncTime).toLocaleTimeString()})`;
                    }
                }
                break;
            case 'syncing':
                text = '🔄 GCal: Syncing...';
                tooltip = `Syncing tasks with Google Calendar (${state.syncQueue.size} remaining)`;
                break;
            case 'disconnected':
                text = '⚪ GCal: Disconnected';
                tooltip = 'Click to connect to Google Calendar';
                break;
            case 'error':
                text = '🔴 GCal: Error';
                tooltip = state.error?.message || 'An error occurred';
                if (state.failedSyncs.size > 0) {
                    tooltip += ` (${state.failedSyncs.size} failed tasks)`;
                }
                break;
            case 'refreshing_token':
                text = '🔄 GCal: Refreshing...';
                tooltip = 'Refreshing authentication token';
                break;
        }

        this.statusBarItem.setText(text);
        this.statusBarItem.setAttr('aria-label', tooltip);
        this.statusBarItem.setAttr('aria-label-position', 'top');
    }

    private initializeStatusBar() {
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('gcal-sync-status');
        this.statusBarItem.onClickEvent((event: MouseEvent) => {
            if (!this.authManager?.isAuthenticated()) {
                this.authManager?.authorize();
            } else {
                this.showSyncMenu(event);
            }
        });
        this.updateStatusBar();
    }

    private showSyncMenu(event: MouseEvent) {
        const menu = new Menu();

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("Sync Now")
                .setIcon("sync")
                .onClick(() => this.syncAllTasks());
        });

        menu.addItem((item: MenuItem) => {
            const syncEnabled = useStore.getState().syncEnabled;
            item
                .setTitle(syncEnabled ? "Disable Auto-sync" : "Enable Auto-sync")
                .setIcon(syncEnabled ? "toggle-left" : "toggle-right")
                .onClick(async () => {
                    const newState = !syncEnabled;
                    useStore.getState().setSyncEnabled(newState);
                    // Update plugin settings
                    this.settings.syncEnabled = newState;
                    await this.saveSettings();
                    this.updateStatusBar();
                    new Notice(`Auto-sync ${newState ? 'enabled' : 'disabled'}`);
                });
        });

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("Repair Calendar Sync")
                .setIcon("tool")
                .onClick(async () => {
                    if (!this.repairManager) {
                        new Notice('Repair manager not initialized');
                        return;
                    }
                    try {
                        new Notice('Starting repair process...');
                        await this.repairManager.repairSyncState(
                            (progress) => console.log(`Repair progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`)
                        );
                        new Notice('Repair completed successfully');
                    } catch (error) {
                        console.error('Repair failed:', error);
                        new Notice('Repair failed. Check console for details.');
                    }
                });
        });

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("Disconnect Google Calendar")
                .setIcon("log-out")
                .onClick(() => this.disconnectGoogle());
        });

        // Show menu at the click position
        menu.showAtPosition({
            x: event.x,
            y: event.y
        });
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private async syncAllTasks() {
        const state = useStore.getState();
        if (state.syncInProgress) {
            console.log('🔄 Sync already in progress');
            return;
        }

        try {
            state.startSync();
            state.enableTempSync();

            // Get all tasks
            const tasks = await this.taskParser?.getAllTasks() || [];
            console.log(`Found ${tasks.length} tasks to sync`);

            // Get all Obsidian events from calendar
            const allTaskIds = new Set(tasks.map(t => t.id));
            const calendarEvents = await this.calendarSync?.findAllObsidianEvents() || [];
            console.log(`Found ${calendarEvents.length} Obsidian events in calendar`);

            // Clean up orphaned events and metadata
            if (this.repairManager) {
                await this.repairManager.deleteOrphanedEvents(
                    calendarEvents,
                    allTaskIds,
                    (progress) => console.log(`Cleanup progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`)
                );
                await this.repairManager.cleanupOrphanedMetadata(
                    allTaskIds,
                    (progress) => console.log(`Cleanup progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`)
                );
            }

            // Enqueue all tasks and process immediately
            await state.enqueueTasks(tasks);
            await state.processSyncQueueNow();

            await this.saveSettings();
            state.endSync(true);
            new Notice('Tasks synced with Google Calendar');
            console.log('✅ Full sync completed');
        } catch (error) {
            console.error('❌ Sync failed:', error);
            state.endSync(false);
            state.setStatus('error', error as Error);
            new Notice('Sync failed. Please try again.');
        } finally {
            state.disableTempSync();
        }
    }

    private async disconnectGoogle() {
        try {
            if (this.authManager?.isAuthenticated()) {
                await this.authManager.revokeAccess();
            }

            // Clear tokens in settings
            if (this.settings.oauth2Tokens) {
                this.settings.oauth2Tokens = undefined;
                await this.saveSettings();
            }

            this.calendarSync = null;
            const { setStatus, setAuthenticated } = useStore.getState();
            setStatus('disconnected');
            setAuthenticated(false);
            new Notice('Disconnected from Google Calendar');

            // Show option to reconnect
            const reconnect = window.confirm('Do you want to reconnect to Google Calendar?');
            if (reconnect && this.authManager) {
                this.authManager.authorize();
            }
        } catch (error) {
            useStore.getState().setStatus('error', error as Error);
            new Notice('Failed to disconnect from Google Calendar');
        }
    }

    private isTaskFile(file: TAbstractFile): boolean {
        if (!(file instanceof TFile) || !file.extension.toLowerCase().endsWith('md')) {
            return false;
        }

        // Check if file is in included folders
        if (this.settings.includeFolders.length > 0) {
            return this.settings.includeFolders.some(folder => file.path.startsWith(folder));
        }

        return true;
    }

    /**
     * Checks if the current token is valid or renews it if needed.
     * @returns true if the token is valid or was successfully renewed
     */
    public async verifyAuthentication(): Promise<boolean> {
        try {
            if (!this.authManager) {
                LogUtils.error('Auth manager not initialized');
                return false;
            }

            // Check if we're authenticated
            if (!this.authManager.isAuthenticated()) {
                LogUtils.debug('Not authenticated, redirecting to auth flow');
                const reconnect = window.confirm('Google Calendar Sync requires authentication. Connect now?');
                if (reconnect) {
                    await this.authManager.authorize();
                } else {
                    LogUtils.info('User declined to authenticate');
                }
                return false;
            }

            // Check token validity
            try {
                // Try to get a valid token, which will refresh if needed
                await this.authManager.getValidAccessToken();
            } catch (error) {
                LogUtils.error('Failed to refresh token', error);
                // Clear bad tokens
                if (this.settings.oauth2Tokens) {
                    this.settings.oauth2Tokens = undefined;
                    await this.saveSettings();
                }
                useStore.getState().setStatus('disconnected');

                // Prompt to re-authenticate
                const reconnect = window.confirm('Your Google authentication has expired. Reconnect now?');
                if (reconnect) {
                    await this.authManager.authorize();
                }
                return false;
            }

            return true;
        } catch (error) {
            LogUtils.error('Error verifying authentication:', error);
            useStore.getState().setStatus('error', error as Error);
            return false;
        }
    }
}    
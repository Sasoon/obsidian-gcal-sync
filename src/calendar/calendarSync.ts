import { requestUrl, Notice } from 'obsidian';
import type { Task, TaskMetadata, ApiError } from '../core/types';
import type GoogleCalendarSyncPlugin from '../core/main';
import type { GoogleCalendarEvent } from '../repair/types';
import { LogUtils } from '../utils/logUtils';
import { ErrorUtils } from '../utils/errorUtils';
import { TimeUtils } from '../utils/timeUtils';
import { retryWithBackoff } from '../utils/retryUtils';
import { hasTaskChanged } from '../utils/taskUtils';
import { useStore } from '../core/store';
import { TIMING } from '../config/constants';
import { RepairManager } from '../repair/repairManager';
import { Platform } from 'obsidian';

interface GoogleCalendarEventInput {
    summary: string;
    start: { date?: string; dateTime?: string };
    end: { date?: string; dateTime?: string };
    extendedProperties: {
        private: {
            obsidianTaskId: string;
            isObsidianTask: 'true';
            version?: string;
        };
    };
    reminders: {
        useDefault: false;
        overrides: Array<{
            method: 'popup';
            minutes: number;
        }>;
    };
}

interface RateLimitState {
    lastRequest: number;
    requestCount: number;
    resetTime: number;
    backoffMultiplier?: number;
}

export class CalendarSync {
    private readonly BASE_URL = 'https://www.googleapis.com/calendar/v3';
    private readonly DEFAULT_RATE_LIMIT = { requests: 400, window: 60 * 1000 }; // 400 requests per minute
    private rateLimit: RateLimitState = {
        lastRequest: 0,
        requestCount: 0,
        resetTime: 0,
        backoffMultiplier: 1.0
    };
    private readonly plugin: GoogleCalendarSyncPlugin;
    private processingQueue = new Set<string>();
    private processingPromises = new Map<string, Promise<any>>();

    // Cache to store events during a sync session
    private eventsCache: {
        events: GoogleCalendarEvent[] | null;
        timestamp: number;
        syncId: string;
    } = {
            events: null,
            timestamp: 0,
            syncId: ''
        };

    constructor(plugin: GoogleCalendarSyncPlugin) {
        this.plugin = plugin;
    }

    /**
     * Clears the events cache to force fresh data on next request
     */
    private clearEventsCache(): void {
        this.eventsCache = {
            events: null,
            timestamp: 0,
            syncId: ''
        };
    }

    public async initialize(): Promise<void> {
        try {
            // Verify calendar access by making a test request
            await this.makeRequest('/calendars/primary/events', 'GET', { maxResults: 1 });

            // Initialize repair manager if needed
            if (!this.plugin.repairManager) {
                this.plugin.repairManager = new RepairManager(this.plugin);
            }

            // Only verify metadata consistency - no cleanup needed during initialization
            await this.plugin.metadataManager?.verifyMetadataConsistency();

            LogUtils.debug('Calendar sync initialized successfully');
        } catch (error) {
            LogUtils.error('Failed to initialize calendar sync:', error);
            throw error;
        }
    }

    private async withLock<T>(lockKey: string, operation: () => Promise<T>, maxWaitTime: number = TIMING.LOCK_TIMEOUT_MS): Promise<T> {
        const startTime = Date.now();

        // Normalize lock key: lowercase, trim whitespace, consistent colon separator
        const normalizedKey = lockKey.toLowerCase().trim().replace(/\s+/g, '');

        // Generate a unique operation ID for this specific lock attempt
        const operationId = `${normalizedKey.substring(0, 20)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        LogUtils.debug(`Lock operation started: ${operationId} for key "${normalizedKey}"`);

        // If we already have the lock (i.e. we're the processing task), proceed
        if (useStore.getState().processingTasks.has(normalizedKey)) {
            LogUtils.debug(`Already have lock for "${normalizedKey}", proceeding with operation ${operationId}`);
            return operation();
        }

        // Try to acquire lock with exponential backoff
        // Re-read state on each iteration to see lock releases by other code paths
        while (useStore.getState().isTaskLocked(normalizedKey)) {
            if (Date.now() - startTime > maxWaitTime) {
                LogUtils.warn(`Lock acquisition timeout for key "${normalizedKey}" (operation: ${operationId}) after ${maxWaitTime}ms`);

                // Check if the lock appears to be stale
                const lockTime = useStore.getState().getLockTimestamp(normalizedKey);
                if (lockTime && Date.now() - lockTime > TIMING.LOCK_TIMEOUT_MS) {
                    // Force-release the stale lock, but DON'T proceed with this operation
                    // The original operation might still be running (just slow/stuck)
                    LogUtils.warn(`Force-releasing stale lock for key "${normalizedKey}" (locked for ${Date.now() - lockTime}ms)`);
                    useStore.getState().removeProcessingTask(normalizedKey);
                    // Abort this operation to prevent duplicate execution
                    throw new Error(`Stale lock released for "${normalizedKey}". Operation ${operationId} aborted - retry will be scheduled.`);
                }

                throw new Error(`Lock timeout: Failed to acquire lock for key "${normalizedKey}" after ${maxWaitTime}ms (operation: ${operationId})`);
            }

            // Exponential backoff with jitter to prevent thundering herd
            const attempts = useStore.getState().getLockAttempts(normalizedKey);
            const baseWait = Math.min(Math.pow(2, attempts) * 100, 1000);
            const jitter = Math.floor(Math.random() * 100); // Add random jitter
            const waitTime = baseWait + jitter;

            LogUtils.debug(`Waiting ${waitTime}ms for lock on "${normalizedKey}" (attempt ${attempts + 1})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            useStore.getState().incrementLockAttempts(normalizedKey);
        }

        // Track timeout handle for cleanup
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        try {
            LogUtils.debug(`Acquired lock for "${normalizedKey}" (${operationId})`);
            useStore.getState().addProcessingTask(normalizedKey);

            // Add operation timeout as an additional safety measure
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`Operation timeout: Lock "${normalizedKey}" held too long (operation: ${operationId}, max: ${maxWaitTime}ms)`));
                }, maxWaitTime);
            });

            // Race between operation and timeout
            const result = await Promise.race([
                operation(),
                timeoutPromise
            ]);

            // Clear the timeout on successful completion to prevent memory leaks
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }

            return result;
        } catch (error) {
            // Clear the timeout on error to prevent memory leaks
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            LogUtils.error(`Error during locked operation ${operationId} for key "${normalizedKey}":`, error);
            throw error;
        } finally {
            LogUtils.debug(`Releasing lock for "${normalizedKey}" (${operationId})`);
            useStore.getState().removeProcessingTask(normalizedKey);
            useStore.getState().resetLockAttempts(normalizedKey);
        }
    }

    public async deleteEvent(eventId: string, taskId?: string): Promise<void> {
        const operation = async () => {
            try {
                await this.checkRateLimit();
                await this.makeRequest(`/calendars/primary/events/${eventId}`, 'DELETE');
                LogUtils.debug(`Successfully deleted event: ${eventId}`);
            } catch (error) {
                // If the event is already gone (410) or not found (404), consider it a success
                if (ErrorUtils.isEventGoneError(error)) {
                    LogUtils.debug(`Event ${eventId} already deleted or not found`);
                    return;
                }
                // For JSON parsing errors on empty responses, also consider it a success
                if (error instanceof SyntaxError && error.message.includes('Unexpected end of JSON input')) {
                    LogUtils.debug(`Successfully deleted event (empty response): ${eventId}`);
                    return;
                }
                // Log and rethrow unexpected errors
                LogUtils.error(`Failed to delete calendar event ${eventId}:`, error);
                throw ErrorUtils.handleCommonErrors(error);
            }
        };

        if (taskId) {
            // Use a single composite lock key instead of nested locks to prevent deadlocks
            return this.withLock(`task:${taskId}:event:${eventId}`, operation);
        } else {
            // If no taskId, just lock the event
            return this.withLock(`event:${eventId}`, operation);
        }
    }

    public async updateEvent(task: Task, eventId: string): Promise<void> {
        // Use a single composite lock key instead of nested locks to prevent deadlocks
        return this.withLock(`task:${task.id}:event:${eventId}`, async () => {
            try {
                if (!task.id) {
                    throw new Error('Cannot update event for task without ID');
                }

                // Check if the event still exists and is valid
                const metadata = this.plugin.settings.taskMetadata[task.id];
                if (!metadata || metadata.eventId !== eventId) {
                    LogUtils.debug(`Event ${eventId} no longer associated with task ${task.id}, skipping update`);
                    return;
                }

                const event = this.createEventFromTask(task);
                await this.makeRequest(`/calendars/primary/events/${eventId}`, 'PUT', event);
                LogUtils.debug(`Updated event ${eventId} for task ${task.id}`);

                const updatedMetadata = {
                    ...metadata,
                    eventId,
                    title: task.title,
                    date: task.date,
                    time: task.time,
                    endTime: task.endTime,
                    reminder: task.reminder,
                    completed: task.completed,
                    lastModified: Date.now(),
                    lastSynced: Date.now()
                };

                this.plugin.settings.taskMetadata[task.id] = updatedMetadata;
                await this.plugin.saveSettings();
            } catch (error) {
                LogUtils.error(`Failed to update event ${eventId} for task ${task.id}: ${error}`);
                throw ErrorUtils.handleCommonErrors(error);
            }
        });
    }

    private async withQueuedProcessing<T>(taskId: string, operation: () => Promise<T>): Promise<T | undefined> {
        // First, check if task was recently synced, don't even try to process it
        const metadata = this.plugin.settings.taskMetadata[taskId];
        if (metadata?.justSynced && metadata.syncTimestamp) {
            const syncAge = Date.now() - metadata.syncTimestamp;
            if (syncAge < 1500) {
                LogUtils.debug(`Task ${taskId} was just synced ${syncAge}ms ago, skipping`);
                return undefined;
            }
        }

        // ATOMIC CHECK-AND-ADD: Do this synchronously (no await) to prevent race conditions
        // JavaScript is single-threaded for synchronous operations
        const alreadyProcessing = this.processingQueue.has(taskId);
        if (!alreadyProcessing) {
            // Claim the slot BEFORE any await to prevent races
            this.processingQueue.add(taskId);
        }

        // Handle the "already processing" case (now safe to do async operations)
        if (alreadyProcessing) {
            try {
                const freshTask = await this.getTaskData(taskId);

                if (freshTask && metadata) {
                    LogUtils.debug(`Task ${taskId} has changes while being processed, waiting for current operation`);
                    const currentPromise = this.processingPromises.get(taskId);
                    if (currentPromise) {
                        await currentPromise;
                    }
                    return this.withLock(`task:${taskId}`, operation);
                }
            } catch (error) {
                LogUtils.error(`Error checking task state for ${taskId}:`, error);
                return undefined;
            }
            return undefined;
        }

        // We own the slot in processingQueue (added synchronously above)
        const promise = (async () => {
            try {
                return await operation();
            } finally {
                this.processingQueue.delete(taskId);
                this.processingPromises.delete(taskId);
            }
        })();
        this.processingPromises.set(taskId, promise);
        return promise;
    }

    private async cleanupExistingEvents(taskId: string): Promise<string | undefined> {
        try {
            // Use cached events for better performance
            const events = await this.findAllObsidianEvents();
            const taskEvents = events.filter(event =>
                event.extendedProperties?.private?.obsidianTaskId === taskId
            );

            LogUtils.debug(`Found ${taskEvents.length} existing events for task ${taskId}`);

            // Check metadata first
            const metadata = this.plugin.settings.taskMetadata[taskId];
            if (metadata?.eventId) {
                // If we have metadata, find that specific event
                const metadataEvent = taskEvents.find(e => e.id === metadata.eventId);
                if (metadataEvent) {
                    // Clean up any other events for this task
                    const duplicates = taskEvents.filter(e => e.id !== metadata.eventId);
                    if (duplicates.length > 0) {
                        LogUtils.debug(`Cleaning up ${duplicates.length} duplicate events for task ${taskId}`);
                        await Promise.all(duplicates.map(event => this.deleteEvent(event.id, taskId)));
                    }
                    return metadata.eventId;
                }
            }

            // If no metadata event found, keep the most recently created event if any exist
            if (taskEvents.length > 0) {
                const [keepEvent, ...duplicates] = taskEvents.sort((a, b) =>
                    new Date(b.created).getTime() - new Date(a.created).getTime()
                );

                // Delete duplicates if any
                if (duplicates.length > 0) {
                    LogUtils.debug(`Cleaning up ${duplicates.length} duplicate events for task ${taskId}`);
                    await Promise.all(duplicates.map(event => this.deleteEvent(event.id, taskId)));
                }

                return keepEvent.id;
            }

            return undefined;
        } catch (error) {
            LogUtils.error(`Failed to cleanup existing events for task ${taskId}:`, error);
            throw error;
        }
    }

    public async syncTask(task: Task): Promise<void> {
        if (!task?.id) {
            LogUtils.warn('Task has no ID, skipping sync');
            return;
        }

        return this.withQueuedProcessing(task.id, async () => {
            try {
                // Trust the task data from the caller — it was already freshly parsed
                // by processSyncQueue or the editor change handler. Re-fetching here
                // added ~100ms latency per task with no benefit.

                // Get metadata and check for existing events
                const metadata = this.plugin.settings.taskMetadata[task.id];

                // Only log task data once per sync operation
                LogUtils.debug(`Processing task ${task.id}: ${JSON.stringify({
                    title: task.title,
                    date: task.date,
                    time: task.time,
                    reminder: task.reminder,
                    completed: task.completed,
                    filePath: task.filePath
                })}`);

                // ── FAST PATH: use metadata eventId as source of truth ──
                // The events cache can be stale (up to 10s), which causes duplicates
                // when multiple syncs fire in quick succession. The metadata is always
                // up-to-date because we write it synchronously after each API call.
                if (metadata?.eventId && !task.completed) {
                    try {
                        const event = this.createEventFromTask(task);
                        await this.makeRequest(`/calendars/primary/events/${metadata.eventId}`, 'PUT', event);
                        this.updateTaskMetadata(task, metadata.eventId, metadata);
                        await this.saveSettings();
                        LogUtils.debug(`Updated existing event ${metadata.eventId} for task ${task.id} (via metadata fast path)`);
                        return;
                    } catch (error) {
                        // If the event was deleted externally (404/410), fall through to create path
                        if (ErrorUtils.isEventGoneError(error)) {
                            LogUtils.debug(`Event ${metadata.eventId} no longer exists, will create new one`);
                        } else {
                            throw error;
                        }
                    }
                }

                // ── SLOW PATH: query calendar API for task events ──
                // Only used for: completed tasks, new tasks (no metadata), or when the
                // metadata eventId was stale (event deleted externally)
                const events = await this.findAllObsidianEvents({ forceFresh: true });
                const taskEvents = events.filter(event =>
                    event.extendedProperties?.private?.obsidianTaskId === task.id
                );

                // Force sync for completed tasks regardless of change detection
                if (task.completed) {
                    LogUtils.debug(`Task ${task.id} is marked as completed, forcing sync to delete events`);
                    try {
                        // Delete all events first
                        const deleteResults = await Promise.allSettled(taskEvents.map(event => this.deleteEvent(event.id)));

                        // Check for any failures
                        const failures = deleteResults.filter(result => result.status === 'rejected');

                        if (failures.length > 0) {
                            LogUtils.error(`Failed to delete ${failures.length}/${taskEvents.length} events for completed task ${task.id}`);
                            throw new Error(`Failed to delete ${failures.length} events for completed task`);
                        }

                        // ALL events deleted successfully, NOW safe to delete metadata
                        if (metadata) {
                            delete this.plugin.settings.taskMetadata[task.id];
                            await this.saveSettings();
                        }
                        this.clearEventsCache(); // Invalidate cache after deletions
                        LogUtils.debug(`Task ${task.id} completed, successfully deleted ${taskEvents.length} associated events`);
                        return;
                    } catch (error) {
                        LogUtils.error(`Error handling completed task ${task.id}:`, error);
                        throw error;
                    }
                }

                // Handle existing events found via API
                if (taskEvents.length > 0) {
                    // Keep the most recently created event
                    const [keepEvent, ...duplicates] = taskEvents.sort((a, b) =>
                        new Date(b.created).getTime() - new Date(a.created).getTime()
                    );

                    // Delete duplicates if any
                    if (duplicates.length > 0) {
                        LogUtils.debug(`Cleaning up ${duplicates.length} duplicate events for task ${task.id}`);
                        await Promise.all(duplicates.map(event => this.deleteEvent(event.id)));
                        this.clearEventsCache(); // Invalidate after cleanup
                    }

                    // Update the kept event
                    const event = this.createEventFromTask(task);
                    await this.makeRequest(`/calendars/primary/events/${keepEvent.id}`, 'PUT', event);
                    this.updateTaskMetadata(task, keepEvent.id, metadata);
                    await this.saveSettings();
                    LogUtils.debug(`Updated existing event ${keepEvent.id} for task ${task.id}`);
                    return;
                }

                // Create new event only if we don't have any existing ones
                const newEventId = await this.createEvent(task);
                if (newEventId) {
                    this.updateTaskMetadata(task, newEventId, metadata);
                    await this.saveSettings();
                    this.clearEventsCache(); // Invalidate after creation so next sync sees it
                    LogUtils.debug(`Created new event ${newEventId} for task ${task.id}`);
                }
            } catch (error) {
                LogUtils.error(`Failed to sync task ${task.id}:`, error);
                throw error;
            }
        });
    }

    public hasTaskChanged(task: Task, metadata: TaskMetadata | undefined): boolean {
        // Use the standardized implementation from taskUtils
        const result = hasTaskChanged(task, metadata, task.id);
        return result.changed;
    }

    public updateTaskMetadata(task: Task, eventId: string | undefined, existingMetadata?: TaskMetadata): void {
        if (!eventId) {
            LogUtils.warn('Cannot update metadata without event ID');
            return;
        }

        // Get current time once to ensure consistency
        const currentTime = Date.now();

        // Increment version counter for this task
        const state = useStore.getState();
        const currentVersion = existingMetadata?.version || 0;
        const newVersion = currentVersion + 1;

        // Generate an operation ID for traceability
        const opId = `${task.id.substring(0, 4)}-${newVersion}-${Math.random().toString(36).substring(2, 5)}`;

        LogUtils.debug(`Updating task metadata ${task.id} (op:${opId}) to version ${newVersion}`);

        // Add a "just synced" flag to prevent immediate reprocessing
        // This will be used to prevent redundant syncs during the same edit session
        const metadata = {
            filePath: task.filePath || existingMetadata?.filePath || '',
            eventId: eventId,
            title: task.title,
            date: task.date,
            time: task.time,
            endTime: task.endTime,
            reminder: task.reminder,
            completed: task.completed,
            createdAt: existingMetadata?.createdAt || currentTime,
            lastModified: currentTime,
            lastSynced: currentTime,
            version: newVersion,                // Explicit version counter
            syncOperationId: opId,              // Operation ID for tracing
            justSynced: true,                   // Flag to prevent double-syncing
            syncTimestamp: currentTime          // When the sync occurred
        };

        LogUtils.debug(`⏰ Set justSynced and syncTimestamp=${currentTime} for task ${task.id}`); // Extra logging for debugging

        this.plugin.settings.taskMetadata[task.id] = metadata;
        useStore.getState().cacheTask(task.id, task, metadata);
        state.updateTaskVersion(task.id, currentTime);  // Use timestamps consistently for version

        // Set a timeout to clear the "justSynced" flag after a cooldown period
        // This prevents immediate resyncs but allows future edits to be synced
        // Note: only clear in memory — no saveSettings() call needed here since
        // justSynced is an ephemeral runtime flag, not important to persist to disk
        setTimeout(() => {
            const currentMetadata = this.plugin.settings.taskMetadata[task.id];
            if (currentMetadata && currentMetadata.syncOperationId === opId) {
                LogUtils.debug(`Clearing "justSynced" flag for task ${task.id} (op:${opId})`);
                currentMetadata.justSynced = false;
            }
        }, TIMING.JUST_SYNCED_FLAG_CLEAR_MS);  // 3.5 second cooldown - longer to ensure it covers all event handlers

        // NOTE: Do NOT clear events cache here. Clearing per-task forces a fresh API call
        // for every subsequent task in the batch. The cache is cleared at sync cycle boundaries
        // (start/end of processSyncQueue) instead, reducing API calls from O(n) to O(1).

        // On mobile, ensure the timestamp is synchronized with additional logging
        if (Platform.isMobile) {
            LogUtils.debug(`Mobile: synced task ${task.id} (op:${opId}) with version ${newVersion} at ${new Date(currentTime).toISOString()}`);
        }
    }

    private async checkRateLimit(): Promise<void> {
        const state = useStore.getState();
        const now = Date.now();

        // Adaptive rate limiting - detect quota errors and adjust accordingly
        const currentLimit = state.syncConfig?.calendarRateLimit || this.DEFAULT_RATE_LIMIT.requests;
        const currentWindow = state.syncConfig?.calendarRateWindow || this.DEFAULT_RATE_LIMIT.window;
        const backoffMultiplier = state.rateLimit.backoffMultiplier || 1.0;

        // Reset rate limit if we're past the window
        if (now > state.rateLimit.resetTime) {
            // Gradually recover from backoff if we've been successful
            if (backoffMultiplier > 1.0) {
                const newMultiplier = Math.max(1.0, backoffMultiplier * 0.9); // Gradually reduce backoff
                state.updateRateLimit({ backoffMultiplier: newMultiplier });

                if (newMultiplier < 1.1) { // If we're close to normal, reset completely
                    state.updateRateLimit({ backoffMultiplier: 1.0 });
                    LogUtils.debug("Rate limit backoff reset to normal");
                }
            }

            state.resetRateLimit();
            return;
        }

        // Calculate effective limit with backoff applied
        const effectiveLimit = Math.floor(currentLimit / backoffMultiplier);

        // If we've hit the limit, wait until reset time
        if (state.rateLimit.requestCount >= effectiveLimit) {
            const waitTime = state.rateLimit.resetTime - now;
            LogUtils.warn(`Rate limit reached (${state.rateLimit.requestCount}/${effectiveLimit}), waiting ${Math.round(waitTime / 1000)}s with backoff multiplier ${backoffMultiplier.toFixed(2)}`);

            // Wait for the rate limit window to reset
            await new Promise<void>(resolve => {
                window.setTimeout(() => {
                    resolve();
                }, waitTime);
            });
            useStore.getState().resetRateLimit();
        }

        // Track this request
        state.incrementRateLimit();
    }


    /**
     * Execute a request with timeout using Promise.race
     */
    private async requestWithTimeout(options: Parameters<typeof requestUrl>[0]): Promise<any> {
        const timeoutMs = TIMING.REQUEST_TIMEOUT_MS;

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        return Promise.race([
            requestUrl(options),
            timeoutPromise
        ]);
    }

    private async makeRequest(endpoint: string, method: string, params?: any): Promise<any> {
        return retryWithBackoff(async () => {
            // Check rate limit before making the request
            await this.checkRateLimit();

            if (!this.plugin.authManager) {
                throw new Error('Auth manager not initialized');
            }

            const accessToken = await this.plugin.authManager.getValidAccessToken();
            const url = `${this.BASE_URL}${endpoint}`;

            const requestUrlString = method === 'GET' && params ?
                `${url}?${new URLSearchParams(params)}` :
                url;

            LogUtils.debug(`Making API request: ${method} ${endpoint}`);
            if (this.plugin.settings.verboseLogging) {
                LogUtils.debug(`Request details: URL: ${requestUrlString}, Method: ${method}, Params: ${params ? JSON.stringify(params) : 'none'}`);
            }

            try {
                const response = await this.requestWithTimeout({
                    url: requestUrlString,
                    method,
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: method !== 'GET' && params ? JSON.stringify(params) : undefined
                });

                // Special handling for 410 Gone on DELETE requests
                if (response.status === 410 && method === 'DELETE') {
                    LogUtils.debug('Resource already deleted');
                    return null;
                }

                if (response.status >= 400) {
                    // Log error details with sanitized response
                    LogUtils.error(`API request failed (${method} ${endpoint}): Status: ${response.status}, Response: ${LogUtils.sanitize(response.text)}`);

                    const apiError: ApiError = new Error(`Request failed, status ${response.status}`);
                    apiError.status = response.status;
                    apiError.response = response.text;
                    throw apiError;
                }

                // For DELETE requests or empty responses, return null
                if (method === 'DELETE' || !response.text) {
                    return null;
                }

                LogUtils.debug(`API request successful: ${method} ${endpoint}`);
                return response.json;
            } catch (error) {
                // Don't log 410 errors for DELETE requests as they're expected
                if (!(error instanceof Error && error.message.includes('status 410') && method === 'DELETE')) {
                    const safeError = error instanceof Error ? error : new Error(String(error));
                    LogUtils.error(`API request failed (${method} ${endpoint}): ${safeError.message}`);

                    // Add better error information for debugging (without sensitive response data)
                    if (this.plugin.settings.verboseLogging) {
                        LogUtils.error(`Request details: Endpoint: ${endpoint}, Method: ${method}, Error: ${safeError.message}`);
                    }

                    // Show a notice for specific errors - check if it's an ApiError
                    const apiError = error as ApiError;
                    if (apiError.status === 400) {
                        new Notice(`Calendar API error (400): Check your authenticated account has calendar access`);
                    } else if (apiError.status === 401) {
                        new Notice(`Authentication error (401): Your session has expired. Please reconnect to Google Calendar.`);
                    } else if (apiError.status === 403) {
                        new Notice(`Permission error (403): You don't have permission to access this calendar.`);
                    }
                }
                throw ErrorUtils.handleCommonErrors(error);
            }
        }, {
            maxAttempts: 3,
            initialDelay: 1000,
            shouldRetry: (error) => {
                // Retry on network errors, timeouts, and 5xx/429 responses
                if (error instanceof Error) {
                    // Always retry on timeout
                    if (error.message.includes('timeout')) {
                        return true;
                    }
                    const status = (error as any).status;
                    // Retry on server errors and rate limiting, but not client errors
                    return !status || status >= 500 || status === 429;
                }
                return true;
            }
        });
    }

    public getTimezoneOffset(): string {
        return TimeUtils.getTimezoneOffset();
    }

    public async findExistingEvent(task: Task): Promise<string | null> {
        try {
            if (!task.id) {
                LogUtils.warn('Cannot find event for task without ID');
                return null;
            }

            // Use the cached events instead of making a new request
            const events = await this.findAllObsidianEvents();
            const matchingEvents = events.filter(event =>
                event.extendedProperties?.private?.obsidianTaskId === task.id
            );

            if (matchingEvents.length > 0) {
                const event = matchingEvents[0]; // Should only ever be one event with this ID
                LogUtils.debug(`Found existing event ${event.id} for task ${task.id}`);
                return event.id;
            }

            return null;
        } catch (error) {
            LogUtils.error(`Failed to search for existing events: ${error}`);
            return null;
        }
    }

    /**
     * Retrieves all Obsidian task events from Google Calendar with aggressive caching
     * 
     * @param timeMin Optional minimum time range
     * @param timeMax Optional maximum time range
     * @param forceFresh Force a fresh fetch from API instead of using cache
     * @returns Array of calendar events
     */
    public async findAllObsidianEvents(options?: { timeMin?: string; timeMax?: string; forceFresh?: boolean }): Promise<GoogleCalendarEvent[]> {
        const { timeMin, timeMax, forceFresh = false } = options ?? {};
        try {
            // Generate a cache key based on the time parameters
            const cacheKey = `events-${timeMin || 'none'}-${timeMax || 'none'}`;

            // Check cache first, unless forced to get fresh data
            if (!forceFresh &&
                this.eventsCache.events &&
                this.eventsCache.syncId === cacheKey &&
                Date.now() - this.eventsCache.timestamp < 10000) {  // Cache valid for longer period (10 seconds)

                LogUtils.debug(`[CACHE HIT] Using cached events (${this.eventsCache.events.length} events, age: ${Date.now() - this.eventsCache.timestamp}ms)`);
                return this.eventsCache.events;
            }

            // Cache miss or forced refresh, fetch from API with clear logging
            LogUtils.debug(`[CACHE MISS] Fetching events from Google Calendar API`);

            const params: any = {
                singleEvents: true,
                privateExtendedProperty: 'isObsidianTask=true',
                maxResults: 2500, // Google Calendar API maximum
                orderBy: 'startTime'
            };

            if (timeMin) params.timeMin = timeMin;
            if (timeMax) params.timeMax = timeMax;

            const response = await this.makeRequest('/calendars/primary/events', 'GET', params);
            const events = response.items || [];

            // Update cache with detailed logging
            this.eventsCache = {
                events,
                timestamp: Date.now(),
                syncId: cacheKey
            };

            LogUtils.debug(`[CACHE UPDATE] Stored ${events.length} events in cache (key: ${cacheKey})`);
            return events;
        } catch (error) {
            // On error, invalidate cache
            this.clearEventsCache();
            LogUtils.error(`Failed to fetch Obsidian events: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    public async createEvent(task: Task): Promise<string> {
        if (!task.id) {
            throw new Error('Cannot create event for task without ID');
        }

        return this.withLock(`task:${task.id}`, async () => {
            try {
                // First cleanup any existing events and get the ID of any event we should keep
                const existingEventId = await this.cleanupExistingEvents(task.id);

                if (existingEventId) {
                    LogUtils.debug(`Using existing event ${existingEventId} for task ${task.id}`);
                    // Update the existing event instead of creating a new one
                    const event = this.createEventFromTask(task);
                    await this.makeRequest(`/calendars/primary/events/${existingEventId}`, 'PUT', event);
                    return existingEventId;
                }

                // Create new event only if we don't have a valid existing one
                const event = this.createEventFromTask(task);
                const response = await this.makeRequest('/calendars/primary/events', 'POST', event);
                if (!response.id) {
                    throw new Error('Failed to create event: no event ID returned');
                }

                LogUtils.debug(`Created new event ${response.id} for task ${task.id}`);
                return response.id;
            } catch (error) {
                LogUtils.error(`Failed to create/update event for task ${task.id}:`, error);
                throw ErrorUtils.handleCommonErrors(error);
            }
        });
    }

    private validateDateTime(date: string, time?: string): boolean {
        if (!TimeUtils.isValidDate(date)) {
            LogUtils.error(`Invalid date format: ${date}`);
            return false;
        }

        if (time && !TimeUtils.isValidTime(time)) {
            LogUtils.error(`Invalid time format: ${time}`);
            return false;
        }

        // Check for DST transitions
        const timezone = this.getTimezoneOffset();
        const dateTime = time ? `${date}T${time}:00${timezone}` : date;
        const parsed = new Date(dateTime);
        if (isNaN(parsed.getTime())) {
            LogUtils.error(`Invalid datetime: ${dateTime}`);
            return false;
        }

        return true;
    }

    private createEventFromTask(task: Task): GoogleCalendarEventInput {
        // Validate date/time
        if (!this.validateDateTime(task.date, task.time)) {
            throw new Error('Invalid date/time format');
        }

        const timezone = this.getTimezoneOffset();
        const version = Date.now().toString(); // Add version tracking

        // Get reminder value - use default if no explicit reminder is set
        const reminderMinutes = task.reminder ?? this.plugin.settings.defaultReminder;
        const reminderOverrides = reminderMinutes ? [{
            method: 'popup' as const,
            minutes: reminderMinutes
        }] : [];

        if (!task.time) {
            return {
                summary: task.title,
                start: { date: task.date },
                end: { date: task.date },
                extendedProperties: {
                    private: {
                        obsidianTaskId: task.id,
                        isObsidianTask: 'true',
                        version
                    }
                },
                reminders: {
                    useDefault: false,
                    overrides: reminderOverrides
                }
            };
        }

        // For time-specific events
        const startDateTime = `${task.date}T${task.time}:00${timezone}`;
        const endDateTime = task.endTime
            ? `${task.date}T${task.endTime}:00${timezone}`
            : `${task.date}T${task.time}:00${timezone}`;

        return {
            summary: task.title,
            start: { dateTime: startDateTime },
            end: { dateTime: endDateTime },
            extendedProperties: {
                private: {
                    obsidianTaskId: task.id,
                    isObsidianTask: 'true',
                    version
                }
            },
            reminders: {
                useDefault: false,
                overrides: reminderOverrides
            }
        };
    }

    public async listEvents(): Promise<GoogleCalendarEvent[]> {
        try {
            await this.checkRateLimit();
            const response = await this.makeRequest('/calendars/primary/events', 'GET');
            return response.items || [];
        } catch (error) {
            LogUtils.error('Failed to list calendar events:', error);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    public getTaskMetadata(taskId: string): TaskMetadata | undefined {
        return this.plugin.settings.taskMetadata[taskId];
    }

    public async saveSettings(): Promise<void> {
        await this.plugin.saveSettings();
    }

    public async getTaskData(taskId: string): Promise<Task | null> {
        try {
            // Get metadata to find the file path
            const metadata = this.plugin.settings.taskMetadata[taskId];
            if (metadata?.filePath) {
                // Force file cache invalidation
                const state = useStore.getState();
                state.invalidateFileCache(metadata.filePath);
            }

            // Now get the task with fresh data
            return this.plugin.taskParser.getTaskById(taskId);
        } catch (error) {
            LogUtils.error(`Error getting fresh task data for ${taskId}:`, error);
            return this.plugin.taskParser.getTaskById(taskId);
        }
    }

    public async cleanupCompletedTasks(): Promise<void> {
        try {
            LogUtils.debug('Starting cleanup of completed tasks');
            const tasks = await this.plugin.taskParser?.getAllTasks() || [];
            const completedTasks = tasks.filter(task => task.completed);

            if (completedTasks.length === 0) {
                LogUtils.debug('No completed tasks found to clean up');
                return;
            }

            LogUtils.debug(`Found ${completedTasks.length} completed tasks to clean up`);

            for (const task of completedTasks) {
                if (!task.id) continue;

                try {
                    await this.syncTask(task);
                } catch (error) {
                    LogUtils.error(`Failed to clean up completed task ${task.id}:`, error);
                    // Continue with other tasks even if one fails
                }
            }

            LogUtils.debug('Completed tasks cleanup finished');
        } catch (error) {
            LogUtils.error('Failed to clean up completed tasks:', error);
            throw error;
        }
    }
}
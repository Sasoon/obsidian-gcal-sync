import { requestUrl, Notice } from 'obsidian';
import type { Task, TaskMetadata } from '../core/types';
import type GoogleCalendarSyncPlugin from '../core/main';
import type { GoogleCalendarEvent } from '../repair/types';
import { LogUtils } from '../utils/logUtils';
import { ErrorUtils } from '../utils/errorUtils';
import { TimeUtils } from '../utils/timeUtils';
import { retryWithBackoff } from '../utils/retryUtils';
import { useStore } from '../core/store';
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
}

export class CalendarSync {
    private readonly BASE_URL = 'https://www.googleapis.com/calendar/v3';
    private readonly RATE_LIMIT = { requests: 500, window: 60 * 1000 }; // 500 requests per minute
    private rateLimit: RateLimitState = {
        lastRequest: 0,
        requestCount: 0,
        resetTime: Date.now()
    };
    private readonly plugin: GoogleCalendarSyncPlugin;
    private processingQueue = new Set<string>();
    private processingPromises = new Map<string, Promise<any>>();

    constructor(plugin: GoogleCalendarSyncPlugin) {
        this.plugin = plugin;
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

    private async withLock<T>(lockKey: string, operation: () => Promise<T>, maxWaitTime: number = 30000): Promise<T> {
        const state = useStore.getState();
        const startTime = Date.now();

        // Remove any 'task:' prefix if it exists
        const normalizedKey = lockKey.replace(/^task:/, '');

        // If we already have the lock (i.e. we're the processing task), proceed
        if (state.processingTasks.has(normalizedKey)) {
            return operation();
        }

        // Try to acquire lock with exponential backoff
        while (state.isTaskLocked(normalizedKey)) {
            if (Date.now() - startTime > maxWaitTime) {
                throw new Error(`Failed to acquire lock for ${normalizedKey} after ${maxWaitTime}ms`);
            }
            // Exponential backoff with max of 1 second
            const waitTime = Math.min(Math.pow(2, state.getLockAttempts(normalizedKey)) * 100, 1000);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            state.incrementLockAttempts(normalizedKey);
        }

        try {
            state.addProcessingTask(normalizedKey);
            return await operation();
        } finally {
            state.removeProcessingTask(normalizedKey);
            state.resetLockAttempts(normalizedKey);
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
                if (error instanceof Error &&
                    (error.message.includes('status 410') || error.message.includes('status 404'))) {
                    LogUtils.debug(`Event ${eventId} already deleted or not found`);
                    return;
                }
                // For JSON parsing errors on empty responses, also consider it a success
                if (error instanceof SyntaxError && error.message.includes('Unexpected end of JSON input')) {
                    LogUtils.debug(`Successfully deleted event (empty response): ${eventId}`);
                    return;
                }
                // Only log as error if it's not one of the expected cases
                if (!(error instanceof Error &&
                    (error.message.includes('status 410') ||
                        error.message.includes('status 404') ||
                        (error instanceof SyntaxError && error.message.includes('Unexpected end of JSON input'))))) {
                    LogUtils.error(`Failed to delete calendar event ${eventId}:`, error);
                }
                // Don't throw error for already deleted events
                if (error instanceof Error &&
                    (error.message.includes('status 410') ||
                        error.message.includes('status 404') ||
                        error.message.includes('Event already deleted'))) {
                    return;
                }
                throw ErrorUtils.handleCommonErrors(error);
            }
        };

        if (taskId) {
            // If we have a taskId, lock both task and event
            return this.withLock(`task:${taskId}`, () =>
                this.withLock(`event:${eventId}`, operation)
            );
        } else {
            // If no taskId, just lock the event
            return this.withLock(`event:${eventId}`, operation);
        }
    }

    public async updateEvent(task: Task, eventId: string): Promise<void> {
        return this.withLock(`task:${task.id}`, async () => {
            return this.withLock(`event:${eventId}`, async () => {
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
        });
    }

    private async withQueuedProcessing<T>(taskId: string, operation: () => Promise<T>): Promise<T | undefined> {
        // If task is being processed, check if it's just a reminder change
        if (this.processingQueue.has(taskId)) {
            try {
                const state = useStore.getState();
                const freshTask = await this.getTaskData(taskId);
                const metadata = this.plugin.settings.taskMetadata[taskId];

                if (freshTask && metadata) {
                    LogUtils.debug(`Task ${taskId} has new changes while being processed, waiting for current operation to finish`);
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
        }

        this.processingQueue.add(taskId);
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
            // First get all events that could be related to this task
            const existingEvents = await this.makeRequest('/calendars/primary/events', 'GET', {
                singleEvents: true,
                privateExtendedProperty: [
                    'isObsidianTask=true'
                ]
            });

            const events = (existingEvents.items || []) as GoogleCalendarEvent[];
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
                // Always get fresh task data to ensure we have the latest state
                const freshTask = await this.getTaskData(task.id);
                if (!freshTask) {
                    LogUtils.warn(`Task ${task.id} not found, skipping sync`);
                    return;
                }

                // Get metadata and check for existing events
                const metadata = this.plugin.settings.taskMetadata[task.id];
                const existingEvents = await this.makeRequest('/calendars/primary/events', 'GET', {
                    singleEvents: true,
                    privateExtendedProperty: [
                        'isObsidianTask=true'
                    ]
                });

                const events = (existingEvents.items || []) as GoogleCalendarEvent[];
                const taskEvents = events.filter(event =>
                    event.extendedProperties?.private?.obsidianTaskId === task.id
                );

                // Only log task data once per sync operation
                LogUtils.debug(`Processing task ${task.id}: ${JSON.stringify({
                    title: freshTask.title,
                    date: freshTask.date,
                    time: freshTask.time,
                    reminder: freshTask.reminder,
                    completed: freshTask.completed,
                    filePath: freshTask.filePath
                })}`);

                if (freshTask.completed) {
                    try {
                        // Delete all events first
                        const deleteResults = await Promise.allSettled(taskEvents.map(event => this.deleteEvent(event.id)));

                        // Check for any failures
                        const failures = deleteResults.filter(result => result.status === 'rejected');
                        if (failures.length > 0) {
                            LogUtils.error(`Failed to delete some events for completed task ${task.id}:`, failures);
                            throw new Error(`Failed to delete ${failures.length} events for completed task`);
                        }

                        // Only remove metadata after successful event deletion
                        if (metadata) {
                            delete this.plugin.settings.taskMetadata[task.id];
                            await this.saveSettings();
                        }
                        LogUtils.debug(`Task ${task.id} completed, successfully deleted ${taskEvents.length} associated events`);
                        return;
                    } catch (error) {
                        LogUtils.error(`Error handling completed task ${task.id}:`, error);
                        throw error;
                    }
                }

                // Handle existing events
                if (taskEvents.length > 0) {
                    // Keep the most recently created event
                    const [keepEvent, ...duplicates] = taskEvents.sort((a, b) =>
                        new Date(b.created).getTime() - new Date(a.created).getTime()
                    );

                    // Delete duplicates if any
                    if (duplicates.length > 0) {
                        LogUtils.debug(`Cleaning up ${duplicates.length} duplicate events for task ${task.id}`);
                        await Promise.all(duplicates.map(event => this.deleteEvent(event.id)));
                    }

                    // Update the kept event
                    const event = this.createEventFromTask(freshTask);
                    await this.makeRequest(`/calendars/primary/events/${keepEvent.id}`, 'PUT', event);
                    this.updateTaskMetadata(freshTask, keepEvent.id, metadata);
                    await this.saveSettings();
                    LogUtils.debug(`Updated existing event ${keepEvent.id} for task ${task.id}`);
                    return;
                }

                // Create new event only if we don't have any existing ones
                const newEventId = await this.createEvent(freshTask);
                if (newEventId) {
                    this.updateTaskMetadata(freshTask, newEventId, metadata);
                    await this.saveSettings();
                    LogUtils.debug(`Created new event ${newEventId} for task ${task.id}`);
                }
            } catch (error) {
                LogUtils.error(`Failed to sync task ${task.id}:`, error);
                throw error;
            }
        });
    }

    public hasTaskChanged(task: Task, metadata: TaskMetadata | undefined): boolean {
        // If no metadata exists, task has changed
        if (!metadata) return true;

        // Compare only the fields that affect the calendar event
        const changes = {
            title: task.title !== metadata.title,
            date: task.date !== metadata.date,
            time: task.time !== metadata.time,
            endTime: task.endTime !== metadata.endTime,
            reminder: task.reminder !== metadata.reminder,
            completed: task.completed !== metadata.completed,
            filePath: task.filePath !== metadata.filePath // Track file moves
        };

        const hasChanged = Object.values(changes).some(change => change);
        if (hasChanged) {
            LogUtils.debug(`Task ${task.id} changed: ${JSON.stringify(changes)}`);
        }

        return hasChanged;
    }

    public updateTaskMetadata(task: Task, eventId: string | undefined, existingMetadata?: TaskMetadata): void {
        if (!eventId) {
            LogUtils.warn('Cannot update metadata without event ID');
            return;
        }

        // Get current time once to ensure consistency
        const currentTime = Date.now();

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
            lastSynced: currentTime
        };

        this.plugin.settings.taskMetadata[task.id] = metadata;
        useStore.getState().cacheTask(task.id, task, metadata);

        // On mobile, ensure the timestamp is synchronized
        if (Platform.isMobile) {
            LogUtils.debug(`Mobile: synced task ${task.id} with timestamp ${currentTime}`);
        }
    }

    private async checkRateLimit(): Promise<void> {
        const state = useStore.getState();
        const now = Date.now();

        // Reset rate limit if we're past the window
        if (now > state.rateLimit.resetTime) {
            state.resetRateLimit();
            return;
        }

        // If we've hit the limit, wait until reset time
        if (state.rateLimit.requestCount >= state.rateLimit.maxRequests) {
            const waitTime = state.rateLimit.resetTime - now;
            LogUtils.warn(`Rate limit reached, waiting ${waitTime}ms`);

            // Create a cancellable wait promise with timeout reporting
            let waitComplete = false;
            const waitPromise = new Promise<void>(resolve => {
                const interval = window.setInterval(() => {
                    const remaining = Math.max(0, state.rateLimit.resetTime - Date.now());
                    if (remaining % 5000 === 0) { // Log every 5 seconds
                        LogUtils.debug(`Still waiting for rate limit: ${remaining}ms remaining`);
                    }
                    if (remaining <= 0 || waitComplete) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 1000);

                // Also resolve after the wait time
                window.setTimeout(() => {
                    waitComplete = true;
                    clearInterval(interval);
                    resolve();
                }, waitTime);
            });

            await waitPromise;
            state.resetRateLimit();
        }

        // Track this request
        state.incrementRateLimit();
    }

    private async makeRequest(endpoint: string, method: string, params?: any): Promise<any> {
        await this.checkRateLimit();

        return retryWithBackoff(async () => {
            try {
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
                    LogUtils.debug(`Request details: 
                        URL: ${requestUrlString}
                        Method: ${method}
                        Params: ${params ? JSON.stringify(params) : 'none'}`
                    );
                }

                const response = await requestUrl({
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
                    // Log full error details
                    LogUtils.error(`API request failed (${method} ${endpoint}): 
                        Status: ${response.status}
                        Response: ${response.text}`
                    );

                    const error = new Error(`Request failed, status ${response.status}: ${response.text}`);
                    (error as any).status = response.status;
                    (error as any).response = response.text;
                    throw error;
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
                    LogUtils.error(`API request failed (${method} ${endpoint}): ${error}`);

                    // Add better error information for debugging
                    if (this.plugin.settings.verboseLogging) {
                        LogUtils.error(`Request details: 
                            Endpoint: ${endpoint}
                            Method: ${method}
                            Params: ${params ? JSON.stringify(params) : 'none'}
                            Error: ${(error as Error).message}
                            Stack: ${(error as Error).stack}`
                        );
                    }

                    // Show a notice for specific errors
                    if ((error as any).status === 400) {
                        new Notice(`Calendar API error (400): Check your authenticated account has calendar access`);
                    } else if ((error as any).status === 401) {
                        new Notice(`Authentication error (401): Your session has expired. Please reconnect to Google Calendar.`);
                    } else if ((error as any).status === 403) {
                        new Notice(`Permission error (403): You don't have permission to access this calendar.`);
                    }
                }
                throw ErrorUtils.handleCommonErrors(error);
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

            const response = await this.makeRequest('/calendars/primary/events', 'GET', {
                singleEvents: true,
                privateExtendedProperty: [
                    `obsidianTaskId=${task.id}`,
                    'isObsidianTask=true'
                ]
            });

            const events = response.items || [];
            if (events.length > 0) {
                const event = events[0]; // Should only ever be one event with this ID
                LogUtils.debug(`Found existing event ${event.id} for task ${task.id}`);
                return event.id;
            }

            return null;
        } catch (error) {
            LogUtils.error(`Failed to search for existing events: ${error}`);
            return null;
        }
    }

    public async findAllObsidianEvents(timeMin?: string, timeMax?: string): Promise<GoogleCalendarEvent[]> {
        try {
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

            LogUtils.debug(`Found ${events.length} Obsidian events in Google Calendar`);
            return events;
        } catch (error) {
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
        return this.plugin.taskParser.getTaskById(taskId);
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
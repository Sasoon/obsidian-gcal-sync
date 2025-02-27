export const SYNC_CONSTANTS = {
    MAX_RETRIES: 3,
    BASE_RETRY_DELAY: 1000, // 1 second
    BATCH_SIZE: 50,
    MAX_RESULTS: 2500, // Google Calendar API maximum
    BATCH_DELAY: 100, // ms between batches
} as const;

export const API_ENDPOINTS = {
    CALENDAR_BASE: 'https://www.googleapis.com/calendar/v3',
    EVENTS: '/calendars/primary/events',
    AUTH: {
        TOKEN: 'https://oauth2.googleapis.com/token',
        REVOKE: 'https://oauth2.googleapis.com/revoke'
    }
} as const;

export const ERROR_MESSAGES = {
    AUTH_REQUIRED: 'Authentication required',
    AUTH_FAILED: 'Authentication failed',
    TOKEN_EXPIRED: 'Token expired',
    NETWORK_ERROR: 'Network error',
    RATE_LIMIT: 'Rate limit exceeded',
    INVALID_DATE: 'Invalid date format',
    INVALID_TIME: 'Invalid time format',
    TASK_NOT_FOUND: 'Task not found',
    EVENT_NOT_FOUND: 'Event not found',
    EVENT_ALREADY_DELETED: 'Event already deleted',
    REPAIR_IN_PROGRESS: 'Repair already in progress'
} as const;

export const LOG_LEVELS = {
    DEBUG: '🔍',
    INFO: 'ℹ️',
    WARN: '⚠️',
    ERROR: '❌',
    SUCCESS: '✅'
} as const; 
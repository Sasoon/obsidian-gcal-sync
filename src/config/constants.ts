export const TIMING = {
    // Debounce delays
    FILE_CHANGE_DEBOUNCE_MS: 1000,
    EDITOR_CHANGE_DEBOUNCE_MS: 500,
    FILE_SYSTEM_SETTLE_MS: 100,

    // Sync timing
    JUST_SYNCED_WINDOW_MS: 2000,  // UNIFIED VALUE - was 1500, 2000, 2500 in different places
    JUST_SYNCED_FLAG_CLEAR_MS: 3500,

    // Lock timing
    LOCK_TIMEOUT_MS: 30000,
    LOCK_WAIT_INTERVAL_MS: 100,

    // Cache TTL
    TASK_CACHE_TTL_MS: 500,
    EVENTS_CACHE_TTL_MS: 10000,

    // Cleanup
    PERIODIC_CLEANUP_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes
    STALE_LOCK_THRESHOLD_MS: 30000,

    // Rate limiting
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    SYNC_QUEUE_CHECK_INTERVAL_MS: 500,
    SYNC_QUEUE_SAFETY_TIMEOUT_MS: 10000,

    // Request timeout
    REQUEST_TIMEOUT_MS: 30000,  // 30 second timeout for API requests
} as const;

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
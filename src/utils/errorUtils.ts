import { ERROR_MESSAGES } from '../config/constants';

export class ErrorUtils {
    /**
     * Check if an error is network related
     */
    static isNetworkError(error: any): boolean {
        return error.message?.includes('network') ||
            error.message?.includes('timeout') ||
            error.code === 'ECONNRESET';
    }

    /**
     * Check if an error is retryable
     */
    static isRetryableError(error: any): boolean {
        return (
            error.status >= 500 || // Server errors
            error.status === 429 || // Rate limit
            this.isNetworkError(error)
        );
    }

    /**
     * Format error for logging
     */
    static formatError(error: Error): string {
        return `${error.name}: ${error.message}`;
    }

    /**
     * Create a standardized error
     */
    static createError(type: keyof typeof ERROR_MESSAGES, details?: string): Error {
        const message = details ?
            `${ERROR_MESSAGES[type]}: ${details}` :
            ERROR_MESSAGES[type];
        return new Error(message);
    }

    /**
     * Extract useful information from an error
     */
    static getErrorInfo(error: any): {
        message: string;
        status?: number;
        code?: string;
        isRetryable: boolean;
    } {
        return {
            message: error.message || 'Unknown error',
            status: error.status,
            code: error.code,
            isRetryable: this.isRetryableError(error)
        };
    }

    /**
     * Handle common error scenarios
     */
    static handleCommonErrors(error: any): Error {
        if (error.status === 401) {
            return this.createError('AUTH_REQUIRED');
        }
        if (error.status === 403) {
            return this.createError('AUTH_FAILED');
        }
        if (error.status === 429) {
            return this.createError('RATE_LIMIT');
        }
        if (error.status === 410) {
            return this.createError('EVENT_ALREADY_DELETED');
        }
        if (error.status === 404) {
            return this.createError('EVENT_NOT_FOUND');
        }
        if (this.isNetworkError(error)) {
            return this.createError('NETWORK_ERROR', error.message);
        }
        return error;
    }
} 
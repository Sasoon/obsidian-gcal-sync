import { LogUtils } from './logUtils';

interface RetryOptions {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    shouldRetry?: (error: any) => boolean;
}

const defaultOptions: Required<RetryOptions> = {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2,
    shouldRetry: (error: any) => {
        // Retry on network errors, rate limits, and server errors
        if (error.status) {
            return error.status === 429 || error.status >= 500;
        }
        return error.message?.includes('network') ||
            error.message?.includes('timeout') ||
            error.code === 'ECONNRESET';
    }
};

export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const config = { ...defaultOptions, ...options };
    let attempt = 1;
    let delay = config.initialDelay;

    while (true) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= config.maxAttempts || !config.shouldRetry(error)) {
                throw error;
            }

            LogUtils.warn(
                `Operation failed (attempt ${attempt}/${config.maxAttempts}), ` +
                `retrying in ${delay}ms: ${error}`
            );

            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * config.backoffFactor, config.maxDelay);
            attempt++;
        }
    }
}

export function isRetryableError(error: any): boolean {
    return defaultOptions.shouldRetry(error);
} 
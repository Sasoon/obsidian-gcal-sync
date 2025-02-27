export interface GoogleConfig {
    clientId: string;
    clientSecret?: string; // Make clientSecret optional since we're using the Netlify function
}

// Load environment variables from .env file
import * as dotenv from 'dotenv';
try {
    dotenv.config();
} catch (e) {
    console.log('Dotenv not available, skipping .env loading (this is normal on mobile)');
}

// Environment variables to use in production
const GOOGLE_CLIENT_ID = process.env?.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env?.GOOGLE_CLIENT_SECRET;

// Load and validate credentials
export function loadGoogleCredentials(): GoogleConfig {
    // For development, use environment variables (allows for testing with different credentials)
    if (GOOGLE_CLIENT_ID) {
        return {
            clientId: GOOGLE_CLIENT_ID,
            // Include clientSecret only if available and needed for development/testing
            ...(GOOGLE_CLIENT_SECRET ? { clientSecret: GOOGLE_CLIENT_SECRET } : {})
        };
    }

    // For development/testing - use placeholders
    console.warn('No client ID found. Set GOOGLE_CLIENT_ID environment variable.');
    return {
        clientId: "PLACEHOLDER_CLIENT_ID",  // Never use real credentials here
        // No client secret needed in the plugin as it's stored securely in the Netlify function
    };
}

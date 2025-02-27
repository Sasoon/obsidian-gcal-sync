export interface GoogleConfig {
    clientId: string;
    clientSecret?: string; // Make clientSecret optional since we're not using it directly anymore
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

    // Production credentials for distributed plugin
    // Only the client ID is needed in the plugin now, as the client secret is stored securely in the Netlify function
    console.log('Using built-in Google client ID');
    return {
        clientId: "341568716968-82823abomit6pom4f1e2v5qvhrqf45g2.apps.googleusercontent.com"
        // No client secret here - it's now stored securely in the Netlify function environment
    };
}
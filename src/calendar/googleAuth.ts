import { Notice, Platform, requestUrl, App, Plugin, ObsidianProtocolData } from 'obsidian';
import { loadGoogleCredentials } from '../config/config';
import type GoogleCalendarSyncPlugin from '../core/main';
import type { OAuth2Tokens } from '../core/types';
import { createHash } from 'crypto';
import { LogUtils } from '../utils/logUtils';
import { CryptoUtils } from '../utils/cryptoUtils';

// Define constants for OAuth redirect URIs
const DESKTOP_PORT = 8085;
const DESKTOP_HOST = '127.0.0.1';
const DESKTOP_PATH = '/callback';
const REDIRECT_URL = `http://${DESKTOP_HOST}:${DESKTOP_PORT}${DESKTOP_PATH}`;

const REDIRECT_URL_MOBILE = 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/redirect.html';

export class GoogleAuthManager {
    private clientId: string;
    private clientSecret: string | null;
    private redirectUri: string;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private tokenExpiry: number | null = null;
    private readonly plugin: GoogleCalendarSyncPlugin;
    private codeVerifier: string | null = null;
    private app: App;
    private encryptionKey: CryptoKey | null = null;

    /**
     * Sanitize text for logging to prevent sensitive data leakage (tokens, secrets, etc.)
     */
    private sanitizeForLogging(text: string | undefined, maxLength = 100): string {
        if (!text) return '[empty]';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...(truncated)';
    }

    /**
     * Sanitize a JSON response object for logging - removes sensitive fields
     */
    private sanitizeResponseForLogging(json: any): string {
        if (!json) return '[empty]';
        // Create a copy and remove sensitive fields
        const sanitized = { ...json };
        if (sanitized.access_token) sanitized.access_token = '[REDACTED]';
        if (sanitized.refresh_token) sanitized.refresh_token = '[REDACTED]';
        if (sanitized.id_token) sanitized.id_token = '[REDACTED]';
        if (sanitized.error_description) {
            sanitized.error_description = this.sanitizeForLogging(sanitized.error_description);
        }
        return JSON.stringify(sanitized);
    }

    constructor(plugin: GoogleCalendarSyncPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        const credentials = loadGoogleCredentials();
        this.clientId = credentials.clientId;
        this.clientSecret = credentials.clientSecret || null;
        this.redirectUri = Platform.isMobile ? REDIRECT_URL_MOBILE : REDIRECT_URL;

        console.log(`🔐 Auth initialized - Using redirect URI: ${this.redirectUri}`);

        // Note: Token loading is handled explicitly in main.ts to avoid duplicate PBKDF2 calls
    }

    /**
     * Gets or derives the encryption key for token storage
     * Uses vault path as salt to tie tokens to this specific vault
     */
    private async getEncryptionKey(): Promise<CryptoKey> {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }

        // Use vault path + plugin ID as salt for key derivation
        // This ties the encrypted tokens to this specific vault installation
        const vaultPath = (this.app.vault.adapter as any).basePath || 'obsidian-vault';
        const salt = CryptoUtils.generateVaultSalt(vaultPath, 'obsidian-gcal-sync');

        this.encryptionKey = await CryptoUtils.deriveKey(salt);
        return this.encryptionKey;
    }

    async authorize(): Promise<void> {
        try {
            console.log('🔐 Starting OAuth flow');

            // Clean up any existing auth state
            await this.cleanup();

            if (Platform.isMobile) {
                await this.handleMobileAuth();
                // Don't initialize calendar sync here - it'll be done by protocol handler
                // after the authentication completes
                return;
            } else {
                // Desktop flow - use local server
                console.log('🔐 Desktop auth - Using redirect URI:', this.redirectUri);

                // Generate state parameter for CSRF protection (matching mobile flow)
                const state = this.generateRandomState();
                this.plugin.settings.tempAuthState = state;
                await this.plugin.saveSettings();

                const params = new URLSearchParams({
                    client_id: this.clientId,
                    redirect_uri: this.redirectUri,
                    response_type: 'code',
                    scope: 'https://www.googleapis.com/auth/calendar.events',
                    access_type: 'offline',
                    prompt: 'consent',
                    state: state // CSRF protection
                });

                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
                console.log('🔐 Full auth URL:', authUrl);

                try {
                    console.log('🔐 Waiting for auth code...');
                    const { code, returnedState } = await this.handleDesktopAuth(authUrl);

                    // Validate state parameter
                    const savedState = this.plugin.settings.tempAuthState;
                    if (!savedState || savedState !== returnedState) {
                        throw new Error('Invalid state parameter. Authentication failed (possible CSRF attack).');
                    }

                    // Clear state after validation
                    this.plugin.settings.tempAuthState = undefined;
                    await this.plugin.saveSettings();

                    console.log('🔐 Received auth code, exchanging for tokens...');
                    await this.handleAuthCode(code);
                    console.log('🔐 Token exchange completed successfully');

                    // Now we can initialize calendar sync after successful authentication
                    console.log('✅ Authorization successful, initializing calendar sync');
                    this.plugin.initializeCalendarSync();
                    new Notice('Successfully connected to Google Calendar!');
                } catch (authError) {
                    console.error('Error during auth process:', authError);
                    await this.cleanup();
                    throw authError;
                }
            }
        } catch (error: any) {
            console.error('Authorization failed:', error);

            // Enhanced error handling
            if (error.code === 'EADDRINUSE') {
                console.log('Port already in use, running cleanup...');
                await this.cleanup();
                new Notice('Port 8085 is already in use. We attempted to free it. Please try again in a moment.');
            } else if (error.code === 'EACCES') {
                new Notice('Permission denied to use port 8085. Please try running Obsidian with elevated privileges.');
            } else if (error.message && error.message.includes('redirect_uri_mismatch')) {
                new Notice('Google OAuth error: Redirect URI mismatch. This is likely a configuration issue with the plugin.');
                console.error('Redirect URI mismatch. The URI used was:', this.redirectUri);
            } else if (error.message && error.message.includes('Authentication timed out')) {
                new Notice('Authentication timed out. Please try again.');
            } else if (error.message && error.message.includes('User closed the auth window')) {
                new Notice('Authentication was cancelled. Please try again if you want to connect to Google Calendar.');
            } else {
                new Notice('Failed to authorize with Google Calendar: ' + (error.message || 'Unknown error'));
            }

            // Ensure cleanup after any error
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Handles the mobile OAuth flow using PKCE (Proof Key for Code Exchange)
     * 
     * The flow works as follows:
     * 1. Generate a code verifier (random string) and code challenge (SHA-256 hash of verifier)
     * 2. Open the Google authorization URL with the code challenge
     * 3. User authenticates in their browser
     * 4. Google redirects to https://obsidian.md/auth/gcalsync
     * 5. Obsidian app intercepts this URL and triggers our protocol handler
     * 6. We exchange the code + verifier for access and refresh tokens
     * 
     * This approach is more secure than the standard OAuth flow because:
     * - The code verifier never leaves the device
     * - Even if the authorization code is intercepted, it can't be used without the verifier
     * - Uses a standard https URL that Obsidian can intercept
     */
    private async handleMobileAuth(): Promise<void> {
        try {
            // Set flag to indicate mobile auth is in progress
            this.plugin.mobileAuthInitiated = true;

            // Generate PKCE code verifier and challenge
            this.codeVerifier = this.generateCodeVerifier();
            const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);

            // Generate a random state value to prevent CSRF attacks
            const state = this.generateRandomState();

            // Store the state and code verifier in plugin settings for persistence across app restarts
            this.plugin.settings.tempAuthState = state;
            this.plugin.settings.tempCodeVerifier = this.codeVerifier;
            await this.plugin.saveSettings();

            console.log('🔐 Stored auth state and code verifier in plugin settings for persistence');

            // Build authorization URL with PKCE parameters
            const params = new URLSearchParams({
                client_id: this.clientId,
                redirect_uri: this.redirectUri,
                response_type: 'code',
                scope: 'https://www.googleapis.com/auth/calendar.events',
                access_type: 'offline',
                prompt: 'consent',
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
                state: state
            });

            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
            console.log('🔐 Mobile auth URL:', authUrl);
            console.log('🔐 IMPORTANT - Exact redirect_uri being sent:', this.redirectUri);

            // Open the authorization URL in the browser
            window.open(authUrl, '_blank');

            new Notice('Please complete authentication in your browser and return to Obsidian when finished.');

            // When Google redirects to the redirect URI, the page will send the user back to Obsidian
            // which will trigger our protocol handler with the auth code

        } catch (error) {
            console.error('Mobile auth error:', error);
            this.plugin.mobileAuthInitiated = false;
            throw error;
        }
    }

    private async handlePKCEAuthCode(code: string): Promise<void> {
        try {
            if (!this.codeVerifier) {
                throw new Error('Code verifier not found. Please restart the authentication process.');
            }

            console.log('🔄 Exchanging auth code for tokens using PKCE flow');
            console.log('Code verifier length:', this.codeVerifier.length);
            console.log('Redirect URI:', this.redirectUri);
            console.log('IMPORTANT - For mobile auth, make sure this redirect URI exactly matches what is registered in Google Cloud Console');

            const requestBody = {
                operation: 'exchange_code_pkce',
                code: code,
                code_verifier: this.codeVerifier,
                redirect_uri: this.redirectUri,
                client_id: this.clientId
            };

            console.log('Token exchange request:', JSON.stringify({
                ...requestBody,
                code: code.substring(0, 5) + '...',  // Only log part of the code for security
                code_verifier: this.codeVerifier.substring(0, 5) + '...'  // Only log part of the verifier for security
            }, null, 2));

            const response = await requestUrl({
                url: 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/.netlify/functions/token-exchange',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            });

            console.log('Token exchange response status:', response.status);

            if (response.status >= 400) {
                console.error('❌ Error response from token exchange:', response.status, this.sanitizeForLogging(response.text));
                throw new Error(`Token exchange failed with status ${response.status}`);
            }

            if (!response.json.access_token) {
                console.error('❌ No access token in response:', this.sanitizeResponseForLogging(response.json));
                throw new Error('Failed to get access token');
            }

            const tokens: OAuth2Tokens = {
                access_token: response.json.access_token,
                refresh_token: response.json.refresh_token,
                scope: response.json.scope,
                token_type: response.json.token_type,
                expiry_date: Date.now() + response.json.expires_in * 1000
            };

            await this.saveTokens(tokens);
            this.plugin.mobileAuthInitiated = false;
            console.log('✅ Successfully exchanged code for tokens using PKCE flow');

        } catch (error) {
            console.error('❌ PKCE token exchange failed:', error instanceof Error ? error.message : 'Unknown error');
            this.plugin.mobileAuthInitiated = false;
            throw error;
        }
    }

    // PKCE helper functions
    private generateCodeVerifier(): string {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return this.base64UrlEncode(array);
    }

    private base64UrlEncode(buffer: Uint8Array): string {
        return btoa(String.fromCharCode.apply(null, [...buffer]))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    private async generateCodeChallenge(verifier: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return this.base64UrlEncode(new Uint8Array(digest));
    }

    private async handleDesktopAuth(authUrl: string): Promise<{ code: string; returnedState: string | null }> {
        return new Promise((resolve, reject) => {
            console.log('🔍 Starting local auth server setup on port', DESKTOP_PORT);

            try {
                let server: any;
                let authCancelled = false;
                let authWindow: Window | null = null;
                const windowCheckInterval = setInterval(() => {
                    // Check if auth window was closed prematurely by user
                    if (authWindow && authWindow.closed && !authCancelled) {
                        authCancelled = true;
                        clearInterval(windowCheckInterval);
                        console.log('Auth window was closed prematurely by user');
                        try {
                            if (server) {
                                server.close(() => console.log('Server closed after user closed auth window'));
                            }
                        } catch (e) {
                            console.log('Error closing server after auth window closed:', e);
                        }
                        reject(new Error('User closed the auth window'));
                    }
                }, 1000);

                // Clean up any existing servers on port 8085
                const http = require('http');
                const net = require('net');

                try {
                    server = http.createServer(async (req: any, res: any) => {
                        console.log(`📥 Received request: ${req.method} ${req.url}`);
                        try {
                            const url = new URL(req.url, `http://localhost:${DESKTOP_PORT}`);
                            console.log('🔗 Parsed callback URL:', url.toString());
                            const code = url.searchParams.get('code');
                            const returnedState = url.searchParams.get('state');
                            const error = url.searchParams.get('error');

                            if (error) {
                                console.error('❌ Auth error received:', error);
                                res.writeHead(400, { 'Content-Type': 'text/html' });
                                res.end(`<html><body><h1>Authentication failed</h1><p>Error: ${error}</p></body></html>`);
                                clearInterval(windowCheckInterval);
                                server.close(() => console.log('🔒 Server closed after error'));
                                reject(new Error(`Authentication error: ${error}`));
                                return;
                            }

                            if (code) {
                                console.log('✅ Received auth code and state');
                                res.writeHead(200, { 'Content-Type': 'text/html' });
                                res.end(`<html><body><h1>Authentication successful!</h1><p>You can now close this window and return to Obsidian.</p></body></html>`);
                                clearInterval(windowCheckInterval);
                                server.close(() => console.log('🔒 Server closed successfully'));
                                resolve({ code, returnedState });
                            }
                        } catch (error) {
                            console.error('Error handling auth callback:', error);
                            clearInterval(windowCheckInterval);
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Internal server error');
                            reject(error);
                        }
                    });

                    server.listen(DESKTOP_PORT, DESKTOP_HOST)
                        .once('listening', () => {
                            console.log(`✅ Server listening on ${DESKTOP_HOST}:${DESKTOP_PORT}`);
                            console.log('🌐 Opening auth URL:', authUrl);

                            // Try to open auth window using shell.openExternal for desktop
                            try {
                                const { shell } = require('electron');
                                shell.openExternal(authUrl);
                                new Notice('Authentication opened in your browser. Please complete the process there.');
                                try {
                                    authWindow = window.open('', 'googleAuth');
                                } catch (trackErr) {
                                    console.log('Unable to track auth window:', trackErr);
                                }
                            } catch (e) {
                                console.log('Failed to open with electron shell, falling back to window.open:', e);
                                try {
                                    authWindow = window.open(authUrl, 'googleAuth', 'width=800,height=600');
                                    if (!authWindow) {
                                        const link = document.createElement('a');
                                        link.href = authUrl;
                                        link.target = '_blank';
                                        link.rel = 'noopener noreferrer';
                                        document.body.appendChild(link);
                                        link.click();
                                        document.body.removeChild(link);
                                    }
                                    new Notice('Authentication opened in your browser. Please complete the process there.');
                                } catch (e2) {
                                    console.error('❌ Failed to open auth window:', e2);
                                    new Notice('Failed to open authentication window. Please check popup blockers.');
                                    clearInterval(windowCheckInterval);
                                    server.close();
                                    reject(new Error('Failed to open authentication window'));
                                }
                            }
                        })
                        .once('error', (error: any) => {
                            console.error('❌ Server error:', error);
                            reject(error);
                        });

                } catch (error) {
                    console.error('Error in server setup:', error);
                    reject(error);
                }

                // Set a timeout for the entire auth process
                const authTimeoutId = setTimeout(() => {
                    if (!authCancelled) {
                        authCancelled = true;
                        clearInterval(windowCheckInterval);
                        try {
                            if (server) {
                                server.close(() => console.log('🔒 Server closed after timeout'));
                            }
                        } catch (e) {
                            console.log('Error closing server:', e);
                        }
                        console.log('⏱️ Authentication timed out');
                        new Notice('Authentication timed out. Please try again.');
                        reject(new Error('Authentication timed out'));
                    }
                }, 300000);

                // Add event listener to cleanup when Obsidian closes
                window.addEventListener('beforeunload', () => {
                    if (!authCancelled) {
                        authCancelled = true;
                        clearTimeout(authTimeoutId);
                        clearInterval(windowCheckInterval);
                        try {
                            if (server) {
                                server.close();
                            }
                        } catch (e) {
                            // Ignore errors during shutdown
                        }
                    }
                }, { once: true });

            } catch (error) {
                console.error('Error in handleDesktopAuth:', error);
                reject(error);
            }
        });
    }

    private async handleAuthCode(code: string): Promise<void> {
        try {
            console.log('🔄 Handling auth code, exchanging for tokens');
            const tokens = await this.exchangeCodeForTokens(code);
            console.log('✅ Successfully exchanged code for tokens');
            await this.saveTokens(tokens);
        } catch (error) {
            console.error('❌ Token exchange failed:', error);
            throw error;
        }
    }

    private async exchangeCodeForTokens(code: string): Promise<OAuth2Tokens> {
        console.log('🔄 Calling Netlify function for token exchange');
        try {
            const response = await requestUrl({
                url: 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/.netlify/functions/token-exchange',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    operation: 'exchange_code',
                    code: code,
                    platform: 'desktop'
                })
            });

            console.log('🔄 Netlify response status:', response.status);

            if (response.status >= 400) {
                console.error('❌ Error response from Netlify:', response.status, this.sanitizeForLogging(response.text));
                throw new Error(`Netlify function returned error ${response.status}`);
            }

            if (!response.json.access_token) {
                console.error('❌ No access token in response:', this.sanitizeResponseForLogging(response.json));
                throw new Error('Failed to get access token');
            }

            return {
                access_token: response.json.access_token,
                refresh_token: response.json.refresh_token,
                scope: response.json.scope,
                token_type: response.json.token_type,
                expiry_date: Date.now() + response.json.expires_in * 1000
            };
        } catch (error) {
            console.error('❌ Token exchange failed:', error);
            throw error;
        }
    }

    async refreshAccessToken(): Promise<OAuth2Tokens> {
        if (!this.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            console.log('Refreshing access token...');

            const response = await requestUrl({
                url: 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/.netlify/functions/token-exchange',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    operation: 'refresh_token',
                    refresh_token: this.refreshToken
                })
            });

            if (response.status >= 400) {
                console.error('Token refresh failed with status', response.status, this.sanitizeForLogging(response.text));
                throw new Error(`Token refresh failed with status ${response.status}`);
            }

            if (!response.json || !response.json.access_token) {
                console.error('Token refresh response missing access_token:', this.sanitizeResponseForLogging(response.json));
                throw new Error('Failed to refresh access token');
            }

            const tokens: OAuth2Tokens = {
                access_token: response.json.access_token,
                refresh_token: this.refreshToken,
                scope: response.json.scope,
                token_type: response.json.token_type,
                expiry_date: Date.now() + response.json.expires_in * 1000
            };

            console.log('Successfully refreshed access token, expires in:', response.json.expires_in);
            await this.saveTokens(tokens);
            return tokens;
        } catch (error) {
            console.error('Failed to refresh access token:', error);
            throw error;
        }
    }

    private async saveTokens(tokens: OAuth2Tokens): Promise<void> {
        this.accessToken = tokens.access_token;
        this.refreshToken = tokens.refresh_token || this.refreshToken;
        this.tokenExpiry = tokens.expiry_date;

        // Save to plugin settings with encryption
        if (this.accessToken && this.refreshToken) {
            try {
                // Add a timestamp for token age tracking
                const securedTokens: OAuth2Tokens = {
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    expiry_date: this.tokenExpiry || 0,
                    token_type: tokens.token_type,
                    scope: tokens.scope,
                    stored_at: Date.now(), // Track when the tokens were saved
                };

                // Encrypt tokens before storage
                const encryptionKey = await this.getEncryptionKey();
                const encryptedTokens = await CryptoUtils.encryptObject(securedTokens, encryptionKey);

                // Store encrypted tokens and clear plain text tokens
                this.plugin.settings.encryptedOAuth2Tokens = encryptedTokens;
                this.plugin.settings.tokensEncrypted = true;
                this.plugin.settings.oauth2Tokens = undefined; // Clear plain text tokens
                await this.plugin.saveSettings();

                // Log successful token storage without exposing token values
                console.log(`Tokens saved (encrypted). Access token valid until: ${new Date(this.tokenExpiry || 0).toLocaleString()}`);
                LogUtils.debug('Authentication tokens saved with encryption');
            } catch (error) {
                console.error('Error saving authentication tokens:', error);
                LogUtils.error('Failed to save authentication tokens');
                throw new Error('Failed to securely store authentication tokens');
            }
        }
    }

    async loadSavedTokens(): Promise<boolean> {
        try {
            let tokens: OAuth2Tokens | undefined;

            // Check if we have encrypted tokens (new format)
            if (this.plugin.settings.tokensEncrypted && this.plugin.settings.encryptedOAuth2Tokens) {
                console.log('Loading encrypted tokens from settings');
                try {
                    const encryptionKey = await this.getEncryptionKey();
                    tokens = await CryptoUtils.decryptObject<OAuth2Tokens>(
                        this.plugin.settings.encryptedOAuth2Tokens,
                        encryptionKey
                    );
                } catch (decryptError) {
                    console.error('Failed to decrypt tokens:', decryptError);
                    LogUtils.error('Token decryption failed. Please reconnect to Google Calendar.');
                    // Clear corrupted encrypted tokens
                    this.plugin.settings.encryptedOAuth2Tokens = undefined;
                    this.plugin.settings.tokensEncrypted = false;
                    await this.plugin.saveSettings();
                    return false;
                }
            }
            // Check for unencrypted tokens (legacy format) and migrate them
            else if (this.plugin.settings.oauth2Tokens?.access_token) {
                console.log('Found unencrypted tokens, migrating to encrypted storage');
                tokens = this.plugin.settings.oauth2Tokens;

                // Migrate to encrypted format
                try {
                    await this.saveTokens(tokens);
                    console.log('Successfully migrated tokens to encrypted storage');
                } catch (migrationError) {
                    console.error('Failed to migrate tokens to encrypted storage:', migrationError);
                    // Continue with unencrypted tokens for this session
                }
            }

            if (!tokens?.refresh_token || !tokens?.access_token) {
                console.log('No saved tokens found');
                return false;
            }

            console.log('Loading saved tokens from settings');

            // Validate token storage date if available
            if (tokens.stored_at) {
                const tokenAge = Date.now() - tokens.stored_at;
                const maxTokenAge = 90 * 24 * 60 * 60 * 1000; // 90 days in milliseconds

                if (tokenAge > maxTokenAge) {
                    console.warn('Stored tokens are older than 90 days, requiring re-authentication for security');
                    LogUtils.warn('Authentication tokens expired (90+ days old), please reconnect');
                    return false;
                }
            }

            this.refreshToken = tokens.refresh_token;
            this.accessToken = tokens.access_token;
            this.tokenExpiry = tokens.expiry_date;

            // Validate token expiry and refresh if needed
            if (this.tokenExpiry && Date.now() >= this.tokenExpiry) {
                console.log('Saved token expired, refreshing...');
                try {
                    const newTokens = await this.refreshAccessToken();
                    return !!newTokens.access_token;
                } catch (refreshError) {
                    console.error('Token refresh failed, clearing tokens:', refreshError);

                    // If refresh fails, clear the invalid tokens
                    this.accessToken = null;
                    this.refreshToken = null;
                    this.tokenExpiry = null;
                    this.plugin.settings.oauth2Tokens = undefined;
                    this.plugin.settings.encryptedOAuth2Tokens = undefined;
                    this.plugin.settings.tokensEncrypted = false;
                    await this.plugin.saveSettings();

                    // Force re-authentication
                    new Notice('Your Google authentication has expired. Please reconnect.');
                    return false;
                }
            }

            console.log('Successfully loaded saved tokens');
            return true;
        } catch (error) {
            console.error('Failed to load saved tokens:', error);
            return false;
        }
    }

    async getValidAccessToken(): Promise<string> {
        if (!this.accessToken || !this.tokenExpiry) {
            if (await this.loadSavedTokens()) {
                if (this.tokenExpiry && Date.now() >= this.tokenExpiry) {
                    const tokens = await this.refreshAccessToken();
                    return tokens.access_token;
                }
                return this.accessToken!;
            }
            throw new Error('Not authenticated');
        }

        if (Date.now() >= this.tokenExpiry) {
            const tokens = await this.refreshAccessToken();
            return tokens.access_token;
        }

        return this.accessToken;
    }

    async revokeAccess(): Promise<void> {
        if (this.accessToken) {
            try {
                await requestUrl({
                    url: `https://oauth2.googleapis.com/revoke?token=${this.accessToken}`,
                    method: 'POST'
                });
                console.log('Successfully revoked access token');
            } catch (error) {
                console.error('Error revoking token:', error);
            }
        }

        // Clear tokens from memory
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;

        // Clear tokens from settings (both encrypted and unencrypted)
        if (this.plugin.settings.oauth2Tokens || this.plugin.settings.encryptedOAuth2Tokens) {
            this.plugin.settings.oauth2Tokens = undefined;
            this.plugin.settings.encryptedOAuth2Tokens = undefined;
            this.plugin.settings.tokensEncrypted = false;
            await this.plugin.saveSettings();
            console.log('Cleared tokens from settings');
        }
    }

    public async cleanup(): Promise<void> {
        console.log('🧹 Starting cleanup process');

        try {
            // Reset mobile auth state if needed
            if (Platform.isMobile && this.plugin.mobileAuthInitiated) {
                this.plugin.mobileAuthInitiated = false;
                this.codeVerifier = null;

                // Clear any stored auth state from settings
                if (this.plugin.settings.tempAuthState || this.plugin.settings.tempCodeVerifier) {
                    console.log('🧹 Cleaning up mobile auth state from settings');
                    this.plugin.settings.tempAuthState = undefined;
                    this.plugin.settings.tempCodeVerifier = undefined;
                    await this.plugin.saveSettings();
                }
            }

            // On desktop platforms, we can use Node's net module for server cleanup
            if (!Platform.isMobile) {
                const net = require('net');

                // Try more aggressive socket connection to force close the port
                console.log('Attempting to connect to port to force it closed');
                const client = new net.Socket();

                // Set a very short timeout for the connection
                client.setTimeout(1000);

                await new Promise<void>((resolve) => {
                    client.once('error', (err: NodeJS.ErrnoException) => {
                        console.log(`Socket connection error (expected if port not in use): ${err.code}`);
                        resolve();
                    });

                    client.once('timeout', () => {
                        console.log('Socket connection timeout');
                        client.destroy();
                        resolve();
                    });

                    client.once('connect', () => {
                        console.log('Successfully connected to server, sending FIN packet');
                        // Send RST packet to forcibly close the connection
                        client.destroy();
                        resolve();
                    });

                    try {
                        client.connect(DESKTOP_PORT, DESKTOP_HOST);
                    } catch (e) {
                        console.log('Error during connect attempt:', e);
                        resolve();
                    }
                });

                // Close any existing auth windows
                try {
                    const existingWindow = window.open('', 'googleAuth');
                    if (existingWindow) {
                        console.log('Found existing auth window, closing it');
                        existingWindow.close();
                    }
                } catch (e) {
                    console.log('Error closing existing auth window:', e);
                }
            }

        } catch (e) {
            console.log('Error during server cleanup:', e);
        }

        console.log('🧹 Cleanup process completed');
    }

    isAuthenticated(): boolean {
        // First check memory
        if (this.accessToken && this.refreshToken) {
            // If we have tokens but they're expired, consider not authenticated
            if (this.tokenExpiry && Date.now() >= this.tokenExpiry) {
                console.log('🔐 Tokens exist but are expired, considering not authenticated');
                return false;
            }
            return true;
        }
        // Then check settings
        const tokens = this.plugin.settings.oauth2Tokens;
        if (tokens?.access_token && tokens?.refresh_token) {
            // If tokens exist but are expired, consider not authenticated
            if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
                console.log('🔐 Saved tokens exist but are expired, considering not authenticated');
                return false;
            }
            return true;
        }
        return false;
    }

    // Generate a random state value for CSRF protection
    private generateRandomState(): string {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return this.base64UrlEncode(array);
    }

    // This method should be called by the plugin when it receives a protocol callback
    public async handleProtocolCallback(params: Record<string, string>): Promise<void> {
        console.log('🔐 Received callback via protocol handler:', params);

        try {
            // Verify state parameter to prevent CSRF attacks
            const savedState = this.plugin.settings.tempAuthState;
            console.log('🔐 Saved state from settings:', savedState);
            console.log('🔐 Received state from callback:', params.state);

            if (!savedState || savedState !== params.state) {
                throw new Error('Invalid state parameter. Authentication failed.');
            }

            // Retrieve code verifier from plugin settings
            const storedVerifier = this.plugin.settings.tempCodeVerifier;
            console.log('🔐 Code verifier exists in settings:', !!storedVerifier);

            if (!storedVerifier) {
                throw new Error('Code verifier not found. Please restart the authentication process.');
            }
            this.codeVerifier = storedVerifier;

            if (params.code) {
                await this.handlePKCEAuthCode(params.code);

                // Clean up settings after successful auth
                this.plugin.settings.tempAuthState = undefined;
                this.plugin.settings.tempCodeVerifier = undefined;
                await this.plugin.saveSettings();
                console.log('🔐 Cleared temporary auth data from settings');
            } else if (params.error) {
                throw new Error(`Authentication error: ${params.error}`);
            } else {
                throw new Error('No authorization code received');
            }
        } catch (error) {
            console.error('Protocol callback error:', error);
            this.plugin.mobileAuthInitiated = false;
            new Notice(`Authentication failed: ${error.message}`);
            throw error;
        }
    }
}
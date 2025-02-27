import { Notice, Platform, requestUrl, App, Modal, Setting } from 'obsidian';
import { loadGoogleCredentials } from '../config/config';
import type GoogleCalendarSyncPlugin from '../core/main';
import type { OAuth2Tokens } from '../core/types';

// Define constants for OAuth redirect URIs
// These MUST EXACTLY match what's registered in Google Cloud Console
const DESKTOP_PORT = 8085;
const DESKTOP_HOST = '127.0.0.1'; // Using 127.0.0.1 instead of localhost for consistency
const DESKTOP_PATH = '/callback';
const REDIRECT_URL = `http://${DESKTOP_HOST}:${DESKTOP_PORT}${DESKTOP_PATH}`;
// For mobile, use Obsidian's standard auth redirect format
const REDIRECT_URL_MOBILE = `https://obsidian.md/auth/gcalsync`;

/**
 * Modal for manually entering the authorization URL
 */
class URLInputModal extends Modal {
    private url: string = '';
    public onSubmit: (url: string) => void;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Paste Google Auth URL' });
        contentEl.createEl('p', {
            text: 'After authorizing in your browser, copy the entire URL from your browser\'s address bar and paste it below.'
        });

        new Setting(contentEl)
            .setName('Authorization URL')
            .setDesc('Paste the complete URL from your browser')
            .addText(text => text
                .setPlaceholder('https://obsidian.md/auth/gcalsync?code=...')
                .onChange(value => {
                    this.url = value;
                })
            );

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Submit')
                .setCta()
                .onClick(() => {
                    if (!this.url) {
                        new Notice('Please paste the authorization URL');
                        return;
                    }

                    this.close();
                    if (this.onSubmit) {
                        this.onSubmit(this.url);
                    }
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class GoogleAuthManager {
    private clientId: string;
    private clientSecret: string | null;
    private redirectUri: string;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private protocolHandler: ((params: any) => any) | null = null;
    private tokenExpiry: number | null = null;
    private codeVerifier: string | null = null;
    private readonly plugin: GoogleCalendarSyncPlugin;

    // Clipboard monitoring variables
    private clipboardMonitoringInterval: NodeJS.Timeout | null = null;
    private lastClipboardContent: string = '';

    constructor(plugin: GoogleCalendarSyncPlugin) {
        this.plugin = plugin;
        const credentials = loadGoogleCredentials();
        this.clientId = credentials.clientId;
        this.clientSecret = credentials.clientSecret || null;
        this.redirectUri = Platform.isDesktop ? REDIRECT_URL : REDIRECT_URL_MOBILE;

        console.log(`🔐 Auth initialized - Platform: ${Platform.isDesktop ? 'Desktop' : 'Mobile'}`);
        console.log(`🔐 Using redirect URI: ${this.redirectUri}`);

        // Load saved tokens immediately
        this.loadSavedTokens().catch(error => {
            console.error('Failed to load saved tokens:', error);
        });
    }

    // PKCE helper functions
    private async generateCodeVerifier(): Promise<string> {
        const array = new Uint8Array(32);
        window.crypto.getRandomValues(array);
        return this.base64UrlEncode(array);
    }

    private base64UrlEncode(buffer: Uint8Array): string {
        const base64 = btoa(String.fromCharCode.apply(null, [...buffer]));
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    private async generateCodeChallenge(verifier: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        return this.base64UrlEncode(new Uint8Array(digest));
    }

    async authorize(): Promise<void> {
        try {
            console.log('🔐 Starting OAuth flow');

            // CRITICAL: Safely enable protocol handlers ONLY for this explicit auth flow
            if (Platform.isMobile) {
                console.log('📱 Mobile auth - Enabling protocol handlers for this flow only');
                await this.logOAuthState('pre-auth');

                // Safely allow protocol handlers for this flow only
                if ((window as any).__GCAL_SYNC_STATE) {
                    (window as any).__GCAL_SYNC_STATE.disableProtocolHandlers = false;
                    (window as any).__GCAL_SYNC_STATE.authStartTime = Date.now();
                    console.log('✅ Protocol handlers explicitly enabled for this auth flow');
                } else {
                    console.log('⚠️ WARNING: GCAL_SYNC_STATE not found');
                }
            }

            // Set a global flag that we're intentionally starting auth
            this.plugin.mobileAuthInitiated = true;

            // Store authorization intent in localStorage for reference
            if (Platform.isMobile) {
                localStorage.setItem('gcal_auth_started_intentionally', 'true');
                localStorage.setItem('gcal_auth_start_time', Date.now().toString());
            }

            // Clean up any existing auth state - this is critical
            // to ensure we don't have lingering servers or auth windows
            await this.cleanup();
            this.codeVerifier = null;

            if (Platform.isDesktop) {
                // Desktop flow - use local server
                console.log('🔐 Desktop auth - Using exact redirect URI:', this.redirectUri);

                const params = new URLSearchParams({
                    client_id: this.clientId,
                    redirect_uri: this.redirectUri,
                    response_type: 'code',
                    scope: 'https://www.googleapis.com/auth/calendar.events',
                    access_type: 'offline',
                    prompt: 'consent'
                });

                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
                console.log('🔐 Starting desktop OAuth flow with redirect URI:', this.redirectUri);
                console.log('🔐 Full auth URL:', authUrl);

                try {
                    console.log('🔐 Waiting for auth code from handleDesktopAuth...');
                    const code = await this.handleDesktopAuth(authUrl);
                    console.log('🔐 Received auth code, calling handleAuthCode...');
                    await this.handleAuthCode(code);
                    console.log('🔐 handleAuthCode completed successfully');
                } catch (authError) {
                    // Make sure to run cleanup before re-throwing
                    console.error('Error during desktop auth process:', authError);
                    await this.cleanup();
                    throw authError;
                }
            } else {
                // Mobile flow - use PKCE
                this.codeVerifier = await this.generateCodeVerifier();
                const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);

                console.log('🔐 Mobile auth - Using exact redirect URI:', this.redirectUri);

                // Create the params with explicit logging
                const params = new URLSearchParams({
                    client_id: this.clientId,
                    redirect_uri: this.redirectUri,
                    response_type: 'code',
                    scope: 'https://www.googleapis.com/auth/calendar.events',
                    access_type: 'offline',
                    prompt: 'consent',
                    code_challenge: codeChallenge,
                    code_challenge_method: 'S256'
                });

                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
                console.log('📱 Full auth URL:', authUrl);

                try {
                    const code = await this.handleMobileAuth(authUrl);
                    await this.handlePKCEAuthCode(code);
                } catch (authError) {
                    // Make sure to run cleanup before re-throwing
                    console.error('Error during mobile auth process:', authError);
                    await this.cleanup();
                    throw authError;
                }
            }

            console.log('✅ Authorization successful, initializing calendar sync');
            this.plugin.initializeCalendarSync();
            new Notice('Successfully connected to Google Calendar!');
        } catch (error: any) {
            console.error('Authorization failed:', error);

            // Enhanced error handling
            if (error.code === 'EADDRINUSE') {
                console.log('Port already in use, running extra cleanup...');
                await this.cleanup(); // Run cleanup again with enhanced logic
                new Notice('Port 8085 is already in use. We attempted to free it. Please try again in a moment.');
            } else if (error.code === 'EACCES') {
                new Notice('Permission denied to use port 8085. Please try running Obsidian with elevated privileges.');
            } else if (error.message && error.message.includes('redirect_uri_mismatch')) {
                new Notice('Google OAuth error: Redirect URI mismatch. This is likely a configuration issue with the plugin.');
                console.error('Redirect URI mismatch. The URI used was:', this.redirectUri);
                console.error('Please ensure this exact URI is registered in the Google Cloud Console.');
            } else if (error.message && error.message.includes('Authentication timed out')) {
                new Notice('Authentication timed out. Please try again.');
            } else if (error.message && error.message.includes('User closed the auth window')) {
                new Notice('Authentication was cancelled. Please try again if you want to connect to Google Calendar.');
            } else {
                new Notice('Failed to authorize with Google Calendar: ' + (error.message || 'Unknown error'));
            }

            // Ensure cleanup after any error
            await this.cleanup();
            this.codeVerifier = null;

            // Reset the mobile auth initiated flag
            this.plugin.mobileAuthInitiated = false;

            // CRITICAL: Re-disable protocol handlers after auth fails
            if (Platform.isMobile && (window as any).__GCAL_SYNC_STATE) {
                (window as any).__GCAL_SYNC_STATE.disableProtocolHandlers = true;
                console.log('🔒 Re-disabled protocol handlers after auth failure');
                await this.logOAuthState('post-auth-failure');
            }

            throw error;
        }
    }

    private async handleDesktopAuth(authUrl: string): Promise<string> {
        return new Promise((resolve, reject) => {
            console.log('🔍 Starting local auth server setup on port', DESKTOP_PORT);

            try {
                // Only try to create HTTP server on desktop platforms
                if (!Platform.isDesktop) {
                    reject(new Error('Desktop auth flow attempted on mobile platform'));
                    return;
                }

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

                // More aggressive cleanup before starting
                console.log('Checking if port is already in use...');
                const tester = net.createServer()
                    .once('error', (err: NodeJS.ErrnoException) => {
                        if (err.code === 'EADDRINUSE') {
                            console.log('Port is in use, attempting to force close it');
                            // Port is in use, force close it
                            const client = new net.Socket();
                            client.setTimeout(1000); // Add timeout

                            client.once('error', (err: NodeJS.ErrnoException) => {
                                console.log('Error connecting to port:', err.code);
                                tester.close();
                            });

                            client.once('timeout', () => {
                                console.log('Connection to port timed out');
                                client.destroy();
                                tester.close();
                            });

                            client.connect(DESKTOP_PORT, DESKTOP_HOST, () => {
                                console.log('Connected to port, sending FIN packet');
                                client.end();
                                setTimeout(() => tester.close(), 100);
                            });
                        } else {
                            console.log('Unexpected error checking port:', err);
                            tester.close();
                        }
                    })
                    .once('listening', () => {
                        console.log('Port is available');
                        tester.close();
                    })
                    .listen(DESKTOP_PORT);

                try {
                    server = http.createServer(async (req: any, res: any) => {
                        console.log(`📥 Received request: ${req.method} ${req.url}`);
                        try {
                            const url = new URL(req.url, `http://localhost:${DESKTOP_PORT}`);
                            console.log('🔗 Parsed callback URL:', url.toString());
                            const code = url.searchParams.get('code');
                            const error = url.searchParams.get('error');

                            if (error) {
                                console.error('❌ Auth error received:', error);
                                res.writeHead(400, { 'Content-Type': 'text/html' });
                                res.end(`
                                    <html>
                                        <head>
                                            <style>
                                                body {
                                                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                                                    text-align: center;
                                                    margin-top: 40px;
                                                    line-height: 1.5;
                                                }
                                                .error {
                                                    color: #e53935;
                                                    margin: 20px 0;
                                                }
                                                .btn {
                                                    background-color: #7f6df2;
                                                    color: white;
                                                    border: none;
                                                    padding: 10px 20px;
                                                    border-radius: 4px;
                                                    font-size: 16px;
                                                    cursor: pointer;
                                                    margin-top: 20px;
                                                }
                                                .btn:hover {
                                                    background-color: #6a5cd6;
                                                }
                                            </style>
                                        </head>
                                        <body>
                                            <h1>Authentication failed</h1>
                                            <p class="error">Error: ${error}</p>
                                            <p>Please close this window and try again in Obsidian.</p>
                                            <button class="btn" onclick="window.close()">Close this window</button>
                                            <script>
                                                // Try to close automatically
                                                try {
                                                    window.close();
                                                } catch (e) {
                                                    console.log('Auto-close failed, user will need to close manually');
                                                }
                                            </script>
                                        </body>
                                    </html>
                                `);

                                // Cleanup
                                clearInterval(windowCheckInterval);
                                server.close(() => console.log('🔒 Server closed after error'));

                                // Try to restore focus to Obsidian
                                setTimeout(() => this.focusObsidian(), 500);

                                reject(new Error(`Authentication error: ${error}`));
                                return;
                            }

                            if (code) {
                                console.log('✅ Received auth code');
                                res.writeHead(200, { 'Content-Type': 'text/html' });
                                res.end(`
                                    <html>
                                        <head>
                                            <style>
                                                body {
                                                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                                                    text-align: center;
                                                    margin-top: 40px;
                                                    line-height: 1.5;
                                                }
                                                .btn {
                                                    background-color: #7f6df2;
                                                    color: white;
                                                    border: none;
                                                    padding: 10px 20px;
                                                    border-radius: 4px;
                                                    font-size: 16px;
                                                    cursor: pointer;
                                                    margin-top: 20px;
                                                }
                                                .btn:hover {
                                                    background-color: #6a5cd6;
                                                }
                                            </style>
                                        </head>
                                        <body>
                                            <h1>Authentication successful!</h1>
                                            <p>Google Calendar has been connected to Obsidian.</p>
                                            <p>You can now close this window and return to Obsidian.</p>
                                            <button class="btn" onclick="window.close()">Close this window</button>
                                            <script>
                                                // Try to close automatically
                                                try {
                                                    window.close();
                                                } catch (e) {
                                                    console.log('Auto-close failed, user will need to close manually');
                                                }
                                            </script>
                                        </body>
                                    </html>
                                `);

                                // Cleanup 
                                clearInterval(windowCheckInterval);
                                server.close(() => console.log('🔒 Server closed successfully'));

                                // Try to restore focus to Obsidian
                                setTimeout(() => this.focusObsidian(), 500);

                                resolve(code);
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
                                // Use require here to avoid issues with mobile
                                const { shell } = require('electron');
                                shell.openExternal(authUrl);
                                new Notice('Authentication opened in your browser. Please complete the process there.');

                                // Try to track the browser window
                                try {
                                    // This might not work due to cross-origin issues, but we'll try
                                    authWindow = window.open('', 'googleAuth');
                                } catch (trackErr) {
                                    console.log('Unable to track auth window:', trackErr);
                                }
                            } catch (e) {
                                console.log('Failed to open with electron shell, falling back to window.open:', e);
                                try {
                                    // Fallback to regular window.open with system browser
                                    authWindow = window.open(authUrl, 'googleAuth', 'width=800,height=600');

                                    if (!authWindow) {
                                        // If window.open failed, try a clickable link as last resort
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
                                    clearInterval(windowCheckInterval); // Clear the interval
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

                        // Clear the window check interval
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

    /**
     * Fallback method for manual authentication when local server fails
     */
    private async handleManualAuthFallback(authUrl: string): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                // Modify the auth URL to use the mobile redirect URI
                const mobileAuthUrl = authUrl.replace(
                    encodeURIComponent(REDIRECT_URL),
                    encodeURIComponent(REDIRECT_URL_MOBILE)
                );

                console.log('🔄 Switching to manual auth with URL:', mobileAuthUrl);

                // Open the auth URL
                window.open(mobileAuthUrl, '_blank');

                // Show instructions to the user
                new Notice(
                    'Please complete authentication in your browser. After authorizing, copy the entire URL from your browser address bar and paste it when prompted.',
                    15000
                );

                // Create a modal to paste the URL
                const modal = new URLInputModal(this.plugin.app);

                modal.onSubmit = (url: string) => {
                    try {
                        // Parse the URL to extract the code
                        const parsedUrl = new URL(url);
                        const code = parsedUrl.searchParams.get('code');

                        if (!code) {
                            new Notice('Could not find authorization code in the URL. Please make sure you copied the entire URL.');
                            reject(new Error('No authorization code in URL'));
                            return;
                        }

                        console.log('✅ Successfully extracted auth code from manual input');
                        new Notice('Successfully extracted auth code!');

                        resolve(code);
                    } catch (e) {
                        console.error('Error parsing URL:', e);
                        new Notice('Invalid URL format. Please make sure you copied the entire URL.');
                        reject(new Error('Invalid URL format'));
                    }
                };

                modal.open();
            } catch (error) {
                console.error('Error in handleManualAuthFallback:', error);
                reject(error);
            }
        });
    }

    private async handleMobileAuth(authUrl: string): Promise<string> {
        console.log('📱 Starting mobile auth with PKCE');

        // Set a flag in memory to track that we're initiating auth (used to detect redirects)
        this.plugin.mobileAuthInitiated = true;
        console.log('Set mobileAuthInitiated flag to true');

        // Ensure protocol handlers are enabled for this auth flow
        this.safelyEnableProtocolHandlers();

        // First, ensure all persistent state is cleared
        localStorage.removeItem('gcal_auth_interrupted');
        localStorage.removeItem('gcal_auth_url');
        localStorage.removeItem('gcal_auth_in_progress');
        localStorage.removeItem('gcal_handler_registered');
        localStorage.removeItem('gcal_auth_state');
        localStorage.removeItem('gcal_auth_code_verifier');

        // Add a critical timestamp to differentiate between intentional auth attempts
        // and potential remnants of previous sessions
        localStorage.setItem('gcal_auth_explicit_start_timestamp', Date.now().toString());

        // Ensure any existing handler is cleaned up
        await this.cleanup();

        // Add a small delay to ensure cleanup is complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Try to unregister again just to be sure - double cleanup is important on mobile
        try {
            this.plugin.app.unregisterProtocolHandler?.('auth/gcalsync');
            console.log('Unregistered existing auth/gcalsync handler');
        } catch (e) {
            console.log('No existing handler to unregister');
        }

        // Wait another moment to ensure cleanup
        await new Promise(resolve => setTimeout(resolve, 200));

        return new Promise((resolve, reject) => {
            try {
                let authCancelled = false;
                let authWindow: Window | null = null;

                const timeoutId = setTimeout(() => {
                    if (!authCancelled) {
                        authCancelled = true;
                        this.cleanup();
                        this.stopClipboardMonitoring();
                        console.log('⏱️ Authentication timed out after 5 minutes');
                        new Notice('Authentication timed out. Please try again.');
                        reject(new Error('Authentication timed out after 5 minutes'));
                    }
                }, 300000);

                // Store original URL for retry
                const originalUrl = authUrl;

                // Create special markers with timestamp to track THIS specific auth flow
                const authFlowId = Date.now().toString();
                localStorage.setItem('gcal_auth_flow_id', authFlowId);
                localStorage.setItem('gcal_auth_flow_started_at', Date.now().toString());
                localStorage.setItem('gcal_auth_started_intentionally', 'true');

                // Create a function to handle when the app is closed during auth
                const appStateChange = () => {
                    if (document.visibilityState === 'hidden') {
                        console.log('📱 App going to background during auth flow');
                        // Set a flag in localStorage to detect if auth was interrupted
                        localStorage.setItem('gcal_auth_interrupted', 'true');
                        localStorage.setItem('gcal_auth_url', originalUrl);
                        // Add a flag to indicate auth is in progress - this helps with cleanup later
                        localStorage.setItem('gcal_auth_in_progress', 'true');
                        // Update flow timestamp to know this is active
                        localStorage.setItem('gcal_auth_flow_last_active', Date.now().toString());
                    } else if (document.visibilityState === 'visible') {
                        console.log('📱 App returning to foreground');
                        const wasInterrupted = localStorage.getItem('gcal_auth_interrupted') === 'true';
                        const authInProgress = localStorage.getItem('gcal_auth_in_progress') === 'true';
                        const storedFlowId = localStorage.getItem('gcal_auth_flow_id');
                        const startTimestamp = localStorage.getItem('gcal_auth_explicit_start_timestamp');

                        // Only consider this a continuation of an auth flow if we have a valid start timestamp
                        // and it's from the current app session (within last 30 minutes)
                        const isCurrentSession = startTimestamp &&
                            (Date.now() - parseInt(startTimestamp)) < 30 * 60 * 1000;

                        // Check if we're in the same auth flow
                        const isSameFlow = storedFlowId === authFlowId && isCurrentSession;

                        // Update flow timestamp to know this is active
                        if (isSameFlow) {
                            localStorage.setItem('gcal_auth_flow_last_active', Date.now().toString());
                        }

                        // Clean auth state in localStorage if not the same flow
                        if (!isSameFlow) {
                            console.log('Not the same auth flow, cleaning auth state');
                            localStorage.removeItem('gcal_auth_interrupted');
                            localStorage.removeItem('gcal_auth_url');
                            localStorage.removeItem('gcal_auth_in_progress');
                            // Don't continue with any processing for a different flow
                            return;
                        }

                        // Don't try to recover the flow if it's already completed
                        if (authCancelled) {
                            return;
                        }

                        // Only show recovery message if there was an actual interruption in our flow
                        if (wasInterrupted && authInProgress && isSameFlow) {
                            // Show a message to let the user know we need to restart auth
                            new Notice('Detected app reopen during auth. Please try authenticating again.');
                            // Cancel the current auth flow
                            authCancelled = true;
                            this.cleanup();
                            clearTimeout(timeoutId);
                            reject(new Error('Authentication interrupted by app restart'));
                        }
                    }
                };

                // Add visibility change listener
                document.addEventListener('visibilitychange', appStateChange);

                const handler = (params: any) => {
                    // Make sure to remove the visibility change listener
                    document.removeEventListener('visibilitychange', appStateChange);

                    // Clear all auth state in localStorage
                    localStorage.removeItem('gcal_auth_interrupted');
                    localStorage.removeItem('gcal_auth_url');
                    localStorage.removeItem('gcal_auth_in_progress');

                    console.log('📱 Received callback params:', params);
                    new Notice('Received auth callback! Processing...');

                    if (authCancelled) {
                        console.log('Ignoring callback because auth was already cancelled or completed');
                        return;
                    }

                    authCancelled = true;
                    clearTimeout(timeoutId);
                    this.stopClipboardMonitoring();

                    // Close the auth window if it's still open
                    if (authWindow && !authWindow.closed) {
                        authWindow.close();
                    }

                    // Check for error parameter
                    if (params.error) {
                        console.error('❌ Auth error received:', params.error);
                        const errorDescription = params.error_description || 'Unknown error';
                        new Notice(`Authentication error: ${params.error} - ${errorDescription}`);
                        this.cleanup();
                        reject(new Error(`Authentication error: ${params.error} - ${errorDescription}`));
                        return;
                    }

                    const code = params.code;
                    if (!code) {
                        console.error('❌ No auth code received:', params);
                        new Notice('Error: No authorization code received!');
                        this.cleanup();
                        reject(new Error('No authorization code received from Google'));
                        return;
                    }

                    console.log('✅ Successfully received auth code');
                    new Notice('Successfully received auth code!');
                    this.cleanup();

                    // Try to restore focus to Obsidian
                    setTimeout(() => this.focusObsidian(), 500);

                    resolve(code);
                };

                // Register a protocol handler for Obsidian's auth URL format
                // This works on mobile since Obsidian app can capture these URLs
                // The format must match the path in our redirect URI after obsidian.md/
                try {
                    // Set a critical flag that we are deliberately starting auth
                    // This helps distinguish between intentional and unexpected auth flows
                    localStorage.setItem('gcal_auth_started_intentionally', 'true');
                    this.plugin.mobileAuthInitiated = true;

                    // First make sure we unregister any existing handler
                    try {
                        this.plugin.app.unregisterProtocolHandler?.('auth/gcalsync');
                        console.log('Pre-emptively unregistered any existing auth/gcalsync handler');
                    } catch (e) {
                        console.log('No existing handler to unregister:', e);
                    }

                    // Wait a moment to ensure any cleanup is processed
                    new Promise(resolve => setTimeout(resolve, 50)).then(() => {
                        // Our safer registration approach relies on the prototype interception in main.ts
                        // This will prevent registrations unless explicitly allowed during an auth flow
                        try {
                            this.plugin.registerObsidianProtocolHandler('auth/gcalsync', handler);
                            console.log('Requested auth/gcalsync handler registration');
                            this.protocolHandler = handler;

                            // Verify if handler was actually registered
                            if ((window as any).__GCAL_SYNC_STATE?.disableProtocolHandlers) {
                                console.log('Note: Protocol handlers are disabled - registration was likely blocked');
                                // Instead of registering, the handler was saved for potential later use
                            } else {
                                console.log('Successfully registered auth/gcalsync handler');
                            }
                        } catch (e) {
                            console.log('Failed handler registration:', e);
                        }
                    });

                    // Mark in localStorage that we've requested a handler that needs cleanup
                    localStorage.setItem('gcal_handler_registered', 'true');
                } catch (e) {
                    document.removeEventListener('visibilitychange', appStateChange);
                    console.error('Failed to register protocol handler:', e);
                    new Notice('Failed to register authentication handler. Please restart Obsidian and try again.');
                    throw e;
                }

                console.log('🌐 Opening auth URL:', authUrl);

                // Break down the mobile auth URL to help debug
                try {
                    const url = new URL(authUrl);
                    console.log('📱 Auth URL breakdown:');
                    console.log('- Protocol:', url.protocol);
                    console.log('- Host:', url.host);
                    console.log('- Pathname:', url.pathname);
                    console.log('- Redirect URI param:', url.searchParams.get('redirect_uri'));
                    console.log('- Client ID:', url.searchParams.get('client_id'));
                    console.log('- Response type:', url.searchParams.get('response_type'));
                    console.log('- Code challenge:', url.searchParams.get('code_challenge')?.substring(0, 10) + '...');
                } catch (e) {
                    console.error('Error parsing auth URL:', e);
                }

                authWindow = window.open(authUrl, '_blank');

                if (!authWindow) {
                    console.error('❌ Failed to open auth window. Popup might be blocked.');
                    new Notice('Failed to open authentication window. Please check if popup blockers are enabled.');
                    authCancelled = true;
                    clearTimeout(timeoutId);
                    this.cleanup();
                    this.stopClipboardMonitoring();
                    reject(new Error('Failed to open authentication window'));
                    return;
                }

                // Show a more detailed notice to the user with clear instructions
                new Notice(
                    'Google login opened in browser. After authorizing, the app should automatically receive the callback. If not, copy the URL from your browser.',
                    10000
                );

                // Start monitoring clipboard for auth URLs as a fallback mechanism
                this.startClipboardMonitoring(resolve, reject, timeoutId);

                // Add a command to manually process a pasted URL as fallback
                this.addManualUrlPasteCommand(resolve, reject, timeoutId);

            } catch (error) {
                console.error('❌ Failed to setup auth handler:', error);
                new Notice('Failed to set up authentication handler');
                this.cleanup();
                this.stopClipboardMonitoring();
                reject(error);
            }
        });
    }

    /**
     * Start monitoring the clipboard for auth URLs as a fallback mechanism
     */
    private startClipboardMonitoring(resolve: (code: string) => void, reject: (error: Error) => void, timeoutId: NodeJS.Timeout): void {
        // Don't start if already monitoring
        if (this.clipboardMonitoringInterval) {
            return;
        }

        console.log('Starting clipboard monitoring for auth URL as fallback');
        new Notice('Waiting for automatic callback. If it fails, you can copy the URL manually...', 5000);

        // Check clipboard every 1 second
        this.clipboardMonitoringInterval = setInterval(async () => {
            try {
                // Get clipboard content
                const clipboard = await navigator.clipboard.readText();

                // Skip if same as last check or empty
                if (clipboard === this.lastClipboardContent || !clipboard) {
                    return;
                }

                this.lastClipboardContent = clipboard;

                // Check if it's a valid auth URL
                if (clipboard.includes('obsidian.md/auth/gcalsync')) {
                    console.log('Found auth URL in clipboard:', clipboard.substring(0, 20) + '...');

                    // Extract the code parameter
                    try {
                        const url = new URL(clipboard);
                        const code = url.searchParams.get('code');

                        if (!code) {
                            console.log('No code found in URL, continuing to monitor');
                            return;
                        }

                        // Process the code
                        console.log('✅ Successfully extracted auth code from clipboard');
                        new Notice('Auth URL detected in clipboard! Processing authentication...', 5000);

                        // Stop monitoring and clean up
                        this.stopClipboardMonitoring();
                        clearTimeout(timeoutId);
                        this.cleanup();

                        // Try to restore focus to Obsidian
                        setTimeout(() => this.focusObsidian(), 500);

                        // Resolve the promise with the code
                        resolve(code);
                    } catch (e) {
                        console.error('Error parsing URL from clipboard:', e);
                    }
                }
            } catch (e) {
                console.error('Error checking clipboard:', e);
            }
        }, 1000);
    }

    /**
     * Stop monitoring the clipboard
     */
    private stopClipboardMonitoring(): void {
        if (this.clipboardMonitoringInterval) {
            clearInterval(this.clipboardMonitoringInterval);
            this.clipboardMonitoringInterval = null;
            console.log('Stopped clipboard monitoring');
        }
    }

    /**
     * Adds a temporary command to allow users to manually paste the auth URL as a fallback
     */
    private addManualUrlPasteCommand(resolve: (code: string) => void, reject: (error: Error) => void, timeoutId: NodeJS.Timeout): void {
        // Add a command to manually process a pasted URL
        const commandId = 'gcal-sync-paste-auth-url';

        try {
            this.plugin.addCommand({
                id: commandId,
                name: 'Paste Google Auth URL (Fallback)',
                callback: async () => {
                    try {
                        // Get clipboard content
                        const clipboard = await navigator.clipboard.readText();
                        console.log('Processing pasted URL:', clipboard.substring(0, 20) + '...');

                        // Check if it's a valid auth URL
                        if (!clipboard.includes('obsidian.md/auth/gcalsync')) {
                            new Notice('The pasted text does not appear to be a valid Google auth URL. It should contain "obsidian.md/auth/gcalsync"');
                            return;
                        }

                        // Extract the code parameter
                        const url = new URL(clipboard);
                        const code = url.searchParams.get('code');

                        if (!code) {
                            new Notice('Could not find authorization code in the URL. Please make sure you copied the entire URL.');
                            return;
                        }

                        // Process the code
                        console.log('✅ Successfully extracted auth code from pasted URL');
                        new Notice('Successfully extracted auth code!');

                        // Clean up
                        clearTimeout(timeoutId);
                        this.cleanup();
                        this.stopClipboardMonitoring();

                        // Try to restore focus to Obsidian
                        setTimeout(() => this.focusObsidian(), 500);

                        // Remove this temporary command - using the proper Obsidian API
                        // The command ID is prefixed with the plugin ID
                        const fullCommandId = `${this.plugin.manifest.id}:${commandId}`;
                        if (this.plugin.app.commands.commands[fullCommandId]) {
                            this.plugin.app.commands.removeCommand(fullCommandId);
                        }

                        // Resolve the promise with the code
                        resolve(code);
                    } catch (error) {
                        console.error('Error processing pasted URL:', error);
                        new Notice(`Error processing URL: ${error.message}`);
                    }
                }
            });

            console.log('Added manual URL paste command as fallback');
            new Notice('A command "Paste Google Auth URL (Fallback)" has been added in case automatic detection fails.', 8000);

            // Remove the command when auth completes or times out
            setTimeout(() => {
                try {
                    const fullCommandId = `${this.plugin.manifest.id}:${commandId}`;
                    if (this.plugin.app.commands.commands[fullCommandId]) {
                        this.plugin.app.commands.removeCommand(fullCommandId);
                    }
                    console.log('Removed temporary URL paste command');
                } catch (e) {
                    // Command might already be removed, ignore
                }
            }, 300000); // 5 minutes timeout

        } catch (error) {
            console.error('Failed to add manual URL paste command:', error);
        }
    }

    /**
     * Exchange auth code for tokens using PKCE (for mobile)
     */
    private async handlePKCEAuthCode(code: string): Promise<void> {
        if (!this.codeVerifier) {
            const errorMsg = 'No code verifier found - PKCE flow not initialized properly';
            new Notice(errorMsg);
            throw new Error(errorMsg);
        }

        try {
            console.log('🔄 Exchanging code for tokens using PKCE');
            console.log('🔄 Token exchange using redirect URI:', this.redirectUri);
            new Notice('Exchanging authorization code for tokens...');

            // Mobile-specific: Ensure we clean up any lingering state
            // to prevent unwanted redirects after successful auth
            if (Platform.isMobile) {
                // Clear all auth-related localStorage items
                localStorage.removeItem('gcal_auth_interrupted');
                localStorage.removeItem('gcal_auth_url');
                localStorage.removeItem('gcal_auth_in_progress');

                // Clean up protocol handlers immediately
                try {
                    this.plugin.app.unregisterProtocolHandler?.('auth/gcalsync');
                    console.log('Mobile: Unregistered protocol handler before token exchange');
                } catch (e) {
                    console.log('Error unregistering protocol handler:', e);
                }
            }

            // Call our secure Netlify function instead of Google directly
            const response = await requestUrl({
                url: 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/.netlify/functions/token-exchange',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    operation: 'exchange_code',
                    code: code,
                    code_verifier: this.codeVerifier,
                    platform: 'mobile'
                })
            });

            console.log('🔄 Token response status:', response.status);
            console.log('🔄 Token response headers:', JSON.stringify(response.headers));

            if (response.status >= 400) {
                const errorMsg = `Token exchange failed with status ${response.status}: ${response.text}`;
                console.error(errorMsg);
                new Notice(errorMsg);
                throw new Error(errorMsg);
            }

            if (!response.json.access_token) {
                const errorMsg = 'Failed to get access token from Google';
                console.error(errorMsg, response.json);
                new Notice(errorMsg);
                throw new Error(errorMsg);
            }

            const tokens: OAuth2Tokens = {
                access_token: response.json.access_token,
                refresh_token: response.json.refresh_token,
                scope: response.json.scope,
                token_type: response.json.token_type,
                expiry_date: Date.now() + response.json.expires_in * 1000
            };

            console.log('🔄 Received tokens:', {
                access_token: tokens.access_token ? '(present)' : '(missing)',
                refresh_token: tokens.refresh_token ? '(present)' : '(missing)',
                scope: tokens.scope,
                expiry: new Date(tokens.expiry_date).toISOString()
            });

            await this.saveTokens(tokens);

            // Reset code verifier
            this.codeVerifier = null;
            console.log('✅ PKCE token exchange successful');
            new Notice('Successfully authenticated with Google Calendar!');

            // Mobile-specific: One more cleanup after successful auth
            if (Platform.isMobile) {
                // Ensure we clean up all traces of the auth flow to avoid issues on next open
                await this.cleanup();
            }

            // Bring focus back to Obsidian
            this.focusObsidian();
        } catch (error) {
            console.error('PKCE token exchange failed:', error);
            new Notice('Failed to exchange token: ' + (error as Error).message);
            this.codeVerifier = null;

            // Even on error, ensure we clean up on mobile
            if (Platform.isMobile) {
                await this.cleanup();
            }

            throw error;
        }
    }

    private async handleAuthCode(code: string): Promise<void> {
        try {
            console.log('🔄 Handling auth code, calling exchangeCodeForTokens');
            const tokens = await this.exchangeCodeForTokens(code);
            console.log('✅ Successfully exchanged code for tokens');
            await this.saveTokens(tokens);

            // Bring focus back to Obsidian
            this.focusObsidian();
        } catch (error) {
            console.error('❌ Token exchange failed:', error);
            throw error;
        }
    }

    private async exchangeCodeForTokens(code: string): Promise<OAuth2Tokens> {
        // Call our secure Netlify function instead of Google directly
        console.log('🔄 Calling Netlify function for token exchange');
        try {
            console.log('🔄 Sending request to:', 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/.netlify/functions/token-exchange');
            console.log('🔄 Request payload:', JSON.stringify({
                operation: 'exchange_code',
                code: code.substring(0, 10) + '...',  // Only log part of the code for security
                platform: 'desktop'
            }));

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
            console.log('🔄 Netlify response headers:', JSON.stringify(response.headers));

            if (response.status >= 400) {
                console.error('❌ Error response from Netlify:', response.status, response.text);
                throw new Error(`Netlify function returned error ${response.status}: ${response.text}`);
            }

            console.log('🔄 Netlify response body:', JSON.stringify(response.json).substring(0, 100) + '...');

            if (!response.json.access_token) {
                console.error('❌ No access token in response:', response.json);
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
            // Check for network errors
            if (error.name === 'NetworkError' || error.message?.includes('Failed to fetch')) {
                console.error('❌ Network error when calling Netlify function. Check your internet connection.');
                new Notice('Network error when calling Netlify function. Check your internet connection.');
            }
            throw error;
        }
    }

    async refreshAccessToken(): Promise<OAuth2Tokens> {
        if (!this.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            console.log('Refreshing access token...');

            // Call our secure Netlify function instead of Google directly
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
                console.error('Token refresh failed with status', response.status, response.text);
                throw new Error(`Token refresh failed with status ${response.status}: ${response.text}`);
            }

            if (!response.json || !response.json.access_token) {
                console.error('Token refresh response missing access_token:', response.json);
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

        // Save to plugin settings
        if (this.accessToken && this.refreshToken) {
            this.plugin.settings.oauth2Tokens = {
                access_token: this.accessToken,
                refresh_token: this.refreshToken,
                expiry_date: this.tokenExpiry || 0,
                token_type: tokens.token_type,
                scope: tokens.scope
            };
            await this.plugin.saveSettings();
        }
    }

    async loadSavedTokens(): Promise<boolean> {
        try {
            const tokens = this.plugin.settings.oauth2Tokens;
            if (tokens?.refresh_token && tokens?.access_token) {
                console.log('Loading saved tokens from settings');
                this.refreshToken = tokens.refresh_token;
                this.accessToken = tokens.access_token;
                this.tokenExpiry = tokens.expiry_date;

                // Validate token expiry
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
                        await this.plugin.saveSettings();
                        // Force re-authentication
                        new Notice('Your Google authentication has expired. Please reconnect.');
                        return false;
                    }
                }

                console.log('Successfully loaded saved tokens');
                return true;
            }
            console.log('No saved tokens found');
            return false;
        } catch (error) {
            console.error('Failed to load saved tokens:', error);
            // Clear any potentially corrupted tokens
            this.accessToken = null;
            this.refreshToken = null;
            this.tokenExpiry = null;
            this.plugin.settings.oauth2Tokens = undefined;
            await this.plugin.saveSettings();
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

        // Clear tokens from settings
        if (this.plugin.settings.oauth2Tokens) {
            this.plugin.settings.oauth2Tokens = undefined;
            await this.plugin.saveSettings();
            console.log('Cleared tokens from settings');
        }
    }

    // Add cleanup in onunload

    public async cleanup(): Promise<void> {
        console.log('🧹 Starting comprehensive cleanup process');

        // Clear all auth state from localStorage first
        if (Platform.isMobile) {
            localStorage.removeItem('gcal_auth_interrupted');
            localStorage.removeItem('gcal_auth_url');
            localStorage.removeItem('gcal_auth_in_progress');
            console.log('Mobile: Cleared all auth state from localStorage');
        }

        // Cleanup protocol handler
        if (this.protocolHandler) {
            console.log('Cleaning up protocol handler');
            try {
                // For mobile specifically, make sure we're aggressive about unregistering
                if (Platform.isMobile) {
                    try {
                        // First unregister attempt
                        this.plugin.app.unregisterProtocolHandler?.('auth/gcalsync');
                        console.log('Mobile: Explicitly unregistered auth/gcalsync handler (attempt 1)');

                        // Wait a moment to ensure unregistration is processed
                        await new Promise(resolve => setTimeout(resolve, 100));

                        // Second unregister attempt to be absolutely sure
                        this.plugin.app.unregisterProtocolHandler?.('auth/gcalsync');
                        console.log('Mobile: Explicitly unregistered auth/gcalsync handler (attempt 2)');

                        // Wait another moment
                        await new Promise(resolve => setTimeout(resolve, 100));
                    } catch (e) {
                        console.log('Error unregistering protocol handler:', e);
                    }
                }

                this.protocolHandler = null;
            } catch (e) {
                console.log('Error cleaning up protocol handler:', e);
            }
        } else if (Platform.isMobile) {
            // Even if we don't have a stored handler, try to unregister anyway
            try {
                this.plugin.app.unregisterProtocolHandler?.('auth/gcalsync');
                console.log('Mobile: Unregistered auth/gcalsync handler with no stored reference');
            } catch (e) {
                console.log('No handler to unregister');
            }
        }

        // First try to force close any existing servers on the auth port
        try {
            // On desktop platforms, we can use Node's net module for server cleanup
            if (Platform.isDesktop) {
                const { exec } = require('child_process');
                const net = require('net');

                // For Linux/macOS, try to kill any process on the port
                if (process.platform !== 'win32') {
                    try {
                        // This won't work in the sandboxed environment but might work in development
                        exec(`lsof -ti:${DESKTOP_PORT} | xargs kill -9`, (error: any) => {
                            if (error) {
                                console.log('Could not kill port with lsof (expected in sandboxed env):', error.message);
                            } else {
                                console.log(`Successfully killed process on port ${DESKTOP_PORT}`);
                            }
                        });
                    } catch (e) {
                        console.log('Error running kill command:', e);
                    }
                }

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

                // Add a delay to allow port to be fully released
                await new Promise(resolve => setTimeout(resolve, 100));

                // Make one more attempt with another client
                const verificationClient = new net.Socket();
                await new Promise<void>(resolve => {
                    verificationClient.once('error', () => {
                        console.log('Verification failed - port seems to be closed (good)');
                        resolve();
                    });
                    verificationClient.once('connect', () => {
                        console.log('Verification connect succeeded - port still open, forcing close');
                        verificationClient.destroy();
                        resolve();
                    });
                    verificationClient.connect(DESKTOP_PORT, DESKTOP_HOST);

                    // Ensure we resolve even if nothing happens
                    setTimeout(resolve, 500);
                });
            }
        } catch (e) {
            console.log('Error during server cleanup:', e);
        }

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

        // Bring focus back to Obsidian after cleanup
        setTimeout(() => this.focusObsidian(), 500);

        console.log('🧹 Cleanup process completed');
    }

    isAuthenticated(): boolean {
        // First check memory
        if (this.accessToken && this.refreshToken) {
            return true;
        }
        // Then check settings
        const tokens = this.plugin.settings.oauth2Tokens;
        return !!(tokens?.access_token && tokens?.refresh_token);
    }

    // Helper method to bring focus back to Obsidian
    private focusObsidian(): void {
        try {
            console.log('Attempting to bring focus back to Obsidian');

            // For desktop, we can use Electron's API
            if (Platform.isDesktop) {
                try {
                    // Modern Electron API doesn't use remote module
                    const electron = require('electron');

                    // Try both remote (older Electron) and current API
                    if (electron.remote && electron.remote.getCurrentWindow) {
                        const win = electron.remote.getCurrentWindow();
                        if (win) {
                            if (win.isMinimized()) win.restore();
                            win.focus();
                            console.log('Successfully focused Obsidian window using Electron remote API');
                            return;
                        }
                    } else if (electron.app && electron.BrowserWindow) {
                        // Current API approach
                        const windows = electron.BrowserWindow.getAllWindows();
                        if (windows.length > 0) {
                            const mainWindow = windows[0];
                            if (mainWindow.isMinimized()) mainWindow.restore();
                            mainWindow.focus();
                            console.log('Successfully focused Obsidian window using current Electron API');
                            return;
                        }
                    }
                } catch (e) {
                    console.log('Error using Electron API to focus window:', e);
                }
            }

            // Fallback method that works in most browsers
            window.focus();
            document.body.focus();

            // Try to focus the main app container
            const appContainer = document.querySelector('.app-container');
            if (appContainer && appContainer instanceof HTMLElement) {
                appContainer.focus();
            }

            console.log('Attempted to focus Obsidian using DOM methods');
        } catch (e) {
            console.log('Error trying to focus Obsidian:', e);
        }
    }

    // Add this debug method to help diagnose mobile redirect issues
    public dumpOAuthDebugInfo(): string {
        const debugInfo: Record<string, any> = {
            runtime: {
                platform: Platform.isDesktop ? 'Desktop' : 'Mobile',
                version: this.plugin.manifest.version,
                authenticated: this.isAuthenticated(),
                mobileAuthInitiated: this.plugin.mobileAuthInitiated,
                protocolHandlerActive: !!this.protocolHandler,
                tokensPresent: {
                    accessToken: !!this.accessToken,
                    refreshToken: !!this.refreshToken,
                    tokenExpiry: this.tokenExpiry ? new Date(this.tokenExpiry).toISOString() : null
                }
            },
            localStorage: {}
        };

        // Collect all relevant localStorage items
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes('gcal')) {
                try {
                    const value = localStorage.getItem(key);
                    debugInfo.localStorage[key] = value;
                } catch (e) {
                    debugInfo.localStorage[key] = `[Error reading: ${e.message}]`;
                }
            }
        }

        // Return formatted debug info
        return JSON.stringify(debugInfo, null, 2);
    }

    // Helper function to log all important state
    public async logOAuthState(context: string): Promise<void> {
        console.log(`🔍 OAUTH STATE [${context}]:`);
        console.log(this.dumpOAuthDebugInfo());

        // Log if protocol handler registration is available 
        console.log('Protocol handler registration available:',
            typeof this.plugin.registerObsidianProtocolHandler === 'function');
        console.log('Is protocol handler registered:', !!this.protocolHandler);
        console.log('Global disable flag:', !!(window as any).__GCAL_DISABLE_PROTOCOL_HANDLERS);

        // Track window.location for debugging
        console.log('Current URL:', window.location.href);
    }

    // Helper method to safely enable protocol handlers for auth flow
    private safelyEnableProtocolHandlers(): void {
        if (Platform.isMobile && (window as any).__GCAL_SYNC_STATE) {
            // Only enable for intentional auth flows
            if (this.plugin.mobileAuthInitiated) {
                console.log('🔓 Safely enabling protocol handlers for auth flow');

                // Enable protocol handlers
                (window as any).__GCAL_SYNC_STATE.disableProtocolHandlers = false;

                // Check if we have a pending handler that needs to be registered
                const pendingHandler = (window as any).__GCAL_SYNC_STATE.pendingHandler;
                if (pendingHandler &&
                    pendingHandler.protocol === 'auth/gcalsync' &&
                    pendingHandler.handler &&
                    typeof pendingHandler.handler === 'function') {

                    try {
                        // Register the pending handler now that it's safe
                        this.plugin.registerObsidianProtocolHandler(pendingHandler.protocol, pendingHandler.handler);
                        console.log('✅ Successfully registered pending protocol handler');

                        // Clear the pending handler
                        (window as any).__GCAL_SYNC_STATE.pendingHandler = null;
                    } catch (e) {
                        console.error('Error registering pending handler:', e);
                    }
                }
            } else {
                console.log('⚠️ Not enabling protocol handlers - no explicit auth flow initiated');
            }
        }
    }

    private async completeOAuth(response: any): Promise<void> {
        console.log('🏁 Completing OAuth flow');
        // Reset flags
        if (this.plugin) {
            this.plugin.mobileAuthInitiated = false;
        }

        // Re-disable protocol handlers after auth flow completes
        if (Platform.isMobile && (window as any).__GCAL_SYNC_STATE) {
            console.log('🔒 Re-disabling protocol handlers after auth completion');
            (window as any).__GCAL_SYNC_STATE.disableProtocolHandlers = true;
        }

        try {
            // Exchange code for tokens
            console.log('Exchanging code for tokens');
            localStorage.removeItem('gcal_auth_in_progress');
            localStorage.setItem('gcal_auth_completed', 'true');

            // Store the tokens (implementation depends on your token handling)
            // this.storeTokens(response.tokens);

            // Notify UI that auth is complete
            console.log('Auth flow completed successfully');
        } catch (error) {
            console.error('Error completing OAuth flow:', error);
            localStorage.removeItem('gcal_auth_in_progress');
            localStorage.setItem('gcal_auth_error', String(error));
        }
    }
}
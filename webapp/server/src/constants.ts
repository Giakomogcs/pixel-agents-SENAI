/**
 * Centralized constants for the webapp server.
 */

/** OpenCode provider id for GitHub Copilot (device flow auth). */
export const COPILOT_PROVIDER_ID = 'github-copilot';

/** Default model when sending prompts via Copilot. */
export const COPILOT_DEFAULT_MODEL = 'claude-sonnet-4';

/** Polling interval for OAuth callback (ms). */
export const OAUTH_POLL_INTERVAL_MS = 5000;

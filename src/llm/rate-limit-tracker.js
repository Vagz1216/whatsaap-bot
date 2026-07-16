import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Tracks rate-limited LLM providers and enforces cooldown periods.
 * Providers that hit 429 errors are blacklisted for a configurable duration.
 */
class RateLimitTracker {
  constructor() {
    /** @type {Map<string, number>} providerId → cooldown expiry timestamp */
    this.cooldowns = new Map();
  }

  /**
   * Record a rate-limit failure for a provider and place it in cooldown.
   * @param {string} providerId - The LLM provider identifier (e.g. 'azure', 'groq')
   */
  recordFailure(providerId) {
    const cooldownPeriod = 60 * 60 * 1000; // 1 hour
    this.cooldowns.set(providerId, Date.now() + cooldownPeriod);
    logger.warn(
      { kind: 'provider_cooldown', provider: providerId, cooldown_ms: cooldownPeriod },
      `Provider ${providerId} placed in cooldown for 1 hour`
    );
  }

  /**
   * Check whether a provider is available (not in cooldown).
   * @param {string} providerId - The LLM provider identifier
   * @returns {boolean} True if the provider can be used
   */
  isAvailable(providerId) {
    if (!this.cooldowns.has(providerId)) {
      return true;
    }
    const expiry = this.cooldowns.get(providerId);
    if (Date.now() > expiry) {
      this.cooldowns.delete(providerId);
      return true;
    }
    return false;
  }
}

export default new RateLimitTracker();

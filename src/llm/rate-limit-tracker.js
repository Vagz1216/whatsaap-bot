class RateLimitTracker {
  constructor() {
    this.cooldowns = new Map();
  }

  recordFailure(providerId) {
    const cooldownPeriod = 60 * 60 * 1000; // 1 hour
    this.cooldowns.set(providerId, Date.now() + cooldownPeriod);
    console.warn(`[RateLimitTracker] Provider ${providerId} placed in cooldown for 1 hour.`);
  }

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

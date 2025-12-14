/**
 * SDF ADB Server - Port Pool Manager
 * Manages dynamic port allocation for ADB relay tunnels
 */

class PortPool {
    constructor(start = 30001, end = 30999) {
        this.start = start;
        this.end = end;
        this.available = new Set();
        this.allocated = new Map(); // port -> { sessionId, deviceSerial, providerId, allocatedAt }

        // Initialize available ports
        for (let i = start; i <= end; i++) {
            this.available.add(i);
        }

        console.log(`Port pool initialized: ${start}-${end} (${this.available.size} ports)`);
    }

    /**
     * Allocate a port for a session
     */
    allocate(sessionId, deviceSerial, providerId, ttl = 3600000) {
        if (this.available.size === 0) {
            return null;
        }

        const port = this.available.values().next().value;
        this.available.delete(port);

        this.allocated.set(port, {
            sessionId,
            deviceSerial,
            providerId,
            allocatedAt: Date.now(),
            expiresAt: Date.now() + ttl,
            providerConnected: false,
            clientConnected: false
        });

        return port;
    }

    /**
     * Allocate a specific port
     */
    allocateSpecific(port, sessionId, deviceSerial, providerId, ttl = 3600000) {
        if (!this.available.has(port)) {
            return null;
        }

        this.available.delete(port);

        this.allocated.set(port, {
            sessionId,
            deviceSerial,
            providerId,
            allocatedAt: Date.now(),
            expiresAt: Date.now() + ttl,
            providerConnected: false,
            clientConnected: false
        });

        return port;
    }

    /**
     * Release a port
     */
    release(port) {
        if (this.allocated.has(port)) {
            this.allocated.delete(port);
            this.available.add(port);
            return true;
        }
        return false;
    }

    /**
     * Get port allocation info
     */
    getInfo(port) {
        return this.allocated.get(port);
    }

    /**
     * Update port status
     */
    updateStatus(port, updates) {
        const info = this.allocated.get(port);
        if (info) {
            Object.assign(info, updates);
        }
    }

    /**
     * Find port by session ID
     */
    findBySession(sessionId) {
        for (const [port, info] of this.allocated) {
            if (info.sessionId === sessionId) {
                return port;
            }
        }
        return null;
    }

    /**
     * Cleanup expired allocations
     */
    cleanupExpired() {
        const now = Date.now();
        const expired = [];

        for (const [port, info] of this.allocated) {
            if (info.expiresAt < now) {
                expired.push(port);
            }
        }

        for (const port of expired) {
            this.release(port);
        }

        return expired.length;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            total: this.end - this.start + 1,
            available: this.available.size,
            allocated: this.allocated.size
        };
    }
}

module.exports = PortPool;

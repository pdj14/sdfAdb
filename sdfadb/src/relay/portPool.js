/**
 * SDF ADB - Dynamic Port Pool Manager
 */

class PortPool {
    constructor(start = 30001, end = 30999) {
        this.start = start;
        this.end = end;
        this.available = new Set();
        this.allocated = new Map(); // port -> { providerId, deviceSerial, allocatedAt }

        // Initialize available ports
        for (let i = start; i <= end; i++) {
            this.available.add(i);
        }
    }

    /**
     * Allocate a port for a connection
     */
    allocate(providerId, deviceSerial, ttl = 300000) {
        if (this.available.size === 0) {
            return null;
        }

        const port = this.available.values().next().value;
        this.available.delete(port);

        this.allocated.set(port, {
            providerId,
            deviceSerial,
            allocatedAt: Date.now(),
            expiresAt: Date.now() + ttl
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
     * Get port info
     */
    getInfo(port) {
        return this.allocated.get(port);
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
     * Get stats
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

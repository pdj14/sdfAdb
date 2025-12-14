/**
 * SDF ADB - ADB Client Wrapper
 * Wraps @devicefarmer/adbkit for easier use
 */

const adbkit = require('@devicefarmer/adbkit');
const chalk = require('chalk');

// Handle different adbkit export formats
const Adb = adbkit.Adb || adbkit.default || adbkit;

class AdbClient {
    constructor() {
        // Try different ways to create client
        if (typeof Adb.createClient === 'function') {
            this.client = Adb.createClient();
        } else if (typeof adbkit.createClient === 'function') {
            this.client = adbkit.createClient();
        } else {
            throw new Error('Cannot find adbkit createClient function. Check adbkit version.');
        }
    }

    /**
     * List all connected devices
     */
    async listDevices() {
        try {
            const devices = await this.client.listDevices();
            const result = [];

            for (const device of devices) {
                if (device.type === 'device') {
                    try {
                        const props = await this.getDeviceProps(device.id);
                        result.push({
                            serial: device.id,
                            type: device.type,
                            model: props.model || 'Unknown',
                            manufacturer: props.manufacturer || 'Unknown'
                        });
                    } catch {
                        result.push({
                            serial: device.id,
                            type: device.type,
                            model: 'Unknown',
                            manufacturer: 'Unknown'
                        });
                    }
                }
            }

            return result;
        } catch (error) {
            console.error(chalk.red('Failed to list devices:'), error.message);
            return [];
        }
    }

    /**
     * Get device properties
     */
    async getDeviceProps(serial) {
        const device = this.client.getDevice(serial);
        const props = await device.getProperties();
        return {
            model: props['ro.product.model'],
            manufacturer: props['ro.product.manufacturer'],
            android: props['ro.build.version.release']
        };
    }

    /**
     * Track device changes
     */
    async trackDevices(callback) {
        const tracker = await this.client.trackDevices();

        tracker.on('add', device => {
            callback('add', device);
        });

        tracker.on('remove', device => {
            callback('remove', device);
        });

        tracker.on('change', device => {
            callback('change', device);
        });

        return tracker;
    }

    /**
     * Forward local port to device
     */
    async forward(serial, localPort, remotePort) {
        const device = this.client.getDevice(serial);
        await device.forward(`tcp:${localPort}`, `tcp:${remotePort}`);
    }

    /**
     * Enable TCP mode on device
     */
    async tcpip(serial, port = 5555) {
        const device = this.client.getDevice(serial);
        return await device.tcpip(port);
    }

    /**
     * Connect to remote device
     */
    async connect(host, port = 5555) {
        return await this.client.connect(`${host}:${port}`);
    }

    /**
     * Disconnect from remote device
     */
    async disconnect(host, port = 5555) {
        return await this.client.disconnect(`${host}:${port}`);
    }

    /**
     * Create raw socket connection to device
     */
    async createConnection(serial, type, target) {
        const device = this.client.getDevice(serial);
        return device.createConnection(type, target);
    }
}

module.exports = AdbClient;

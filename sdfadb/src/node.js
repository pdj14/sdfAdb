/**
 * SDF ADB - Hybrid Node
 * Runs as both Provider and Controller simultaneously
 */

const { Provider } = require('./provider');
const { Controller, connect } = require('./controller');
const chalk = require('chalk');

class HybridNode {
    constructor(options) {
        this.relay = options.relay;
        this.shareDevices = options.shareDevices || [];
        this.mounts = options.mounts || [];
        this.provider = null;
        this.connections = new Map();
    }

    async start() {
        console.log(chalk.bold('\n🔗 SDF ADB Hybrid Node\n'));

        // Start provider if sharing devices
        if (this.shareDevices.length > 0 || !this.shareDevices.length) {
            await this.startProvider();
        }

        // Mount remote devices
        for (const mount of this.mounts) {
            await this.mountDevice(mount);
        }

        console.log(chalk.dim('\nNode running... (Ctrl+C to stop)'));

        process.on('SIGINT', () => {
            console.log(chalk.yellow('\nShutting down...'));
            this.shutdown();
            process.exit(0);
        });
    }

    async startProvider() {
        console.log(chalk.cyan('Starting Provider...'));

        this.provider = new Provider({
            relay: this.relay,
            devices: this.shareDevices.length > 0 ? this.shareDevices : null
        });

        // Don't await - run in background
        this.provider.start().catch(err => {
            console.error(chalk.red('Provider error:'), err.message);
        });
    }

    async mountDevice(mount) {
        console.log(chalk.cyan(`Mounting ${mount.device} from ${mount.provider} → localhost:${mount.port}`));

        try {
            await connect({
                relay: this.relay,
                providerId: mount.provider,
                deviceSerial: mount.device,
                localPort: mount.port
            });

            this.connections.set(mount.port, mount);

        } catch (error) {
            console.error(chalk.red(`Failed to mount ${mount.device}:`), error.message);
        }
    }

    shutdown() {
        // Close all connections
        for (const [port, mount] of this.connections) {
            console.log(chalk.dim(`Closing connection on port ${port}`));
        }
    }
}

async function startNode(options) {
    const node = new HybridNode(options);
    await node.start();
}

module.exports = { HybridNode, startNode };

/**
 * SDF ADB - Hybrid Node
 * Runs as both Provider and Controller simultaneously
 */

const { Provider } = require('./provider');
const { connect, disconnect } = require('./controller');
const chalk = require('chalk');

class HybridNode {
    constructor(options) {
        this.relay = options.relay;
        this.shareDevices = options.shareDevices || [];
        this.mounts = options.mounts || [];
        this.provider = null;
        this.providerSessions = new Map();
        this.controllerSessions = new Map();
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

        this.providerSessions.set('local-provider', {
            relay: this.relay,
            sharedDevices: this.shareDevices,
            startedAt: new Date().toISOString()
        });
    }

    async mountDevice(mount) {
        console.log(chalk.cyan(`Mounting ${mount.device} from ${mount.provider} → localhost:${mount.port}`));

        try {
            const mounted = await connect({
                relay: this.relay,
                providerId: mount.provider,
                deviceSerial: mount.device,
                localPort: Number.isInteger(mount.port) ? mount.port : undefined
            });

            const localPort = mounted?.localPort || mount.port;
            this.controllerSessions.set(localPort, {
                ...mount,
                localPort,
                mountedAt: new Date().toISOString()
            });

        } catch (error) {
            console.error(chalk.red(`Failed to mount ${mount.device}:`), error.message);
        }
    }

    async shutdown() {
        // Close controller-side sessions
        for (const [port] of this.controllerSessions) {
            console.log(chalk.dim(`Closing controller session on port ${port}`));
            try {
                await disconnect({ port, all: false });
            } catch {
                // best effort
            }
        }

        // Close provider-side session info (provider process follows main process exit)
        for (const [key] of this.providerSessions) {
            console.log(chalk.dim(`Stopping provider session ${key}`));
        }
    }
}

async function startNode(options) {
    const node = new HybridNode(options);
    await node.start();
}

module.exports = { HybridNode, startNode };

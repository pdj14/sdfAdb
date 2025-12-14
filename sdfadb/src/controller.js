/**
 * SDF ADB - Controller
 * Connects to remote devices via relay or direct connection
 */

const WebSocket = require('ws');
const net = require('net');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');
const { generateId } = require('./utils/helpers');

class Controller {
    constructor(options) {
        this.relay = options.relay;
        this.controllerId = generateId('CTRL');
        this.ws = null;
        this.connections = new Map(); // localPort -> connection info
    }

    async connectRelay() {
        return new Promise((resolve, reject) => {
            const wsUrl = `ws://${this.relay}`;
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
    }

    send(data) {
        return new Promise((resolve) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(data));

                this.ws.once('message', (msg) => {
                    resolve(JSON.parse(msg.toString()));
                });
            }
        });
    }
}

/**
 * List available devices
 */
async function list(options) {
    const spinner = ora('Fetching device list...').start();

    try {
        const controller = new Controller(options);
        await controller.connectRelay();

        const response = await controller.send({
            type: 'list_devices'
        });

        spinner.stop();

        if (!response.devices || response.devices.length === 0) {
            console.log(chalk.yellow('No devices available'));
            process.exit(0);
        }

        const table = new Table({
            head: ['Provider', 'Device', 'Model', 'Status'].map(h => chalk.cyan(h)),
            style: { head: [], border: [] }
        });

        for (const device of response.devices) {
            table.push([
                device.providerId,
                device.serial,
                device.model || '-',
                chalk.green('online')
            ]);
        }

        console.log('\n' + chalk.bold('Available Devices:'));
        console.log(table.toString());

        controller.ws.close();

    } catch (error) {
        spinner.fail('Failed to fetch devices');
        console.error(chalk.red(error.message));
        process.exit(1);
    }
}

/**
 * Connect to remote device (Direct or Relay mode)
 */
async function connect(options) {
    if (options.direct) {
        await connectDirect(options);
    } else if (options.relay) {
        await connectRelay(options);
    }
}

/**
 * Direct connection to provider
 */
async function connectDirect(options) {
    const spinner = ora('Connecting directly to provider...').start();

    try {
        const [host, port] = options.direct.split(':');
        const providerPort = parseInt(port) || 21121;

        // Connect to provider's direct server
        const providerConn = await new Promise((resolve, reject) => {
            const conn = net.createConnection({ host, port: providerPort }, () => {
                resolve(conn);
            });
            conn.on('error', reject);
        });

        // Send device request
        providerConn.write(JSON.stringify({
            deviceSerial: options.deviceSerial
        }));

        // Wait for response
        const response = await new Promise((resolve, reject) => {
            providerConn.once('data', (data) => {
                try {
                    resolve(JSON.parse(data.toString()));
                } catch (e) {
                    reject(new Error('Invalid response from provider'));
                }
            });
            providerConn.once('error', reject);
        });

        if (!response.success) {
            throw new Error(response.error || 'Connection failed');
        }

        spinner.succeed(`Connected to ${options.deviceSerial} via direct connection`);

        // Create local server for ADB to connect
        const server = net.createServer((socket) => {
            // Bridge to provider connection
            socket.pipe(providerConn);
            providerConn.pipe(socket);

            socket.on('error', () => providerConn.end());
            providerConn.on('error', () => socket.end());
        });

        server.listen(options.localPort, '127.0.0.1', () => {
            console.log(chalk.green(`\n✓ Connected via: Direct P2P`));
            console.log(chalk.green(`✓ Provider: ${host}:${providerPort}`));
            console.log(chalk.green(`✓ Device: ${response.device?.model || options.deviceSerial}`));
            console.log(chalk.green(`✓ Local port: localhost:${options.localPort}`));
            console.log(chalk.dim('\nYou can now use:'));
            console.log(chalk.white(`  adb connect localhost:${options.localPort}`));
            console.log(chalk.white(`  adb -s localhost:${options.localPort} shell`));
            console.log(chalk.dim('\nPress Ctrl+C to disconnect'));
        });

        // Handle Ctrl+C
        process.on('SIGINT', () => {
            console.log(chalk.yellow('\nDisconnecting...'));
            server.close();
            providerConn.end();
            process.exit(0);
        });

    } catch (error) {
        spinner.fail('Direct connection failed');

        // If auto mode, try relay
        if (options.auto && options.relay) {
            console.log(chalk.yellow('Falling back to relay connection...'));
            await connectRelay(options);
        } else {
            console.error(chalk.red(error.message));
            process.exit(1);
        }
    }
}

/**
 * Relay connection to provider
 */
async function connectRelay(options) {
    const spinner = ora('Connecting via relay...').start();

    try {
        const controller = new Controller({ relay: options.relay });
        await controller.connectRelay();

        // Request connection
        const response = await controller.send({
            type: 'connect_device',
            controllerId: controller.controllerId,
            providerId: options.providerId,
            deviceSerial: options.deviceSerial
        });

        if (!response.success) {
            throw new Error(response.error || 'Connection failed');
        }

        spinner.succeed(`Connected to ${options.deviceSerial} via relay`);

        // Create local server for ADB to connect
        const server = net.createServer((socket) => {
            // Connect to relay port and bridge
            const relayConn = net.createConnection({
                host: options.relay.split(':')[0],
                port: response.relayPort
            });

            socket.pipe(relayConn);
            relayConn.pipe(socket);

            socket.on('error', () => relayConn.end());
            relayConn.on('error', () => socket.end());
        });

        server.listen(options.localPort, '127.0.0.1', () => {
            console.log(chalk.green(`\n✓ Connected via: Relay`));
            console.log(chalk.green(`✓ Relay port: ${response.relayPort}`));
            console.log(chalk.green(`✓ Local port: localhost:${options.localPort}`));
            console.log(chalk.dim('\nYou can now use:'));
            console.log(chalk.white(`  adb connect localhost:${options.localPort}`));
            console.log(chalk.white(`  adb -s localhost:${options.localPort} shell`));
            console.log(chalk.dim('\nPress Ctrl+C to disconnect'));
        });

        // Save connection info
        controller.connections.set(options.localPort, {
            server,
            providerId: options.providerId,
            deviceSerial: options.deviceSerial
        });

        // Handle Ctrl+C
        process.on('SIGINT', () => {
            console.log(chalk.yellow('\nDisconnecting...'));
            server.close();
            controller.ws.close();
            process.exit(0);
        });

    } catch (error) {
        spinner.fail('Failed to connect');
        console.error(chalk.red(error.message));
        process.exit(1);
    }
}

/**
 * Disconnect from device(s)
 */
async function disconnect(options) {
    if (options.all) {
        console.log(chalk.yellow('Disconnecting all...'));
        // TODO: Track and close all connections
    } else if (options.port) {
        console.log(chalk.yellow(`Disconnecting port ${options.port}...`));
        // TODO: Close specific connection
    } else {
        console.log(chalk.red('Please specify --port or --all'));
        process.exit(1);
    }
}

module.exports = { Controller, list, connect, disconnect };


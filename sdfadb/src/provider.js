/**
 * SDF ADB - Provider
 * Shares local ADB devices with remote controllers
 */

const WebSocket = require('ws');
const net = require('net');
const chalk = require('chalk');
const ora = require('ora');
const AdbClient = require('./adb/client');
const { generateId } = require('./utils/helpers');

class Provider {
    constructor(options) {
        this.relay = options.relay;
        this.direct = options.direct || false;
        this.directPort = options.directPort || 21121;
        this.deviceFilter = options.devices || null;
        this.allowedUsers = options.allowedUsers || null;
        this.adb = new AdbClient();
        this.providerId = generateId('PROV');
        this.ws = null;
        this.tunnels = new Map(); // port -> tunnel
        this.directServer = null;
        this.directConnections = new Map(); // socket -> { device, adbConn }
    }

    async start() {
        const spinner = ora('Starting provider...').start();

        try {
            // Get local devices
            const devices = await this.getDevices();

            if (this.direct) {
                // Direct mode: start TCP server
                await this.startDirectServer();
                spinner.succeed('Direct mode started');
            } else {
                // Relay mode: connect to relay server
                await this.connectRelay();
                spinner.succeed('Connected to relay server');
                await this.register(devices);
            }

            console.log(chalk.green(`\n✓ Provider ID: ${chalk.bold(this.providerId)}`));
            console.log(chalk.cyan('\nLocal Devices:'));

            for (const device of devices) {
                console.log(`  ${chalk.green('✓')} ${device.serial} (${device.model}) - online`);
            }

            if (this.direct) {
                console.log(chalk.yellow(`\n📡 Direct Mode`));
                console.log(chalk.white(`   Listening on: 0.0.0.0:${this.directPort}`));
                console.log(chalk.dim(`\nController can connect with:`));
                console.log(chalk.white(`   sdfadb connect --direct <your-ip>:${this.directPort} --device <serial> --port 5555`));
            }

            console.log(chalk.dim('\nWaiting for connections... (Ctrl+C to stop)'));

            // Track device changes
            await this.trackDevices();

        } catch (error) {
            spinner.fail('Failed to start provider');
            console.error(chalk.red(error.message));
            process.exit(1);
        }
    }

    async startDirectServer() {
        return new Promise((resolve, reject) => {
            this.directServer = net.createServer(async (socket) => {
                console.log(chalk.cyan(`\nDirect connection from ${socket.remoteAddress}`));

                // Protocol: first message is JSON with device serial
                socket.once('data', async (data) => {
                    try {
                        const request = JSON.parse(data.toString());
                        const { deviceSerial } = request;

                        console.log(chalk.dim(`  Requested device: ${deviceSerial}`));

                        // Verify device exists
                        const devices = await this.getDevices();
                        const device = devices.find(d => d.serial === deviceSerial);

                        if (!device) {
                            socket.write(JSON.stringify({ success: false, error: 'Device not found' }));
                            socket.end();
                            return;
                        }

                        // Enable TCP mode on device
                        try {
                            await this.adb.tcpip(deviceSerial, 5555);
                            await new Promise(r => setTimeout(r, 1000)); // Wait for device
                        } catch (e) {
                            // May already be in TCP mode
                        }

                        // Send success response
                        socket.write(JSON.stringify({
                            success: true,
                            device: {
                                serial: device.serial,
                                model: device.model
                            }
                        }));

                        // Now bridge this socket to local ADB
                        // Connect to local ADB server
                        const adbConn = net.createConnection({ port: 5037 }, () => {
                            console.log(chalk.green(`  ✓ Bridge established for ${deviceSerial}`));

                            // Forward ADB host command to select device
                            const hostCmd = `host:transport:${deviceSerial}`;
                            const cmdLen = hostCmd.length.toString(16).padStart(4, '0');
                            adbConn.write(`${cmdLen}${hostCmd}`);
                        });

                        // Bridge data
                        socket.pipe(adbConn);
                        adbConn.pipe(socket);

                        this.directConnections.set(socket, { deviceSerial, adbConn });

                        socket.on('close', () => {
                            console.log(chalk.yellow(`  Connection closed for ${deviceSerial}`));
                            adbConn.end();
                            this.directConnections.delete(socket);
                        });

                        socket.on('error', () => {
                            adbConn.end();
                            this.directConnections.delete(socket);
                        });

                    } catch (error) {
                        console.error(chalk.red('  Invalid request:', error.message));
                        socket.end();
                    }
                });
            });

            this.directServer.on('error', reject);

            this.directServer.listen(this.directPort, '0.0.0.0', () => {
                resolve();
            });
        });
    }

    async connectRelay() {
        return new Promise((resolve, reject) => {
            const wsUrl = `ws://${this.relay}`;
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                resolve();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(JSON.parse(data.toString()));
            });

            this.ws.on('error', (error) => {
                reject(error);
            });

            this.ws.on('close', () => {
                console.log(chalk.yellow('\nDisconnected from relay server'));
            });
        });
    }

    async getDevices() {
        const devices = await this.adb.listDevices();

        if (this.deviceFilter) {
            return devices.filter(d => this.deviceFilter.includes(d.serial));
        }

        return devices;
    }

    async register(devices) {
        this.send({
            type: 'register_provider',
            providerId: this.providerId,
            devices: devices.map(d => ({
                serial: d.serial,
                model: d.model,
                manufacturer: d.manufacturer
            }))
        });
    }

    async trackDevices() {
        await this.adb.trackDevices(async (event, device) => {
            console.log(chalk.dim(`Device ${event}: ${device.id}`));

            if (!this.direct) {
                // Update relay with new device list
                const devices = await this.getDevices();
                this.send({
                    type: 'update_devices',
                    providerId: this.providerId,
                    devices: devices.map(d => ({
                        serial: d.serial,
                        model: d.model,
                        manufacturer: d.manufacturer
                    }))
                });
            }
        });
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'connect_request':
                this.handleConnectRequest(msg);
                break;
            case 'disconnect_request':
                this.handleDisconnectRequest(msg);
                break;
            default:
                console.log(chalk.dim(`Unknown message: ${msg.type}`));
        }
    }

    async handleConnectRequest(msg) {
        const { controllerId, deviceSerial, relayPort } = msg;

        console.log(chalk.cyan(`\nConnect request: ${deviceSerial} → Controller ${controllerId}`));

        try {
            // Create TCP tunnel from relay port to local ADB
            await this.createTunnel(deviceSerial, relayPort);

            this.send({
                type: 'connect_response',
                controllerId,
                deviceSerial,
                success: true
            });

            console.log(chalk.green(`  ✓ Tunnel established on port ${relayPort}`));

        } catch (error) {
            this.send({
                type: 'connect_response',
                controllerId,
                deviceSerial,
                success: false,
                error: error.message
            });

            console.log(chalk.red(`  ✗ Failed: ${error.message}`));
        }
    }

    async createTunnel(deviceSerial, relayPort) {
        // Enable TCP mode on device if needed
        try {
            await this.adb.tcpip(deviceSerial, 5555);
        } catch {
            // Already in TCP mode or not needed
        }

        // Connect back to relay's assigned port and bridge to local ADB
        const tunnel = net.createConnection({
            host: this.relay.split(':')[0],
            port: relayPort
        });

        // Bridge to local ADB daemon
        const adbPort = 5037; // Local ADB server port
        const adbConn = net.createConnection({ port: adbPort });

        tunnel.pipe(adbConn);
        adbConn.pipe(tunnel);

        this.tunnels.set(relayPort, { tunnel, adbConn, deviceSerial });
    }

    handleDisconnectRequest(msg) {
        const { relayPort } = msg;
        const tunnel = this.tunnels.get(relayPort);

        if (tunnel) {
            tunnel.tunnel.end();
            tunnel.adbConn.end();
            this.tunnels.delete(relayPort);
            console.log(chalk.yellow(`  Tunnel closed on port ${relayPort}`));
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
}

async function provide(options) {
    const provider = new Provider(options);
    await provider.start();
}

module.exports = { Provider, provide };

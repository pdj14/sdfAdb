/**
 * SDF ADB - Relay Server
 * Handles signal/discovery and TCP port bridging
 */

const WebSocket = require('ws');
const net = require('net');
const chalk = require('chalk');
const PortPool = require('./portPool');

class RelayServer {
    constructor(options) {
        this.port = options.port || 21120;
        this.portPool = new PortPool(options.portStart || 30001, options.portEnd || 30999);
        this.providers = new Map(); // providerId -> { ws, devices }
        this.controllers = new Map(); // controllerId -> ws
        this.tunnels = new Map(); // port -> { provider, controller, connections }
    }

    start() {
        // WebSocket signal server
        this.wss = new WebSocket.Server({ port: this.port });

        console.log(chalk.green(`✓ Relay server started on port ${this.port}`));
        console.log(chalk.green(`✓ Signal server: ws://0.0.0.0:${this.port}`));
        console.log(chalk.green(`✓ Port pool: ${this.portPool.start}-${this.portPool.end}`));
        console.log(chalk.dim('\nWaiting for connections...'));

        this.wss.on('connection', (ws, req) => {
            const clientIp = req.socket.remoteAddress;
            console.log(chalk.dim(`Client connected: ${clientIp}`));

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this.handleMessage(ws, msg, clientIp);
                } catch (error) {
                    console.error(chalk.red('Invalid message:', error.message));
                }
            });

            ws.on('close', () => {
                this.handleDisconnect(ws);
            });
        });
    }

    handleMessage(ws, msg, clientIp) {
        switch (msg.type) {
            case 'register_provider':
                this.registerProvider(ws, msg, clientIp);
                break;
            case 'update_devices':
                this.updateProviderDevices(msg);
                break;
            case 'list_devices':
                this.listDevices(ws);
                break;
            case 'connect_device':
                this.connectDevice(ws, msg);
                break;
            default:
                console.log(chalk.dim(`Unknown message type: ${msg.type}`));
        }
    }

    registerProvider(ws, msg, clientIp) {
        const { providerId, devices } = msg;

        this.providers.set(providerId, {
            ws,
            devices,
            ip: clientIp,
            registeredAt: new Date()
        });

        ws._providerId = providerId;

        console.log(chalk.green(`Provider registered: ${providerId} (${devices.length} devices)`));

        ws.send(JSON.stringify({
            type: 'registered',
            providerId
        }));
    }

    updateProviderDevices(msg) {
        const { providerId, devices } = msg;
        const provider = this.providers.get(providerId);

        if (provider) {
            provider.devices = devices;
            console.log(chalk.dim(`Provider ${providerId} updated: ${devices.length} devices`));
        }
    }

    listDevices(ws) {
        const devices = [];

        for (const [providerId, provider] of this.providers) {
            for (const device of provider.devices) {
                devices.push({
                    providerId,
                    ...device
                });
            }
        }

        ws.send(JSON.stringify({
            type: 'device_list',
            devices
        }));
    }

    async connectDevice(ws, msg) {
        const { controllerId, providerId, deviceSerial } = msg;

        const provider = this.providers.get(providerId);
        if (!provider) {
            ws.send(JSON.stringify({
                type: 'connect_response',
                success: false,
                error: 'Provider not found'
            }));
            return;
        }

        // Allocate port for this connection
        const port = this.portPool.allocate(providerId, deviceSerial);
        if (!port) {
            ws.send(JSON.stringify({
                type: 'connect_response',
                success: false,
                error: 'No ports available'
            }));
            return;
        }

        console.log(chalk.cyan(`Connection: ${controllerId} → ${providerId}/${deviceSerial} (port ${port})`));

        // Create TCP bridge server
        this.createBridge(port, providerId, deviceSerial, ws, provider.ws);

        // Notify provider to connect
        provider.ws.send(JSON.stringify({
            type: 'connect_request',
            controllerId,
            deviceSerial,
            relayPort: port
        }));

        // Respond to controller
        ws.send(JSON.stringify({
            type: 'connect_response',
            success: true,
            relayPort: port
        }));
    }

    createBridge(port, providerId, deviceSerial, controllerWs, providerWs) {
        const server = net.createServer((socket) => {
            // Store socket for bridging
            const tunnel = this.tunnels.get(port);
            if (tunnel) {
                if (!tunnel.controllerSocket) {
                    tunnel.controllerSocket = socket;
                    console.log(chalk.dim(`Controller connected to bridge port ${port}`));
                } else {
                    // This is provider connecting
                    tunnel.providerSocket = socket;
                    console.log(chalk.dim(`Provider connected to bridge port ${port}`));

                    // Bridge the two sockets
                    tunnel.controllerSocket.pipe(tunnel.providerSocket);
                    tunnel.providerSocket.pipe(tunnel.controllerSocket);
                }
            }
        });

        server.listen(port, '0.0.0.0', () => {
            console.log(chalk.dim(`Bridge listening on port ${port}`));
        });

        this.tunnels.set(port, {
            server,
            providerId,
            deviceSerial,
            controllerSocket: null,
            providerSocket: null
        });
    }

    handleDisconnect(ws) {
        // Check if provider
        if (ws._providerId) {
            const providerId = ws._providerId;
            this.providers.delete(providerId);
            console.log(chalk.yellow(`Provider disconnected: ${providerId}`));

            // Clean up tunnels for this provider
            for (const [port, tunnel] of this.tunnels) {
                if (tunnel.providerId === providerId) {
                    tunnel.server.close();
                    this.portPool.release(port);
                    this.tunnels.delete(port);
                }
            }
        }
    }
}

function startRelay(options) {
    const server = new RelayServer(options);
    server.start();
}

module.exports = { RelayServer, startRelay };

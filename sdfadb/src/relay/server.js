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
        this.activeDeviceSessions = new Map(); // providerId:serial -> sessionId
        this.halfOpenTimeoutMs = options.halfOpenTimeoutMs || 15000;
        this.idleTimeoutMs = options.idleTimeoutMs || 300000;
        this.metrics = {
            connectFailures: 0
        };
        this.maxSessions = options.maxSessions || 100;
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
                this.listDevices(ws, msg);
                break;
            case 'connect_device':
                this.connectDevice(ws, msg);
                break;
            case 'disconnect_device':
                this.disconnectDevice(ws, msg);
                break;
            case 'status':
                this.sendStatus(ws, msg);
                break;
            default:
                console.log(chalk.dim(`Unknown message type: ${msg.type}`));
        }
    }

    buildError(code, message, retryable = false) {
        this.metrics.connectFailures += 1;
        return {
            success: false,
            error: message,
            errorCode: code,
            retryable
        };
    }

    sessionEvent(event, details = {}) {
        console.log(chalk.dim(`[SESSION] ${event} ${JSON.stringify(details)}`));
    }

    getObservabilitySnapshot() {
        let halfOpenSessions = 0;

        for (const [, tunnel] of this.tunnels) {
            const connectedCount = (tunnel.controllerSocket ? 1 : 0) + (tunnel.providerSocket ? 1 : 0);
            if (connectedCount < 2) {
                halfOpenSessions += 1;
            }
        }

        const stats = this.portPool.getStats();
        return {
            active_sessions: this.activeDeviceSessions.size,
            half_open_sessions: halfOpenSessions,
            port_pool_usage: stats.allocated,
            connect_failures: this.metrics.connectFailures
        };
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
            providerId,
            requestId: msg.requestId || null
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

    listDevices(ws, msg = {}) {
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
            devices,
            requestId: msg.requestId || null
        }));
    }

    async connectDevice(ws, msg) {
        const { controllerId, providerId, deviceSerial } = msg;

        const provider = this.providers.get(providerId);
        if (!provider) {
            ws.send(JSON.stringify({
                type: 'connect_response',
                ...this.buildError('PROVIDER_NOT_FOUND', 'Provider not found', false),
                requestId: msg.requestId || null
            }));
            return;
        }
        if (this.tunnels.size >= this.maxSessions) {
            ws.send(JSON.stringify({
                type: 'connect_response',
                ...this.buildError('SESSION_LIMIT_REACHED', 'Max sessions reached', true),
                requestId: msg.requestId || null
            }));
            return;
        }


        // Allocate port for this connection
        const port = this.portPool.allocate(providerId, deviceSerial);
        if (!port) {
            ws.send(JSON.stringify({
                type: 'connect_response',
                ...this.buildError('PORT_EXHAUSTED', 'No ports available', true),
                requestId: msg.requestId || null
            }));
            return;
        }

        const sessionId = `${controllerId}-${deviceSerial}-${Date.now()}`;

        if (!this.reserveDeviceSession(providerId, deviceSerial, sessionId)) {
            this.portPool.release(port);
            ws.send(JSON.stringify({
                type: 'connect_response',
                ...this.buildError('DEVICE_BUSY', 'Device already in use', false),
                requestId: msg.requestId || null
            }));
            return;
        }

        console.log(chalk.cyan(`Connection: ${controllerId} → ${providerId}/${deviceSerial} (port ${port})`));

        // Create TCP bridge server
        this.createBridge(port, sessionId, providerId, deviceSerial, ws, provider.ws);

        // Notify provider to connect
        provider.ws.send(JSON.stringify({
            type: 'connect_request',
            controllerId,
            deviceSerial,
            relayPort: port
        }));

        this.sessionEvent('connect_allocated', { sessionId, providerId, deviceSerial, relayPort: port });

        // Respond to controller
        ws.send(JSON.stringify({
            type: 'connect_response',
            success: true,
            relayPort: port,
            sessionId,
            requestId: msg.requestId || null
        }));
    }

    disconnectDevice(ws, msg) {
        const { sessionId, relayPort } = msg;

        let targetPort = relayPort;

        if (!targetPort && sessionId) {
            for (const [port, tunnel] of this.tunnels) {
                if (tunnel.sessionId === sessionId) {
                    targetPort = port;
                    break;
                }
            }
        }

        if (!targetPort || !this.tunnels.has(targetPort)) {
            ws.send(JSON.stringify({
                type: 'disconnect_response',
                ...this.buildError('SESSION_NOT_FOUND', 'Session not found', false),
                requestId: msg.requestId || null
            }));
            return;
        }

        const tunnel = this.tunnels.get(targetPort);

        if (tunnel.providerSocket) {
            tunnel.providerSocket.end();
        }

        if (tunnel.controllerSocket) {
            tunnel.controllerSocket.end();
        }

        if (this.providers.has(tunnel.providerId)) {
            const providerWs = this.providers.get(tunnel.providerId).ws;
            if (providerWs && providerWs.readyState === WebSocket.OPEN) {
                providerWs.send(JSON.stringify({
                    type: 'disconnect_request',
                    relayPort: targetPort
                }));
            }
        }

        this.releaseTunnel(targetPort, 'disconnect-request');

        ws.send(JSON.stringify({
            type: 'disconnect_response',
            success: true,
            relayPort: targetPort,
            sessionId: tunnel.sessionId,
            requestId: msg.requestId || null
        }));
    }

    createBridge(port, sessionId, providerId, deviceSerial, controllerWs, providerWs) {
        const server = net.createServer((socket) => {
            // Store socket for bridging
            const tunnel = this.tunnels.get(port);
            if (tunnel) {
                if (!tunnel.controllerSocket) {
                    tunnel.controllerSocket = socket;
                    console.log(chalk.dim(`Controller connected to bridge port ${port}`));

                    socket.on('close', () => {
                        const latest = this.tunnels.get(port);
                        if (!latest) {
                            return;
                        }
                        latest.controllerSocket = null;
                        if (!latest.providerSocket) {
                            this.releaseTunnel(port, 'controller-disconnected-before-bridge');
                        }
                    });
                } else {
                    // This is provider connecting
                    tunnel.providerSocket = socket;
                    console.log(chalk.dim(`Provider connected to bridge port ${port}`));

                    // Bridge the two sockets
                    tunnel.controllerSocket.pipe(tunnel.providerSocket);
                    tunnel.providerSocket.pipe(tunnel.controllerSocket);

                    if (tunnel.halfOpenTimer) {
                        clearTimeout(tunnel.halfOpenTimer);
                        tunnel.halfOpenTimer = null;
                    }

                    this.bindIdleTracking(port, tunnel.controllerSocket);
                    this.bindIdleTracking(port, tunnel.providerSocket);
                    this.armIdleTimeout(port);

                    socket.on('close', () => {
                        const latest = this.tunnels.get(port);
                        if (!latest) {
                            return;
                        }
                        latest.providerSocket = null;
                        this.releaseTunnel(port, 'provider-disconnected');
                    });
                }

                socket.on('error', () => {
                    socket.destroy();
                });
            }
        });

        server.listen(port, '0.0.0.0', () => {
            console.log(chalk.dim(`Bridge listening on port ${port}`));
        });

        this.tunnels.set(port, {
            server,
            sessionId,
            providerId,
            deviceSerial,
            controllerSocket: null,
            providerSocket: null,
            halfOpenTimer: null,
            idleTimer: null
        });

        this.armHalfOpenTimeout(port);
    }

    releaseTunnel(port, reason = 'unknown') {
        const tunnel = this.tunnels.get(port);
        if (!tunnel) {
            return;
        }

        if (tunnel.halfOpenTimer) {
            clearTimeout(tunnel.halfOpenTimer);
            tunnel.halfOpenTimer = null;
        }

        if (tunnel.idleTimer) {
            clearTimeout(tunnel.idleTimer);
            tunnel.idleTimer = null;
        }

        if (tunnel.controllerSocket) {
            tunnel.controllerSocket.end();
        }

        if (tunnel.providerSocket) {
            tunnel.providerSocket.end();
        }

        tunnel.server.close();
        this.portPool.release(port);
        this.tunnels.delete(port);
        this.releaseDeviceSession(tunnel.providerId, tunnel.deviceSerial, tunnel.sessionId);
        this.sessionEvent('closed', {
            sessionId: tunnel.sessionId,
            providerId: tunnel.providerId,
            deviceSerial: tunnel.deviceSerial,
            relayPort: port,
            reason
        });

        console.log(chalk.dim(`Released tunnel on port ${port} (${reason})`));
    }

    armHalfOpenTimeout(port) {
        const tunnel = this.tunnels.get(port);
        if (!tunnel) {
            return;
        }

        if (tunnel.halfOpenTimer) {
            clearTimeout(tunnel.halfOpenTimer);
        }

        tunnel.halfOpenTimer = setTimeout(() => {
            const latest = this.tunnels.get(port);
            if (!latest) {
                return;
            }

            const fullyConnected = latest.controllerSocket && latest.providerSocket;
            if (!fullyConnected) {
                this.releaseTunnel(port, 'half-open-timeout');
            }
        }, this.halfOpenTimeoutMs);
    }

    armIdleTimeout(port) {
        const tunnel = this.tunnels.get(port);
        if (!tunnel) {
            return;
        }

        if (tunnel.idleTimer) {
            clearTimeout(tunnel.idleTimer);
        }

        tunnel.idleTimer = setTimeout(() => {
            const latest = this.tunnels.get(port);
            if (!latest) {
                return;
            }

            const fullyConnected = latest.controllerSocket && latest.providerSocket;
            if (fullyConnected) {
                this.releaseTunnel(port, 'idle-timeout');
            }
        }, this.idleTimeoutMs);
    }

    bindIdleTracking(port, socket) {
        socket.on('data', () => {
            this.armIdleTimeout(port);
        });
    }

    getDeviceKey(providerId, deviceSerial) {
        return `${providerId}:${deviceSerial}`;
    }

    reserveDeviceSession(providerId, deviceSerial, sessionId) {
        const deviceKey = this.getDeviceKey(providerId, deviceSerial);
        const currentSession = this.activeDeviceSessions.get(deviceKey);

        if (currentSession && currentSession !== sessionId) {
            return false;
        }

        this.activeDeviceSessions.set(deviceKey, sessionId);
        return true;
    }

    releaseDeviceSession(providerId, deviceSerial, sessionId) {
        const deviceKey = this.getDeviceKey(providerId, deviceSerial);
        const currentSession = this.activeDeviceSessions.get(deviceKey);

        if (currentSession === sessionId) {
            this.activeDeviceSessions.delete(deviceKey);
        }
    }

    sendStatus(ws, msg = {}) {
        const stats = this.portPool.getStats();
        const telemetry = this.getObservabilitySnapshot();

        ws.send(JSON.stringify({
            type: 'status_response',
            providers: this.providers.size,
            tunnels: this.tunnels.size,
            maxSessions: this.maxSessions,
            availablePorts: stats.available,
            allocatedPorts: stats.allocated,
            telemetry,
            requestId: msg.requestId || null
        }));
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
                    this.releaseTunnel(port, 'provider-ws-disconnect');
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

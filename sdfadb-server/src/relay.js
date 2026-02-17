/**
 * SDF ADB Server - Relay Server
 * 
 * Flow:
 * 1. Server allocates a port for a session (via API or allocate command)
 * 2. Provider connects to the allocated port first
 * 3. Client connects to the same port
 * 4. Server bridges Provider <-> Client for ADB traffic
 */

const net = require('net');
const WebSocket = require('ws');
const chalk = require('chalk');
const PortPool = require('./portPool');

class RelayServer {
    constructor(options = {}) {
        this.host = options.host || '0.0.0.0';
        this.port = options.port || 21120;
        this.portPool = new PortPool(
            options.portStart || 30001,
            options.portEnd || 30999
        );

        this.providers = new Map();      // providerId -> { ws, devices }
        this.sessions = new Map();       // sessionId -> { port, providerId, deviceSerial, status }
        this.tunnels = new Map();        // port -> { server, providerSocket, clientSocket }
        this.activeDeviceSessions = new Map(); // providerId:serial -> sessionId

        this.wss = null;
        this.halfOpenTimeoutMs = options.halfOpenTimeoutMs || 15000;
        this.idleTimeoutMs = options.idleTimeoutMs || 300000;
        this.metrics = {
            connectFailures: 0
        };
        this.maxSessions = options.maxSessions || 100;
    }

    start() {
        // WebSocket server for signaling
        this.wss = new WebSocket.Server({
            host: this.host,
            port: this.port
        });

        console.log(chalk.bold('\n🚀 SDF ADB Server Started\n'));
        console.log(chalk.green(`  Signal server: ws://${this.host}:${this.port}`));
        console.log(chalk.green(`  Port pool: ${this.portPool.start}-${this.portPool.end}`));
        console.log(chalk.dim('\n  Waiting for connections...\n'));

        this.wss.on('connection', (ws, req) => {
            const clientIp = req.socket.remoteAddress;
            console.log(chalk.dim(`[${new Date().toISOString()}] Client connected: ${clientIp}`));

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

            ws.on('error', (err) => {
                console.error(chalk.red('WebSocket error:', err.message));
            });
        });

        // Cleanup expired allocations periodically
        setInterval(() => {
            const cleaned = this.portPool.cleanupExpired();
            if (cleaned > 0) {
                console.log(chalk.dim(`Cleaned up ${cleaned} expired port allocations`));
            }
        }, 60000);

        // Handle graceful shutdown
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
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

            case 'allocate_port':
                this.allocatePort(ws, msg);
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
            const connectedCount = (tunnel.providerSocket ? 1 : 0) + (tunnel.clientSocket ? 1 : 0);
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

    /**
     * Register a provider
     */
    registerProvider(ws, msg, clientIp) {
        const { providerId, devices } = msg;

        this.providers.set(providerId, {
            ws,
            devices: devices || [],
            ip: clientIp,
            registeredAt: new Date()
        });

        ws._providerId = providerId;
        ws._type = 'provider';

        console.log(chalk.green(`[PROVIDER] ${providerId} registered (${devices?.length || 0} devices)`));

        ws.send(JSON.stringify({
            type: 'registered',
            providerId,
            status: 'ok',
            requestId: msg.requestId || null
        }));
    }

    /**
     * Update provider's device list
     */
    updateProviderDevices(msg) {
        const { providerId, devices } = msg;
        const provider = this.providers.get(providerId);

        if (provider) {
            provider.devices = devices;
            console.log(chalk.dim(`[PROVIDER] ${providerId} updated: ${devices.length} devices`));
        }
    }

    /**
     * List all available devices
     */
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

    /**
     * Allocate a port for a session
     * This is called before provider and client connect
     */
    allocatePort(ws, msg) {
        const { sessionId, providerId, deviceSerial, requestedPort } = msg;

        let port;
        if (requestedPort) {
            port = this.portPool.allocateSpecific(
                requestedPort, sessionId, deviceSerial, providerId
            );
        } else {
            port = this.portPool.allocate(sessionId, deviceSerial, providerId);
        }

        if (!port) {
            ws.send(JSON.stringify({
                type: 'allocate_response',
                ...this.buildError('PORT_EXHAUSTED', 'No ports available', true),
                requestId: msg.requestId || null
            }));
            return;
        }

        if (this.tunnels.size >= this.maxSessions) {
            this.portPool.release(port);
            ws.send(JSON.stringify({
                type: 'allocate_response',
                ...this.buildError('SESSION_LIMIT_REACHED', 'Max sessions reached', true),
                requestId: msg.requestId || null
            }));
            return;
        }

        if (!this.reserveDeviceSession(providerId, deviceSerial, sessionId)) {
            this.portPool.release(port);
            ws.send(JSON.stringify({
                type: 'allocate_response',
                ...this.buildError('DEVICE_BUSY', 'Device already in use', false),
                requestId: msg.requestId || null
            }));
            return;
        }

        // Create TCP server for this port
        this.createTunnelServer(port, sessionId, providerId, deviceSerial);

        this.sessions.set(sessionId, {
            port,
            providerId,
            deviceSerial,
            status: 'allocated',
            allocatedAt: new Date()
        });

        console.log(chalk.cyan(`[ALLOCATE] Session ${sessionId}: port ${port} for ${providerId}/${deviceSerial}`));

        ws.send(JSON.stringify({
            type: 'allocate_response',
            success: true,
            sessionId,
            port,
            host: this.host === '0.0.0.0' ? 'SERVER_IP' : this.host,
            requestId: msg.requestId || null
        }));
    }

    /**
     * Connect device (legacy - allocates and notifies provider)
     */
    connectDevice(ws, msg) {
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


        // Allocate port
        const sessionId = `${controllerId}-${deviceSerial}-${Date.now()}`;
        const port = this.portPool.allocate(sessionId, deviceSerial, providerId);

        if (!port) {
            ws.send(JSON.stringify({
                type: 'connect_response',
                ...this.buildError('PORT_EXHAUSTED', 'No ports available', true),
                requestId: msg.requestId || null
            }));
            return;
        }
        if (!this.reserveDeviceSession(providerId, deviceSerial, sessionId)) {
            this.portPool.release(port);
            ws.send(JSON.stringify({
                type: 'connect_response',
                ...this.buildError('DEVICE_BUSY', 'Device already in use', false),
                requestId: msg.requestId || null
            }));
            return;
        }


        // Create tunnel server
        this.createTunnelServer(port, sessionId, providerId, deviceSerial);

        this.sessions.set(sessionId, {
            port,
            providerId,
            deviceSerial,
            controllerId,
            status: 'allocated'
        });

        console.log(chalk.cyan(`[CONNECT] ${controllerId} → ${providerId}/${deviceSerial} on port ${port}`));

        // Notify provider
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

    /**
     * Disconnect a previously created session
     */
    disconnectDevice(ws, msg) {
        const { sessionId, relayPort } = msg;

        let targetSessionId = sessionId;
        let targetPort = relayPort;

        if (!targetPort && targetSessionId && this.sessions.has(targetSessionId)) {
            targetPort = this.sessions.get(targetSessionId).port;
        }

        if (!targetSessionId && targetPort && this.tunnels.has(targetPort)) {
            targetSessionId = this.tunnels.get(targetPort).sessionId;
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

        if (tunnel.clientSocket) {
            tunnel.clientSocket.end();
        }

        const provider = this.providers.get(tunnel.providerId);
        if (provider && provider.ws && provider.ws.readyState === WebSocket.OPEN) {
            provider.ws.send(JSON.stringify({
                type: 'disconnect_request',
                relayPort: targetPort
            }));
        }

        this.releaseTunnel(targetPort, 'disconnect-request');

        ws.send(JSON.stringify({
            type: 'disconnect_response',
            success: true,
            sessionId: targetSessionId || tunnel.sessionId,
            relayPort: targetPort,
            requestId: msg.requestId || null
        }));
    }

    /**
     * Create a TCP tunnel server for bridging provider and client
     */
    createTunnelServer(port, sessionId, providerId, deviceSerial) {
        const tunnel = {
            server: null,
            providerSocket: null,
            clientSocket: null,
            halfOpenTimer: null,
            idleTimer: null,
            sessionId,
            providerId,
            deviceSerial
        };

        tunnel.server = net.createServer((socket) => {
            const remoteAddr = socket.remoteAddress;
            console.log(chalk.dim(`[TUNNEL:${port}] Connection from ${remoteAddr}`));

            if (!tunnel.providerSocket) {
                // First connection is provider
                tunnel.providerSocket = socket;
                this.portPool.updateStatus(port, { providerConnected: true });
                console.log(chalk.green(`[TUNNEL:${port}] Provider connected`));

                socket.on('close', () => {
                    console.log(chalk.yellow(`[TUNNEL:${port}] Provider disconnected`));
                    tunnel.providerSocket = null;
                    this.releaseTunnel(port, 'provider-disconnected');
                });

            } else if (!tunnel.clientSocket) {
                // Second connection is client
                tunnel.clientSocket = socket;
                this.portPool.updateStatus(port, { clientConnected: true });
                console.log(chalk.green(`[TUNNEL:${port}] Client connected - bridging started`));

                // Bridge provider <-> client
                tunnel.providerSocket.pipe(socket);
                socket.pipe(tunnel.providerSocket);

                if (tunnel.halfOpenTimer) {
                    clearTimeout(tunnel.halfOpenTimer);
                    tunnel.halfOpenTimer = null;
                }

                this.bindIdleTracking(port, tunnel.providerSocket);
                this.bindIdleTracking(port, tunnel.clientSocket);
                this.armIdleTimeout(port);

                socket.on('close', () => {
                    console.log(chalk.yellow(`[TUNNEL:${port}] Client disconnected`));
                    tunnel.clientSocket = null;
                    this.releaseTunnel(port, 'client-disconnected');
                });

            } else {
                // Already have both, reject
                console.log(chalk.red(`[TUNNEL:${port}] Rejected extra connection`));
                socket.end();
            }

            socket.on('error', (err) => {
                console.error(chalk.red(`[TUNNEL:${port}] Socket error: ${err.message}`));
            });
        });

        tunnel.server.on('error', (err) => {
            console.error(chalk.red(`[TUNNEL:${port}] Server error: ${err.message}`));
        });

        tunnel.server.listen(port, this.host, () => {
            console.log(chalk.dim(`[TUNNEL:${port}] Listening for provider → client bridge`));
        });

        this.tunnels.set(port, tunnel);
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

            const fullyConnected = latest.providerSocket && latest.clientSocket;
            if (!fullyConnected) {
                this.releaseTunnel(port, 'half-open-timeout');
            }
        }, this.halfOpenTimeoutMs);
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

        if (tunnel.providerSocket) {
            tunnel.providerSocket.end();
        }

        if (tunnel.clientSocket) {
            tunnel.clientSocket.end();
        }

        tunnel.server.close();
        this.tunnels.delete(port);
        this.portPool.release(port);

        if (tunnel.sessionId) {
            this.sessions.delete(tunnel.sessionId);
        }

        this.releaseDeviceSession(tunnel.providerId, tunnel.deviceSerial, tunnel.sessionId);
        this.sessionEvent('closed', {
            sessionId: tunnel.sessionId,
            providerId: tunnel.providerId,
            deviceSerial: tunnel.deviceSerial,
            relayPort: port,
            reason
        });

        console.log(chalk.dim(`[TUNNEL:${port}] Released (${reason})`));
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

            const fullyConnected = latest.providerSocket && latest.clientSocket;
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

    /**
     * Send server status
     */
    sendStatus(ws, msg = {}) {
        const stats = this.portPool.getStats();
        const telemetry = this.getObservabilitySnapshot();
        ws.send(JSON.stringify({
            type: 'status_response',
            providers: this.providers.size,
            sessions: this.sessions.size,
            tunnels: this.tunnels.size,
            maxSessions: this.maxSessions,
            availablePorts: stats.available,
            allocatedPorts: stats.allocated,
            telemetry,
            requestId: msg.requestId || null
        }));
    }

    /**
     * Handle client disconnect
     */
    handleDisconnect(ws) {
        if (ws._type === 'provider' && ws._providerId) {
            const providerId = ws._providerId;
            this.providers.delete(providerId);
            console.log(chalk.yellow(`[PROVIDER] ${providerId} disconnected`));

            // Clean up tunnels for this provider
            for (const [port, tunnel] of this.tunnels) {
                if (tunnel.providerId === providerId) {
                    this.releaseTunnel(port, 'provider-ws-disconnect');
                }
            }
        }
    }

    /**
     * Graceful shutdown
     */
    shutdown() {
        console.log(chalk.yellow('\nShutting down...'));

        // Close all tunnels
        for (const [port] of this.tunnels) {
            this.releaseTunnel(port, 'server-shutdown');
        }

        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
        }

        console.log(chalk.green('Server stopped'));
        process.exit(0);
    }
}

module.exports = { RelayServer };

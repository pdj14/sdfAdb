/**
 * SDF ADB - Controller
 * Connects to remote devices via relay or direct connection
 */

const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');
const { generateId } = require('./utils/helpers');

const SESSION_DIR = path.join(os.homedir(), '.sdfadb');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
}

function loadSessions() {
    ensureSessionDir();

    if (!fs.existsSync(SESSION_FILE)) {
        return [];
    }

    try {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveSessions(sessions) {
    ensureSessionDir();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

function upsertSession(session) {
    const sessions = loadSessions();
    const idx = sessions.findIndex((s) => s.localPort === session.localPort);

    if (idx >= 0) {
        sessions[idx] = session;
    } else {
        sessions.push(session);
    }

    saveSessions(sessions);
}

function removeSessionByPort(localPort) {
    const sessions = loadSessions();
    const filtered = sessions.filter((s) => s.localPort !== localPort);
    saveSessions(filtered);
    return sessions.length - filtered.length;
}

function getReservedLocalPorts() {
    return new Set(loadSessions().map((s) => s.localPort).filter((p) => Number.isInteger(p)));
}

function probePortAvailable(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();

        tester.once('error', () => {
            resolve(false);
        });

        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });

        tester.listen(port, '127.0.0.1');
    });
}

async function resolveLocalPort(preferredPort) {
    const startPort = Number.isInteger(preferredPort) ? preferredPort : 5555;
    const reserved = getReservedLocalPorts();

    for (let port = startPort; port <= 65535; port++) {
        if (reserved.has(port)) {
            continue;
        }

        const available = await probePortAvailable(port);
        if (available) {
            return port;
        }
    }

    throw new Error('No available local port found between 5555-65535');
}

class Controller {
    constructor(options) {
        this.relay = options.relay;
        this.controllerId = generateId('CTRL');
        this.ws = null;
        this.connections = new Map(); // localPort -> connection info
        this.pendingRequests = new Map(); // requestId -> {resolve, reject, timer}
        this.requestSeq = 0;
    }

    nextRequestId() {
        this.requestSeq += 1;
        return `${this.controllerId}-REQ-${this.requestSeq}`;
    }

    isResponseMessage(msg) {
        return msg && (
            (typeof msg.type === 'string' && msg.type.endsWith('_response')) ||
            msg.type === 'device_list'
        );
    }

    handleIncomingMessage(raw) {
        let msg;

        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.requestId && this.pendingRequests.has(msg.requestId) && this.isResponseMessage(msg)) {
            const pending = this.pendingRequests.get(msg.requestId);
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.requestId);
            pending.resolve(msg);
        }
    }

    async connectRelay() {
        return new Promise((resolve, reject) => {
            const wsUrl = `ws://${this.relay}`;
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', resolve);
            this.ws.on('error', reject);
            this.ws.on('message', (msg) => this.handleIncomingMessage(msg));
        });
    }

    send(data, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Relay websocket is not connected'));
                return;
            }

            const requestId = data.requestId || this.nextRequestId();
            const payload = { ...data, requestId };

            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request timeout: ${payload.type}`));
            }, timeoutMs);

            this.pendingRequests.set(requestId, { resolve, reject, timer });
            this.ws.send(JSON.stringify(payload));
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
        return connectDirect(options);
    } else if (options.relay) {
        return connectRelay(options);
    }

    return null;
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
                } catch {
                    reject(new Error('Invalid response from provider'));
                }
            });
            providerConn.once('error', reject);
        });

        if (!response.success) {
            throw new Error(response.error || 'Connection failed');
        }

        spinner.succeed(`Connected to ${options.deviceSerial} via direct connection`);

        const localPort = await resolveLocalPort(options.localPort);

        // Create local server for ADB to connect
        const server = net.createServer((socket) => {
            socket.pipe(providerConn);
            providerConn.pipe(socket);

            socket.on('error', () => providerConn.end());
            providerConn.on('error', () => socket.end());
        });

        server.listen(localPort, '127.0.0.1', () => {
            console.log(chalk.green(`\n✓ Connected via: Direct P2P`));
            console.log(chalk.green(`✓ Provider: ${host}:${providerPort}`));
            console.log(chalk.green(`✓ Device: ${response.device?.model || options.deviceSerial}`));
            console.log(chalk.green(`✓ Local port: localhost:${localPort}`));
            console.log(chalk.dim('\nYou can now use:'));
            console.log(chalk.white(`  adb connect localhost:${localPort}`));
            console.log(chalk.white(`  adb -s localhost:${localPort} shell`));
            console.log(chalk.dim('\nPress Ctrl+C to disconnect'));
        });

        process.on('SIGINT', () => {
            console.log(chalk.yellow('\nDisconnecting...'));
            server.close();
            providerConn.end();
            process.exit(0);
        });

        return {
            mode: 'direct',
            localPort,
            provider: `${host}:${providerPort}`,
            deviceSerial: options.deviceSerial
        };

    } catch (error) {
        spinner.fail('Direct connection failed');

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

        const localPort = await resolveLocalPort(options.localPort);

        const server = net.createServer((socket) => {
            const relayConn = net.createConnection({
                host: options.relay.split(':')[0],
                port: response.relayPort
            });

            socket.pipe(relayConn);
            relayConn.pipe(socket);

            socket.on('error', () => relayConn.end());
            relayConn.on('error', () => socket.end());
        });

        server.listen(localPort, '127.0.0.1', () => {
            console.log(chalk.green(`\n✓ Connected via: Relay`));
            console.log(chalk.green(`✓ Relay port: ${response.relayPort}`));
            console.log(chalk.green(`✓ Local port: localhost:${localPort}`));
            console.log(chalk.dim('\nYou can now use:'));
            console.log(chalk.white(`  adb connect localhost:${localPort}`));
            console.log(chalk.white(`  adb -s localhost:${localPort} shell`));
            console.log(chalk.dim('\nPress Ctrl+C to disconnect'));
        });

        const sessionEntry = {
            mode: 'relay',
            relay: options.relay,
            controllerId: controller.controllerId,
            providerId: options.providerId,
            deviceSerial: options.deviceSerial,
            localPort: localPort,
            relayPort: response.relayPort,
            sessionId: response.sessionId || null,
            connectedAt: new Date().toISOString()
        };

        upsertSession(sessionEntry);

        controller.connections.set(localPort, {
            server,
            ...sessionEntry
        });

        process.on('SIGINT', async () => {
            console.log(chalk.yellow('\nDisconnecting...'));

            try {
                if (controller.ws && controller.ws.readyState === WebSocket.OPEN) {
                    await controller.send({
                        type: 'disconnect_device',
                        sessionId: sessionEntry.sessionId,
                        relayPort: sessionEntry.relayPort,
                        providerId: sessionEntry.providerId,
                        deviceSerial: sessionEntry.deviceSerial,
                        controllerId: sessionEntry.controllerId
                    });
                }
            } catch {
                // Best-effort disconnect notification
            }

            removeSessionByPort(localPort);
            server.close();
            controller.ws.close();
            process.exit(0);
        });

        return sessionEntry;

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
    const sessions = loadSessions();

    if (!options.all && !options.port) {
        console.log(chalk.red('Please specify --port or --all'));
        process.exit(1);
    }

    let targets = sessions;
    if (options.port) {
        targets = sessions.filter((s) => s.localPort === options.port);

        if (targets.length === 0) {
            console.log(chalk.yellow(`No saved relay session found for local port ${options.port}`));
            process.exit(0);
        }
    }

    if (options.all && targets.length === 0) {
        console.log(chalk.yellow('No saved relay sessions found'));
        process.exit(0);
    }

    for (const session of targets) {
        if (session.mode !== 'relay') {
            continue;
        }

        try {
            const controller = new Controller({ relay: session.relay });
            controller.controllerId = session.controllerId || controller.controllerId;
            await controller.connectRelay();

            const response = await controller.send({
                type: 'disconnect_device',
                sessionId: session.sessionId || undefined,
                relayPort: session.relayPort,
                providerId: session.providerId,
                deviceSerial: session.deviceSerial,
                controllerId: controller.controllerId
            });

            controller.ws.close();

            if (response.success) {
                console.log(chalk.green(`✓ Disconnected session on local port ${session.localPort}`));
            } else {
                console.log(chalk.yellow(`⚠ Disconnect request failed for port ${session.localPort}: ${response.error || 'unknown error'}`));
            }
        } catch (error) {
            console.log(chalk.yellow(`⚠ Failed to send disconnect for port ${session.localPort}: ${error.message}`));
        }

        removeSessionByPort(session.localPort);
    }
}

module.exports = { Controller, list, connect, disconnect };

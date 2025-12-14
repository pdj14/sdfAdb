#!/usr/bin/env node
/**
 * SDF ADB - CLI Entry Point
 */

const { program } = require('commander');
const pkg = require('../package.json');

// Import commands
const { provide } = require('../src/provider');
const { connect, disconnect, list } = require('../src/controller');
const { startRelay } = require('../src/relay/server');

program
    .name('sdfadb')
    .description('ADB Remote Bridge - Share and access Android devices remotely')
    .version(pkg.version);

// Relay server command
program
    .command('relay')
    .description('Start relay server for NAT traversal')
    .option('-p, --port <port>', 'Signal server port', '21120')
    .option('--port-start <port>', 'Port pool start', '30001')
    .option('--port-end <port>', 'Port pool end', '30999')
    .action((options) => {
        startRelay({
            port: parseInt(options.port),
            portStart: parseInt(options.portStart),
            portEnd: parseInt(options.portEnd)
        });
    });

// Provider command
program
    .command('provide')
    .description('Share local ADB devices')
    .option('-r, --relay <server>', 'Relay server address (host:port)')
    .option('--direct', 'Enable direct mode (no relay)')
    .option('-p, --port <port>', 'Direct mode listen port', '21121')
    .option('-d, --device <serial...>', 'Specific devices to share (default: all)')
    .option('--allow-user <user...>', 'Allow specific users only')
    .action((options) => {
        if (!options.relay && !options.direct) {
            console.error('Error: Either --relay or --direct is required');
            process.exit(1);
        }
        provide({
            relay: options.relay,
            direct: options.direct,
            directPort: parseInt(options.port),
            devices: options.device,
            allowedUsers: options.allowUser
        });
    });

// List devices command
program
    .command('list')
    .description('List available remote devices')
    .requiredOption('-r, --relay <server>', 'Relay server address (host:port)')
    .action((options) => {
        list({ relay: options.relay });
    });

// Connect command
program
    .command('connect')
    .description('Connect to a remote device')
    .option('-r, --relay <server>', 'Relay server address (host:port)')
    .option('--direct <address>', 'Direct connection (host:port)')
    .option('--provider <id>', 'Provider ID (for relay mode)')
    .requiredOption('--device <serial>', 'Device serial')
    .option('-p, --port <port>', 'Local port to mount', '5555')
    .option('--auto', 'Auto mode: try direct first, fallback to relay')
    .action((options) => {
        if (!options.relay && !options.direct) {
            console.error('Error: Either --relay or --direct is required');
            process.exit(1);
        }
        connect({
            relay: options.relay,
            direct: options.direct,
            providerId: options.provider,
            deviceSerial: options.device,
            localPort: parseInt(options.port),
            auto: options.auto
        });
    });

// Disconnect command
program
    .command('disconnect')
    .description('Disconnect from remote device(s)')
    .option('-p, --port <port>', 'Local port to disconnect')
    .option('-a, --all', 'Disconnect all')
    .action((options) => {
        disconnect({
            port: options.port ? parseInt(options.port) : null,
            all: options.all
        });
    });

// Hybrid node command
program
    .command('node')
    .description('Run as hybrid node (provider + controller)')
    .requiredOption('-r, --relay <server>', 'Relay server address')
    .option('--share <serial...>', 'Devices to share')
    .option('--mount <spec...>', 'Devices to mount (format: provider:device:port)')
    .action((options) => {
        // Parse mount specs
        const mounts = (options.mount || []).map(spec => {
            const [provider, device, port] = spec.split(':');
            return { provider, device, port: parseInt(port) };
        });

        require('../src/node').startNode({
            relay: options.relay,
            shareDevices: options.share || [],
            mounts
        });
    });

program.parse();

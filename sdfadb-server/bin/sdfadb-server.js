#!/usr/bin/env node
/**
 * SDF ADB Server - CLI Entry Point
 * Relay server for remote ADB device bridging
 */

const { program } = require('commander');
const fs = require('fs');
const pkg = require('../package.json');
const { RelayServer } = require('../src/relay');
const chalk = require('chalk');

function readConfigFile(configPath) {
    if (!configPath) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        console.error(chalk.red(`Invalid config file: ${error.message}`));
        process.exit(1);
    }
}


program
    .name('sdfadb-server')
    .description('SDF ADB Relay Server for remote ADB device bridging')
    .version(pkg.version);

// Start server
program
    .command('start')
    .description('Start the relay server')
    .option('-c, --config <path>', 'Relay config json path')
    .option('-p, --port <port>', 'WebSocket signal port', '21120')
    .option('--port-start <port>', 'Port pool start', '30001')
    .option('--port-end <port>', 'Port pool end', '30999')
    .option('--host <host>', 'Bind host', '0.0.0.0')
    .option('--half-open-timeout <ms>', 'Half-open timeout in ms', '15000')
    .option('--idle-timeout <ms>', 'Idle timeout in ms', '300000')
    .option('--max-sessions <count>', 'Max active sessions', '100')
    .action((options) => {
        const cfg = readConfigFile(options.config);
        const server = new RelayServer({
            host: options.host || cfg.host,
            port: options.port ? parseInt(options.port) : cfg.port,
            portStart: options.portStart ? parseInt(options.portStart) : cfg.portStart,
            portEnd: options.portEnd ? parseInt(options.portEnd) : cfg.portEnd,
            halfOpenTimeoutMs: options.halfOpenTimeout ? parseInt(options.halfOpenTimeout) : cfg.halfOpenTimeoutMs,
            idleTimeoutMs: options.idleTimeout ? parseInt(options.idleTimeout) : cfg.idleTimeoutMs,
            maxSessions: options.maxSessions ? parseInt(options.maxSessions) : cfg.maxSessions
        });
        server.start();
    });

// Allocate port manually (for external orchestration)
program
    .command('allocate')
    .description('Allocate a relay port for a session')
    .requiredOption('--session <id>', 'Session ID')
    .requiredOption('--device <serial>', 'Device serial')
    .option('-p, --port <port>', 'Specific port (or auto-allocate)')
    .action((options) => {
        console.log(JSON.stringify({
            action: 'allocate',
            session: options.session,
            device: options.device,
            port: options.port || 'auto'
        }));
        // This would connect to running server via IPC
        console.log(chalk.yellow('Note: Use with running server via API'));
    });

// Status
program
    .command('status')
    .description('Show server status')
    .option('--host <host>', 'Server host', 'localhost')
    .option('-p, --port <port>', 'Server port', '21120')
    .action(async (options) => {
        const WebSocket = require('ws');
        try {
            const ws = new WebSocket(`ws://${options.host}:${options.port}`);
            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'status' }));
            });
            ws.on('message', (data) => {
                const status = JSON.parse(data.toString());
                console.log(chalk.bold('\nSDF ADB Server Status'));
                console.log(chalk.cyan(`  Providers: ${status.providers || 0}`));
                console.log(chalk.cyan(`  Active tunnels: ${status.tunnels || 0}`));
                console.log(chalk.cyan(`  Available ports: ${status.availablePorts || 0}`));
                ws.close();
            });
            ws.on('error', (err) => {
                console.error(chalk.red(`Cannot connect to server: ${err.message}`));
            });
        } catch (error) {
            console.error(chalk.red(error.message));
        }
    });

// Default: start server
program
    .action(() => {
        program.commands.find(c => c.name() === 'start').action({
            port: '21120',
            portStart: '30001',
            portEnd: '30999',
            host: '0.0.0.0',
            halfOpenTimeout: '15000',
            idleTimeout: '300000',
            maxSessions: '100'
        });
    });

program.parse();

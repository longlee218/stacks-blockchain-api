import {
  loadDotEnv,
  timeout,
  logger,
  logError,
  isProdEnv,
  numberToHex,
  parseArgBoolean,
  getApiConfiguredChainID,
  getStacksNodeChainID,
} from './helpers';
import * as sourceMapSupport from 'source-map-support';
import { DataStore } from './datastore/common';
import { PgDataStore } from './datastore/postgres-store';
import { startApiServer } from './api/init';
import { startProfilerServer } from './inspector-util';
import { startEventServer } from './event-stream/event-server';
import { StacksCoreRpcClient } from './core-rpc/client';
import { createServer as createPrometheusServer } from '@promster/server';
import { registerShutdownConfig } from './shutdown-handler';
import { OfflineDummyStore } from './datastore/offline-dummy-store';
import { Socket } from 'net';
import * as getopts from 'getopts';
import * as fs from 'fs';
import { injectC32addressEncodeCache } from './c32-addr-cache';
import { exportEventsAsTsv, importEventsFromTsv } from './event-replay/event-replay';
import { isFtMetadataEnabled, isNftMetadataEnabled } from './token-metadata/helpers';
import { TokensProcessorQueue } from './token-metadata/tokens-processor-queue';

enum StacksApiMode {
  /**
   * Default mode. Runs both the Event Server and API endpoints. AKA read-write mode.
   */
  default = 'default',
  /**
   * Runs the API endpoints without an Event Server. A connection to a `default`
   * or `writeOnly` API's postgres DB is required.
   */
  readOnly = 'readonly',
  /**
   * Runs the Event Server only.
   */
  writeOnly = 'writeonly',
  /**
   * Runs without an Event Server or API endpoints. Used for Rosetta only.
   */
  offline = 'offline',
}

/**
 * Determines the current API execution mode based on .env values.
 * @returns detected StacksApiMode
 */
function getApiMode(): StacksApiMode {
  switch (process.env['STACKS_API_MODE']) {
    case 'readonly':
      return StacksApiMode.readOnly;
    case 'writeonly':
      return StacksApiMode.writeOnly;
    case 'offline':
      return StacksApiMode.offline;
    default:
      break;
  }
  // Make sure we're backwards compatible if `STACKS_API_MODE` is not specified.
  if (parseArgBoolean(process.env['STACKS_READ_ONLY_MODE'])) {
    return StacksApiMode.readOnly;
  }
  if (parseArgBoolean(process.env['STACKS_API_OFFLINE_MODE'])) {
    return StacksApiMode.offline;
  }
  return StacksApiMode.default;
}

loadDotEnv();

// ts-node has automatic source map support, avoid clobbering
if (!process.execArgv.some(r => r.includes('ts-node'))) {
  sourceMapSupport.install({ handleUncaughtExceptions: false });
}

injectC32addressEncodeCache();

registerShutdownConfig();

async function monitorCoreRpcConnection(): Promise<void> {
  const CORE_RPC_HEARTBEAT_INTERVAL = 5000; // 5 seconds
  let previouslyConnected = false;
  while (true) {
    const client = new StacksCoreRpcClient();
    try {
      await client.waitForConnection();
      if (!previouslyConnected) {
        logger.info(`Connection to Stacks core node API server at: ${client.endpoint}`);
      }
      previouslyConnected = true;
    } catch (error) {
      previouslyConnected = false;
      logger.error(`Warning: failed to connect to node RPC server at ${client.endpoint}`);
    }
    await timeout(CORE_RPC_HEARTBEAT_INTERVAL);
  }
}

async function init(): Promise<void> {
  if (isProdEnv && !fs.existsSync('.git-info')) {
    throw new Error(
      'File not found: .git-info. This generated file is required to display the running API version in the ' +
        '`/extended/v1/status` endpoint. Please execute `npm run build` to regenerate it.'
    );
  }
  const apiMode = getApiMode();

  let db: DataStore;
  if (apiMode === StacksApiMode.offline) {
    db = OfflineDummyStore;
  } else {
    const skipMigrations = apiMode === StacksApiMode.readOnly;
    db = await PgDataStore.connect({
      usageName: `datastore-${apiMode}`,
      skipMigrations: skipMigrations,
    });

    if (apiMode !== StacksApiMode.readOnly) {
      const configuredChainID = getApiConfiguredChainID();
      const eventServer = await startEventServer({
        datastore: db,
        chainId: configuredChainID,
      });
      registerShutdownConfig({
        name: 'Event Server',
        handler: () => eventServer.closeAsync(),
        forceKillable: false,
      });

      const networkChainId = await getStacksNodeChainID();
      if (networkChainId !== configuredChainID) {
        const chainIdConfig = numberToHex(configuredChainID);
        const chainIdNode = numberToHex(networkChainId);
        const error = new Error(
          `The configured STACKS_CHAIN_ID does not match, configured: ${chainIdConfig}, stacks-node: ${chainIdNode}`
        );
        logError(error.message, error);
        throw error;
      }
      monitorCoreRpcConnection().catch(error => {
        logger.error(`Error monitoring RPC connection: ${error}`, error);
      });

      if (!isFtMetadataEnabled()) {
        logger.warn('Fungible Token metadata processing is not enabled.');
      }
      if (!isNftMetadataEnabled()) {
        logger.warn('Non-Fungible Token metadata processing is not enabled.');
      }
      if (isFtMetadataEnabled() || isNftMetadataEnabled()) {
        const tokenMetadataProcessor = new TokensProcessorQueue(db, configuredChainID);
        registerShutdownConfig({
          name: 'Token Metadata Processor',
          handler: () => tokenMetadataProcessor.close(),
          forceKillable: true,
        });
        // check if db has any non-processed token queues and await them all here
        await tokenMetadataProcessor.drainDbQueue();
      }
    }
  }

  if (apiMode !== StacksApiMode.writeOnly) {
    const apiServer = await startApiServer({ datastore: db, chainId: getApiConfiguredChainID() });
    logger.info(`API server listening on: http://${apiServer.address}`);
    registerShutdownConfig({
      name: 'API Server',
      handler: () => apiServer.terminate(),
      forceKillable: true,
      forceKillHandler: () => apiServer.forceKill(),
    });
  }

  const profilerHttpServerPort = process.env['STACKS_PROFILER_PORT'];
  if (profilerHttpServerPort) {
    const profilerServer = await startProfilerServer(profilerHttpServerPort);
    registerShutdownConfig({
      name: 'Profiler server',
      handler: () => profilerServer.close(),
      forceKillable: false,
    });
  }

  registerShutdownConfig({
    name: 'DB',
    handler: () => db.close(),
    forceKillable: false,
  });

  if (isProdEnv) {
    const prometheusServer = await createPrometheusServer({ port: 9153 });
    logger.info(`@promster/server started on port 9153.`);
    const sockets = new Set<Socket>();
    prometheusServer.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    registerShutdownConfig({
      name: 'Prometheus',
      handler: async () => {
        for (const socket of sockets) {
          socket.destroy();
          sockets.delete(socket);
        }
        await Promise.resolve(prometheusServer.close());
      },
      forceKillable: true,
    });
  }
}

function initApp() {
  init()
    .then(() => {
      logger.info('App initialized');
    })
    .catch(error => {
      logError(`app failed to start: ${error}`, error);
      process.exit(1);
    });
}

function getProgramArgs() {
  // TODO: use a more robust arg parsing library that has built-in `--help` functionality
  const parsedOpts = getopts(process.argv.slice(2), {
    boolean: ['overwrite-file', 'wipe-db'],
  });
  const args = {
    operand: parsedOpts._[0],
    options: parsedOpts,
  } as
    | {
        operand: 'export-events';
        options: {
          ['file']?: string;
          ['overwrite-file']?: boolean;
        };
      }
    | {
        operand: 'import-events';
        options: {
          ['file']?: string;
          ['mode']?: string;
          ['wipe-db']?: boolean;
          ['force']?: boolean;
        };
      };
  return { args, parsedOpts };
}

async function handleProgramArgs() {
  const { args, parsedOpts } = getProgramArgs();
  if (args.operand === 'export-events') {
    await exportEventsAsTsv(args.options.file, args.options['overwrite-file']);
  } else if (args.operand === 'import-events') {
    await importEventsFromTsv(
      args.options.file,
      args.options.mode,
      args.options['wipe-db'],
      args.options.force
    );
  } else if (parsedOpts._[0]) {
    throw new Error(`Unexpected program argument: ${parsedOpts._[0]}`);
  } else {
    initApp();
  }
}

void handleProgramArgs().catch(error => {
  console.error(error);
  const { args } = getProgramArgs();
  if (args.operand) {
    console.error(`${args.operand} process failed`);
  }
  process.exit(1);
});

import { inspect } from 'util';
import * as net from 'net';
import { createServer } from 'http';
import * as express from 'express';
import * as bodyParser from 'body-parser';
import { asyncHandler } from '../api/async-handler';
import PQueue from 'p-queue';
import * as expressWinston from 'express-winston';
import * as winston from 'winston';

import { hexToBuffer, logError, logger, LogLevel } from '../helpers';
import {
  CoreNodeBlockMessage,
  CoreNodeEventType,
  CoreNodeBurnBlockMessage,
  CoreNodeDropMempoolTxMessage,
  CoreNodeAttachmentMessage,
  CoreNodeMicroblockMessage,
  CoreNodeParsedTxMessage,
  CoreNodeEvent,
} from './core-node-message';
import {
  DataStore,
  createDbTxFromCoreMsg,
  DbEventBase,
  DbSmartContractEvent,
  DbStxEvent,
  DbEventTypeId,
  DbFtEvent,
  DbAssetEventTypeId,
  DbNftEvent,
  DbBlock,
  DataStoreBlockUpdateData,
  createDbMempoolTxFromCoreMsg,
  DbStxLockEvent,
  DbMinerReward,
  DbBurnchainReward,
  getTxDbStatus,
  DbRewardSlotHolder,
  DbBnsName,
  DbBnsNamespace,
  DbBnsSubdomain,
  DbMicroblockPartial,
  DataStoreMicroblockUpdateData,
  DataStoreTxEventData,
  DbMicroblock,
  DataStoreAttachmentData,
} from '../datastore/common';
import {
  getTxSenderAddress,
  getTxSponsorAddress,
  parseMessageTransaction,
  CoreNodeMsgBlockData,
  parseMicroblocksFromTxs,
} from './reader';
import {
  decodeTransaction,
  decodeClarityValue,
  ClarityValueBuffer,
  ClarityValueStringAscii,
  ClarityValueTuple,
  TxPayloadTypeID,
} from 'stacks-encoding-native-js';
import { ChainID } from '@stacks/transactions';
import { BnsContractIdentifier } from './bns/bns-constants';
import {
  parseNameFromContractEvent,
  parseNameRenewalWithNoZonefileHashFromContractCall,
  parseNamespaceFromContractEvent,
} from './bns/bns-helpers';

async function handleRawEventRequest(
  eventPath: string,
  payload: string,
  db: DataStore
): Promise<void> {
  await db.storeRawEventRequest(eventPath, payload);
}

async function handleBurnBlockMessage(
  burnBlockMsg: CoreNodeBurnBlockMessage,
  db: DataStore
): Promise<void> {
  logger.verbose(
    `Received burn block message hash ${burnBlockMsg.burn_block_hash}, height: ${burnBlockMsg.burn_block_height}, reward recipients: ${burnBlockMsg.reward_recipients.length}`
  );
  const rewards = burnBlockMsg.reward_recipients.map((r, index) => {
    const dbReward: DbBurnchainReward = {
      canonical: true,
      burn_block_hash: burnBlockMsg.burn_block_hash,
      burn_block_height: burnBlockMsg.burn_block_height,
      burn_amount: BigInt(burnBlockMsg.burn_amount),
      reward_recipient: r.recipient,
      reward_amount: BigInt(r.amt),
      reward_index: index,
    };
    return dbReward;
  });
  const slotHolders = burnBlockMsg.reward_slot_holders.map((r, index) => {
    const slotHolder: DbRewardSlotHolder = {
      canonical: true,
      burn_block_hash: burnBlockMsg.burn_block_hash,
      burn_block_height: burnBlockMsg.burn_block_height,
      address: r,
      slot_index: index,
    };
    return slotHolder;
  });
  await db.updateBurnchainRewards({
    burnchainBlockHash: burnBlockMsg.burn_block_hash,
    burnchainBlockHeight: burnBlockMsg.burn_block_height,
    rewards: rewards,
  });
  await db.updateBurnchainRewardSlotHolders({
    burnchainBlockHash: burnBlockMsg.burn_block_hash,
    burnchainBlockHeight: burnBlockMsg.burn_block_height,
    slotHolders: slotHolders,
  });
}

async function handleMempoolTxsMessage(rawTxs: string[], db: DataStore): Promise<void> {
  logger.verbose(`Received ${rawTxs.length} mempool transactions`);
  // TODO: mempool-tx receipt date should be sent from the core-node
  const receiptDate = Math.round(Date.now() / 1000);
  const rawTxBuffers = rawTxs.map(str => hexToBuffer(str));
  const decodedTxs = rawTxBuffers.map(buffer => {
    const parsedTx = decodeTransaction(buffer);
    const txSender = getTxSenderAddress(parsedTx);
    const sponsorAddress = getTxSponsorAddress(parsedTx);
    return {
      txId: parsedTx.tx_id,
      sender: txSender,
      sponsorAddress,
      txData: parsedTx,
      rawTx: buffer,
    };
  });
  const dbMempoolTxs = decodedTxs.map(tx => {
    logger.verbose(`Received mempool tx: ${tx.txId}`);
    const dbMempoolTx = createDbMempoolTxFromCoreMsg({
      txId: tx.txId,
      txData: tx.txData,
      sender: tx.sender,
      sponsorAddress: tx.sponsorAddress,
      rawTx: tx.rawTx,
      receiptDate: receiptDate,
    });
    return dbMempoolTx;
  });
  await db.updateMempoolTxs({ mempoolTxs: dbMempoolTxs });
}

async function handleDroppedMempoolTxsMessage(
  msg: CoreNodeDropMempoolTxMessage,
  db: DataStore
): Promise<void> {
  logger.verbose(`Received ${msg.dropped_txids.length} dropped mempool txs`);
  const dbTxStatus = getTxDbStatus(msg.reason);
  await db.dropMempoolTxs({ status: dbTxStatus, txIds: msg.dropped_txids });
}

async function handleMicroblockMessage(
  chainId: ChainID,
  msg: CoreNodeMicroblockMessage,
  db: DataStore
): Promise<void> {
  logger.verbose(`Received microblock with ${msg.transactions.length} txs`);
  const dbMicroblocks = parseMicroblocksFromTxs({
    parentIndexBlockHash: msg.parent_index_block_hash,
    txs: msg.transactions,
    parentBurnBlock: {
      height: msg.burn_block_height,
      hash: msg.burn_block_hash,
      time: msg.burn_block_timestamp,
    },
  });
  const parsedTxs: CoreNodeParsedTxMessage[] = [];
  msg.transactions.forEach(tx => {
    const blockData: CoreNodeMsgBlockData = {
      parent_index_block_hash: msg.parent_index_block_hash,

      parent_burn_block_timestamp: msg.burn_block_timestamp,
      parent_burn_block_height: msg.burn_block_height,
      parent_burn_block_hash: msg.burn_block_hash,

      // These properties aren't known until the next anchor block that accepts this microblock.
      burn_block_time: -1,
      burn_block_height: -1,
      index_block_hash: '',
      block_hash: '',

      // These properties can be determined with a db query, they are set while the db is inserting them.
      block_height: -1,
      parent_block_hash: '',
    };
    const parsedTx = parseMessageTransaction(chainId, tx, blockData, msg.events);
    if (parsedTx) {
      parsedTxs.push(parsedTx);
    }
  });
  parsedTxs.forEach(tx => {
    logger.verbose(`Received microblock mined tx: ${tx.core_tx.txid}`);
  });
  const updateData: DataStoreMicroblockUpdateData = {
    microblocks: dbMicroblocks,
    txs: parseDataStoreTxEventData(
      parsedTxs,
      msg.events,
      {
        block_height: -1, // TODO: fill during initial db insert
        index_block_hash: '',
      },
      chainId
    ),
  };
  await db.updateMicroblocks(updateData);
}

async function handleBlockMessage(
  chainId: ChainID,
  msg: CoreNodeBlockMessage,
  db: DataStore
): Promise<void> {
  const parsedTxs: CoreNodeParsedTxMessage[] = [];
  const blockData: CoreNodeMsgBlockData = {
    ...msg,
  };
  msg.transactions.forEach(item => {
    const parsedTx = parseMessageTransaction(chainId, item, blockData, msg.events);
    if (parsedTx) {
      parsedTxs.push(parsedTx);
    }
  });

  const dbBlock: DbBlock = {
    canonical: true,
    block_hash: msg.block_hash,
    index_block_hash: msg.index_block_hash,
    parent_index_block_hash: msg.parent_index_block_hash,
    parent_block_hash: msg.parent_block_hash,
    parent_microblock_hash: msg.parent_microblock,
    parent_microblock_sequence: msg.parent_microblock_sequence,
    block_height: msg.block_height,
    burn_block_time: msg.burn_block_time,
    burn_block_hash: msg.burn_block_hash,
    burn_block_height: msg.burn_block_height,
    miner_txid: msg.miner_txid,
    execution_cost_read_count: 0,
    execution_cost_read_length: 0,
    execution_cost_runtime: 0,
    execution_cost_write_count: 0,
    execution_cost_write_length: 0,
  };

  logger.verbose(`Received block ${msg.block_hash} (${msg.block_height}) from node`, dbBlock);

  const dbMinerRewards: DbMinerReward[] = [];
  for (const minerReward of msg.matured_miner_rewards) {
    const dbMinerReward: DbMinerReward = {
      canonical: true,
      block_hash: minerReward.from_stacks_block_hash,
      index_block_hash: msg.index_block_hash,
      from_index_block_hash: minerReward.from_index_consensus_hash,
      mature_block_height: msg.block_height,
      recipient: minerReward.recipient,
      coinbase_amount: BigInt(minerReward.coinbase_amount),
      tx_fees_anchored: BigInt(minerReward.tx_fees_anchored),
      tx_fees_streamed_confirmed: BigInt(minerReward.tx_fees_streamed_confirmed),
      tx_fees_streamed_produced: BigInt(minerReward.tx_fees_streamed_produced),
    };
    dbMinerRewards.push(dbMinerReward);
  }

  logger.verbose(`Received ${dbMinerRewards.length} matured miner rewards`);

  const dbMicroblocks = parseMicroblocksFromTxs({
    parentIndexBlockHash: msg.parent_index_block_hash,
    txs: msg.transactions,
    parentBurnBlock: {
      height: msg.parent_burn_block_height,
      hash: msg.parent_burn_block_hash,
      time: msg.parent_burn_block_timestamp,
    },
  }).map(mb => {
    const microblock: DbMicroblock = {
      ...mb,
      canonical: true,
      microblock_canonical: true,
      block_height: msg.block_height,
      parent_block_height: msg.block_height - 1,
      parent_block_hash: msg.parent_block_hash,
      index_block_hash: msg.index_block_hash,
      block_hash: msg.block_hash,
    };
    return microblock;
  });

  parsedTxs.forEach(tx => {
    logger.verbose(`Received anchor block mined tx: ${tx.core_tx.txid}`);
    logger.info('Transaction confirmed', {
      txid: tx.core_tx.txid,
      in_microblock: tx.microblock_hash != '',
      stacks_height: dbBlock.block_height,
    });
  });

  const dbData: DataStoreBlockUpdateData = {
    block: dbBlock,
    microblocks: dbMicroblocks,
    minerRewards: dbMinerRewards,
    txs: parseDataStoreTxEventData(parsedTxs, msg.events, msg, chainId),
  };

  await db.update(dbData);
}

function parseDataStoreTxEventData(
  parsedTxs: CoreNodeParsedTxMessage[],
  events: CoreNodeEvent[],
  blockData: {
    block_height: number;
    index_block_hash: string;
  },
  chainId: ChainID
): DataStoreTxEventData[] {
  const dbData: DataStoreTxEventData[] = parsedTxs.map(tx => {
    const dbTx: DataStoreBlockUpdateData['txs'][number] = {
      tx: createDbTxFromCoreMsg(tx),
      stxEvents: [],
      stxLockEvents: [],
      ftEvents: [],
      nftEvents: [],
      contractLogEvents: [],
      smartContracts: [],
      names: [],
      namespaces: [],
    };
    switch (tx.parsed_tx.payload.type_id) {
      case TxPayloadTypeID.SmartContract:
        const contractId = `${tx.sender_address}.${tx.parsed_tx.payload.contract_name}`;
        dbTx.smartContracts.push({
          tx_id: tx.core_tx.txid,
          contract_id: contractId,
          block_height: blockData.block_height,
          source_code: tx.parsed_tx.payload.code_body,
          abi: JSON.stringify(tx.core_tx.contract_abi),
          canonical: true,
        });
        break;
      case TxPayloadTypeID.ContractCall:
        // Name renewals can happen without a zonefile_hash. In that case, the BNS contract does NOT
        // emit a `name-renewal` contract log, causing us to miss this event. This function catches
        // those cases.
        const name = parseNameRenewalWithNoZonefileHashFromContractCall(tx, chainId);
        if (name) {
          dbTx.names.push(name);
        }
        break;
      default:
        break;
    }
    return dbTx;
  });

  for (const event of events) {
    if (!event.committed) {
      logger.verbose(`Ignoring uncommitted tx event from tx ${event.txid}`);
      continue;
    }
    const dbTx = dbData.find(entry => entry.tx.tx_id === event.txid);
    if (!dbTx) {
      throw new Error(`Unexpected missing tx during event parsing by tx_id ${event.txid}`);
    }

    const dbEvent: DbEventBase = {
      event_index: event.event_index,
      tx_id: event.txid,
      tx_index: dbTx.tx.tx_index,
      block_height: blockData.block_height,
      canonical: true,
    };

    switch (event.type) {
      case CoreNodeEventType.ContractEvent: {
        const entry: DbSmartContractEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.SmartContractLog,
          contract_identifier: event.contract_event.contract_identifier,
          topic: event.contract_event.topic,
          value: hexToBuffer(event.contract_event.raw_value),
        };
        dbTx.contractLogEvents.push(entry);
        // Check if we have new BNS names or namespaces.
        const parsedTx = parsedTxs.find(entry => entry.core_tx.txid === event.txid);
        if (!parsedTx) {
          throw new Error(`Unexpected missing tx during BNS parsing by tx_id ${event.txid}`);
        }
        const name = parseNameFromContractEvent(
          event,
          parsedTx,
          events,
          blockData.block_height,
          chainId
        );
        if (name) {
          dbTx.names.push(name);
        }
        const namespace = parseNamespaceFromContractEvent(event, parsedTx, blockData.block_height);
        if (namespace) {
          dbTx.namespaces.push(namespace);
        }
        break;
      }
      case CoreNodeEventType.StxLockEvent: {
        const entry: DbStxLockEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxLock,
          locked_amount: BigInt(event.stx_lock_event.locked_amount),
          unlock_height: Number(event.stx_lock_event.unlock_height),
          locked_address: event.stx_lock_event.locked_address,
        };
        dbTx.stxLockEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxTransferEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          sender: event.stx_transfer_event.sender,
          recipient: event.stx_transfer_event.recipient,
          amount: BigInt(event.stx_transfer_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxMintEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.stx_mint_event.recipient,
          amount: BigInt(event.stx_mint_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxBurnEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.stx_burn_event.sender,
          amount: BigInt(event.stx_burn_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtTransferEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          sender: event.ft_transfer_event.sender,
          recipient: event.ft_transfer_event.recipient,
          asset_identifier: event.ft_transfer_event.asset_identifier,
          amount: BigInt(event.ft_transfer_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtMintEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.ft_mint_event.recipient,
          asset_identifier: event.ft_mint_event.asset_identifier,
          amount: BigInt(event.ft_mint_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtBurnEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.ft_burn_event.sender,
          asset_identifier: event.ft_burn_event.asset_identifier,
          amount: BigInt(event.ft_burn_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftTransferEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          recipient: event.nft_transfer_event.recipient,
          sender: event.nft_transfer_event.sender,
          asset_identifier: event.nft_transfer_event.asset_identifier,
          value: hexToBuffer(event.nft_transfer_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftMintEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.nft_mint_event.recipient,
          asset_identifier: event.nft_mint_event.asset_identifier,
          value: hexToBuffer(event.nft_mint_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftBurnEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.nft_burn_event.sender,
          asset_identifier: event.nft_burn_event.asset_identifier,
          value: hexToBuffer(event.nft_burn_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      default: {
        throw new Error(`Unexpected CoreNodeEventType: ${inspect(event)}`);
      }
    }
  }

  // Normalize event indexes from per-block to per-transaction contiguous series.
  for (const tx of dbData) {
    const sortedEvents = [
      tx.contractLogEvents,
      tx.ftEvents,
      tx.nftEvents,
      tx.stxEvents,
      tx.stxLockEvents,
    ]
      .flat()
      .sort((a, b) => a.event_index - b.event_index);
    tx.tx.event_count = sortedEvents.length;
    for (let i = 0; i < sortedEvents.length; i++) {
      sortedEvents[i].event_index = i;
    }
  }

  return dbData;
}

async function handleNewAttachmentMessage(msg: CoreNodeAttachmentMessage[], db: DataStore) {
  const attachments = msg
    .map(message => {
      if (
        message.contract_id === BnsContractIdentifier.mainnet ||
        message.contract_id === BnsContractIdentifier.testnet
      ) {
        const metadataCV = decodeClarityValue<
          ClarityValueTuple<{
            op: ClarityValueStringAscii;
            name: ClarityValueBuffer;
            namespace: ClarityValueBuffer;
          }>
        >(message.metadata);
        return {
          op: metadataCV.data['op'].data,
          zonefile: message.content.slice(2),
          name: hexToBuffer(metadataCV.data['name'].buffer).toString('utf8'),
          namespace: hexToBuffer(metadataCV.data['namespace'].buffer).toString('utf8'),
          zonefileHash: message.content_hash,
          txId: message.tx_id,
          indexBlockHash: message.index_block_hash,
          blockHeight: Number.parseInt(message.block_height, 10),
        } as DataStoreAttachmentData;
      }
    })
    .filter((msg): msg is DataStoreAttachmentData => !!msg);
  await db.updateAttachments(attachments);
}

interface EventMessageHandler {
  handleRawEventRequest(eventPath: string, payload: string, db: DataStore): Promise<void> | void;
  handleBlockMessage(
    chainId: ChainID,
    msg: CoreNodeBlockMessage,
    db: DataStore
  ): Promise<void> | void;
  handleMicroblockMessage(
    chainId: ChainID,
    msg: CoreNodeMicroblockMessage,
    db: DataStore
  ): Promise<void> | void;
  handleMempoolTxs(rawTxs: string[], db: DataStore): Promise<void> | void;
  handleBurnBlock(msg: CoreNodeBurnBlockMessage, db: DataStore): Promise<void> | void;
  handleDroppedMempoolTxs(msg: CoreNodeDropMempoolTxMessage, db: DataStore): Promise<void> | void;
  handleNewAttachment(msg: CoreNodeAttachmentMessage[], db: DataStore): Promise<void> | void;
}

function createMessageProcessorQueue(): EventMessageHandler {
  // Create a promise queue so that only one message is handled at a time.
  const processorQueue = new PQueue({ concurrency: 1 });
  const handler: EventMessageHandler = {
    handleRawEventRequest: (eventPath: string, payload: string, db: DataStore) => {
      return processorQueue
        .add(() => handleRawEventRequest(eventPath, payload, db))
        .catch(e => {
          logError(`Error storing raw core node request data`, e, payload);
          throw e;
        });
    },
    handleBlockMessage: (chainId: ChainID, msg: CoreNodeBlockMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleBlockMessage(chainId, msg, db))
        .catch(e => {
          logError(`Error processing core node block message`, e, msg);
          throw e;
        });
    },
    handleMicroblockMessage: (chainId: ChainID, msg: CoreNodeMicroblockMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleMicroblockMessage(chainId, msg, db))
        .catch(e => {
          logError(`Error processing core node microblock message`, e, msg);
          throw e;
        });
    },
    handleBurnBlock: (msg: CoreNodeBurnBlockMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleBurnBlockMessage(msg, db))
        .catch(e => {
          logError(`Error processing core node burn block message`, e, msg);
          throw e;
        });
    },
    handleMempoolTxs: (rawTxs: string[], db: DataStore) => {
      return processorQueue
        .add(() => handleMempoolTxsMessage(rawTxs, db))
        .catch(e => {
          logError(`Error processing core node mempool message`, e, rawTxs);
          throw e;
        });
    },
    handleDroppedMempoolTxs: (msg: CoreNodeDropMempoolTxMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleDroppedMempoolTxsMessage(msg, db))
        .catch(e => {
          logError(`Error processing core node dropped mempool txs message`, e, msg);
          throw e;
        });
    },
    handleNewAttachment: (msg: CoreNodeAttachmentMessage[], db: DataStore) => {
      return processorQueue
        .add(() => handleNewAttachmentMessage(msg, db))
        .catch(e => {
          logError(`Error processing new attachment message`, e, msg);
          throw e;
        });
    },
  };

  return handler;
}

export type EventStreamServer = net.Server & {
  serverAddress: net.AddressInfo;
  closeAsync: () => Promise<void>;
};

export async function startEventServer(opts: {
  datastore: DataStore;
  chainId: ChainID;
  messageHandler?: EventMessageHandler;
  /** If not specified, this is read from the STACKS_CORE_EVENT_HOST env var. */
  serverHost?: string;
  /** If not specified, this is read from the STACKS_CORE_EVENT_PORT env var. */
  serverPort?: number;
  httpLogLevel?: LogLevel;
}): Promise<EventStreamServer> {
  const db = opts.datastore;
  const messageHandler = opts.messageHandler ?? createMessageProcessorQueue();

  let eventHost = opts.serverHost ?? process.env['STACKS_CORE_EVENT_HOST'];
  const eventPort = opts.serverPort ?? parseInt(process.env['STACKS_CORE_EVENT_PORT'] ?? '', 10);
  if (!eventHost) {
    throw new Error(
      `STACKS_CORE_EVENT_HOST must be specified, e.g. "STACKS_CORE_EVENT_HOST=127.0.0.1"`
    );
  }
  if (!Number.isInteger(eventPort)) {
    throw new Error(`STACKS_CORE_EVENT_PORT must be specified, e.g. "STACKS_CORE_EVENT_PORT=3700"`);
  }

  if (eventHost.startsWith('http:')) {
    const { hostname } = new URL(eventHost);
    eventHost = hostname;
  }

  const app = express();

  app.use(
    expressWinston.logger({
      format: logger.format,
      transports: logger.transports,
      metaField: (null as unknown) as string,
      statusLevels: {
        error: 'error',
        warn: opts.httpLogLevel ?? 'http',
        success: opts.httpLogLevel ?? 'http',
      },
    })
  );

  app.use(bodyParser.json({ type: 'application/json', limit: '500MB' }));
  app.get('/', (req, res) => {
    res
      .status(200)
      .json({ status: 'ready', msg: 'API event server listening for core-node POST messages' });
  });

  app.post(
    '*',
    asyncHandler(async (req, res, next) => {
      const eventPath = req.path;
      let payload = JSON.stringify(req.body);
      await messageHandler.handleRawEventRequest(eventPath, payload, db);
      if (logger.isDebugEnabled()) {
        // Skip logging massive event payloads, this _should_ only exclude the genesis block payload which is ~80 MB.
        if (payload.length > 10_000_000) {
          payload = 'payload body too large for logging';
        }
        logger.debug(`[stacks-node event] ${eventPath} ${payload}`);
      }
      next();
    })
  );

  app.post(
    '/new_block',
    asyncHandler(async (req, res) => {
      try {
        const msg: CoreNodeBlockMessage = req.body;
        await messageHandler.handleBlockMessage(opts.chainId, msg, db);
        res.status(200).json({ result: 'ok' });
      } catch (error) {
        logError(`error processing core-node /new_block: ${error}`, error);
        res.status(500).json({ error: error });
      }
    })
  );

  app.post(
    '/new_burn_block',
    asyncHandler(async (req, res) => {
      try {
        const msg: CoreNodeBurnBlockMessage = req.body;
        await messageHandler.handleBurnBlock(msg, db);
        res.status(200).json({ result: 'ok' });
      } catch (error) {
        logError(`error processing core-node /new_burn_block: ${error}`, error);
        res.status(500).json({ error: error });
      }
    })
  );

  app.post(
    '/new_mempool_tx',
    asyncHandler(async (req, res) => {
      try {
        const rawTxs: string[] = req.body;
        await messageHandler.handleMempoolTxs(rawTxs, db);
        res.status(200).json({ result: 'ok' });
      } catch (error) {
        logError(`error processing core-node /new_mempool_tx: ${error}`, error);
        res.status(500).json({ error: error });
      }
    })
  );

  app.post(
    '/drop_mempool_tx',
    asyncHandler(async (req, res) => {
      try {
        const msg: CoreNodeDropMempoolTxMessage = req.body;
        await messageHandler.handleDroppedMempoolTxs(msg, db);
        res.status(200).json({ result: 'ok' });
      } catch (error) {
        logError(`error processing core-node /drop_mempool_tx: ${error}`, error);
        res.status(500).json({ error: error });
      }
    })
  );

  app.post(
    '/attachments/new',
    asyncHandler(async (req, res) => {
      try {
        const msg: CoreNodeAttachmentMessage[] = req.body;
        await messageHandler.handleNewAttachment(msg, db);
        res.status(200).json({ result: 'ok' });
      } catch (error) {
        logError(`error processing core-node /attachments/new: ${error}`, error);
        res.status(500).json({ error: error });
      }
    })
  );

  app.post(
    '/new_microblocks',
    asyncHandler(async (req, res) => {
      try {
        const msg: CoreNodeMicroblockMessage = req.body;
        await messageHandler.handleMicroblockMessage(opts.chainId, msg, db);
        res.status(200).json({ result: 'ok' });
      } catch (error) {
        logError(`error processing core-node /new_microblocks: ${error}`, error);
        res.status(500).json({ error: error });
      }
    })
  );

  app.post('*', (req, res, next) => {
    res.status(404).json({ error: `no route handler for ${req.path}` });
    logError(`Unexpected event on path ${req.path}`);
    next();
  });

  app.use(
    expressWinston.errorLogger({
      winstonInstance: logger as winston.Logger,
      metaField: (null as unknown) as string,
      blacklistedMetaFields: ['trace', 'os', 'process'],
    })
  );

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => {
      reject(error);
    });
    server.listen(eventPort, eventHost as string, () => {
      resolve();
    });
  });

  const addr = server.address();
  if (addr === null) {
    throw new Error('server missing address');
  }
  const addrStr = typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`;
  logger.info(`Event observer listening at: http://${addrStr}`);

  const closeFn = async () => {
    await new Promise<void>((resolve, reject) => {
      logger.info('Closing event observer server...');
      server.close(error => (error ? reject(error) : resolve()));
    });
  };
  const eventStreamServer: EventStreamServer = Object.assign(server, {
    serverAddress: addr as net.AddressInfo,
    closeAsync: closeFn,
  });
  return eventStreamServer;
}

import * as express from 'express';
import { asyncHandler } from '../../async-handler';
import { DataStore } from '../../../datastore/common';
import { parsePagingQueryInput } from '../../../api/pagination';
import { isUnanchoredRequest } from '../../query-helpers';
import { bnsBlockchain, BnsErrors } from '../../../event-stream/bns/bns-constants';
import { BnsGetNameInfoResponse } from '@stacks/stacks-blockchain-api-types';
import { ChainID } from '@stacks/transactions';
import {
  getETagCacheHandler,
  setETagCacheHeaders,
} from '../../../api/controllers/cache-controller';

export function createBnsNamesRouter(db: DataStore, chainId: ChainID): express.Router {
  const router = express.Router();
  const cacheHandler = getETagCacheHandler(db);

  router.get(
    '/:name/zonefile/:zoneFileHash',
    cacheHandler,
    asyncHandler(async (req, res, next) => {
      const { name, zoneFileHash } = req.params;
      const includeUnanchored = isUnanchoredRequest(req, res, next);
      const zonefile = await db.getHistoricalZoneFile({
        name: name,
        zoneFileHash: zoneFileHash,
        includeUnanchored,
      });
      if (zonefile.found) {
        setETagCacheHeaders(res);
        res.json(zonefile.result);
      } else {
        res.status(404).json({ error: 'No such name or zonefile' });
      }
    })
  );

  router.get(
    '/:name/subdomains',
    cacheHandler,
    asyncHandler(async (req, res, next) => {
      const { name } = req.params;
      const includeUnanchored = isUnanchoredRequest(req, res, next);
      const subdomainsList = await db.getSubdomainsListInName({ name, includeUnanchored });
      setETagCacheHeaders(res);
      res.json(subdomainsList.results);
    })
  );

  router.get(
    '/:name/zonefile',
    cacheHandler,
    asyncHandler(async (req, res, next) => {
      const { name } = req.params;
      const includeUnanchored = isUnanchoredRequest(req, res, next);
      const zonefile = await db.getLatestZoneFile({ name: name, includeUnanchored });
      if (zonefile.found) {
        setETagCacheHeaders(res);
        res.json(zonefile.result);
      } else {
        res.status(404).json({ error: 'No such name or zonefile does not exist' });
      }
    })
  );

  router.get(
    '/',
    cacheHandler,
    asyncHandler(async (req, res, next) => {
      const page = parsePagingQueryInput(req.query.page ?? 0);
      const includeUnanchored = isUnanchoredRequest(req, res, next);
      const { results } = await db.getNamesList({ page, includeUnanchored });
      if (results.length === 0 && req.query.page) {
        res.status(400).json(BnsErrors.InvalidPageNumber);
      } else {
        setETagCacheHeaders(res);
        res.json(results);
      }
    })
  );

  router.get(
    '/:name',
    cacheHandler,
    asyncHandler(async (req, res, next) => {
      const { name } = req.params;
      const includeUnanchored = isUnanchoredRequest(req, res, next);
      let nameInfoResponse: BnsGetNameInfoResponse;
      // Subdomain case
      if (name.split('.').length == 3) {
        const subdomainQuery = await db.getSubdomain({ subdomain: name, includeUnanchored });
        if (!subdomainQuery.found) {
          const namePart = name.split('.').slice(1).join('.');
          const resolverResult = await db.getSubdomainResolver({ name: namePart });
          if (resolverResult.found) {
            if (resolverResult.result === '') {
              res.status(404).json({ error: `missing resolver from a malformed zonefile` });
              return;
            }
            res.redirect(`${resolverResult.result}/v1/names${req.url}`);
            return;
          }
          res.status(404).json({ error: `cannot find subdomain ${name}` });
          return;
        }
        const { result } = subdomainQuery;

        nameInfoResponse = {
          address: result.owner,
          blockchain: bnsBlockchain,
          last_txid: result.tx_id,
          resolver: result.resolver,
          status: 'registered_subdomain',
          zonefile: result.zonefile,
          zonefile_hash: result.zonefile_hash,
        };
      } else {
        const nameQuery = await db.getName({
          name,
          includeUnanchored: includeUnanchored,
          chainId: chainId,
        });
        if (!nameQuery.found) {
          res.status(404).json({ error: `cannot find name ${name}` });
          return;
        }
        const { result } = nameQuery;
        nameInfoResponse = {
          address: result.address,
          blockchain: bnsBlockchain,
          expire_block: result.expire_block,
          grace_period: result.grace_period,
          last_txid: result.tx_id ? result.tx_id : '',
          resolver: result.resolver,
          status: result.status ? result.status : '',
          zonefile: result.zonefile,
          zonefile_hash: result.zonefile_hash,
        };
      }

      const response = Object.fromEntries(
        Object.entries(nameInfoResponse).filter(([_, v]) => v != null)
      );
      setETagCacheHeaders(res);
      res.json(response);
    })
  );

  return router;
}

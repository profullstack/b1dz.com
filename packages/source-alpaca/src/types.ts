/**
 * Local type barrel for the Alpaca connector. Re-exports the broker contract
 * from @b1dz/core (the public surface every connector implements) and the raw
 * Alpaca wire types, so the rest of the package imports from one place.
 */
export type {
  BrokerConnectorPlugin,
  BrokerOrderResult,
  BrokerOrderArgs,
  BrokerPosition,
  BrokerQuote,
  MarketSession,
  PluginManifest,
} from '@b1dz/core';

export type {
  AlpacaConfig,
  AlpacaAccount,
  AlpacaPositionRaw,
  AlpacaClock,
  AlpacaQuoteRaw,
  AlpacaTradeRaw,
  AlpacaOrderRaw,
  AlpacaOrderRequest,
} from './alpaca-client.js';

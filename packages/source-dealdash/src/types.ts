/**
 * DealDash domain types — used by strategy + polling modules.
 *
 * Mirror the shape of the data the TUI's lifted code already operates on
 * (DisplayAuction, AuctionInfo) but live as proper typed exports under
 * @b1dz/source-dealdash so the daemon can consume them without depending
 * on the vendored TUI module.
 */

export interface DealDashAuction {
  id: number;
  title: string;
  /** Total distinct bidders in the auction (us + others) */
  bidders: number;
  /** Number of opponents currently bidding (bidders − 1 if we're in) */
  othersBidding: number;
  /** Current displayed price */
  ddPrice: number;
  /** Currently allocated BidBuddy bids on our side */
  bidsBooked: number;
  /** Total bids we have ever placed on this auction */
  bidsSpent: number;
  /** Total bids placed by everyone on this auction */
  totalBids: number;
}

export interface MarketEntry {
  min: number;
  median: number;
  mean?: number;
  count: number;
}

export interface ResaleValue {
  value: number;
  source: 'pack' | 'market';
}

export interface StrategyConfig {
  /** Per-bid cost we paid based on past purchases (~$0.10-$0.12) */
  costPerBid: number;
  /** Live store rate we'd pay for new bids ($0.13-$0.15) */
  storeBidPrice: number;
  /** Base profit floor for non-pack new entries */
  nonPackBaseFloor: number;
  /** Profit floor for rebooking auctions we're already in */
  rebookFloor: number;
  /** $/bid ceiling for bid packs — abandon when crossed */
  maxPackPerBid: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  costPerBid: 0.107,
  storeBidPrice: 0.15,
  nonPackBaseFloor: 500,
  rebookFloor: 500,
  maxPackPerBid: 0.05,
};

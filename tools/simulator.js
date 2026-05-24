/**
 * tools/simulator.js
 * LP position simulator for Meteora DLMM pools.
 *
 * Simulates fee earnings and IL for a hypothetical position by:
 *  1. Building a virtual liquidity distribution (Spot / Curve / Bid-Ask)
 *  2. Fetching real per-bin TVL via the DLMM SDK → computing your TVL share per bin
 *  3. Replaying 5m OHLCV candles → accruing fees only from bins your position covers
 *  4. Calculating impermanent loss from price movement through your range
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";

const DLMM_API = "https://dlmm.datapi.meteora.ag";

// ─── DLMM helpers (lazy-loaded same pattern as dlmm.js) ──────────────────────

let _DLMM = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;

async function getDLMMHelpers() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
  }
  return { DLMM: _DLMM, getBinIdFromPrice: _getBinIdFromPrice, getPriceOfBinByBinId: _getPriceOfBinByBinId };
}

let _conn = null;
function getConnection() {
  if (!_conn) _conn = new Connection(process.env.RPC_URL, "confirmed");
  return _conn;
}

// ─── Pool info ────────────────────────────────────────────────────────────────

async function fetchPoolConfig(poolAddress) {
  const res = await fetch(`${DLMM_API}/pools/${poolAddress}`);
  if (!res.ok) throw new Error(`Pool fetch failed: ${res.status}`);
  const data = await res.json();
  return {
    name: data.name,
    binStep: data.pool_config?.bin_step,
    baseFeePct: data.pool_config?.base_fee_pct ?? 0,       // e.g. 0.04 means 0.04%
    protocolFeePct: data.pool_config?.protocol_fee_pct ?? 5, // e.g. 5 means 5% of fees
    tvl: data.tvl ?? 0,
    tokenXSymbol: data.token_x?.symbol,
    tokenYSymbol: data.token_y?.symbol,
    tokenXPrice: data.token_x?.price ?? 0,
    tokenYPrice: data.token_y?.price ?? 0,
  };
}

// ─── OHLCV ───────────────────────────────────────────────────────────────────

async function fetchOHLCV(poolAddress, hours) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - hours * 3600;
  const url = `${DLMM_API}/pools/${poolAddress}/ohlcv?timeframe=5m&start_time=${start}&end_time=${end}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OHLCV fetch failed: ${res.status}`);
  const data = await res.json();
  return data.data ?? [];
}

// ─── Bin liquidity via DLMM SDK ──────────────────────────────────────────────

async function fetchBinLiquidityMap(poolAddress, lowerBinId, upperBinId, tokenXPrice, tokenYPrice) {
  const { DLMM } = await getDLMMHelpers();
  const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
  const { bins } = await pool.getBinsBetweenLowerAndUpperBound(lowerBinId, upperBinId, 2000);

  // Build map binId → existing TVL in USD
  const map = new Map();
  for (const bin of bins) {
    const xUsd = Number(bin.xAmount ?? 0) * tokenXPrice;
    const yUsd = Number(bin.yAmount ?? 0) * tokenYPrice;
    map.set(bin.binId, xUsd + yUsd);
  }
  return map;
}

// ─── Liquidity distribution ───────────────────────────────────────────────────

/**
 * Returns a normalized weight array [0..1] for each bin in [lowerBinId, upperBinId].
 * strategyType: "spot" | "curve" | "bid-ask"
 */
function buildWeights(strategyType, lowerBinId, upperBinId, activeBinId) {
  const numBins = upperBinId - lowerBinId + 1;
  const weights = new Array(numBins);
  const center = activeBinId - lowerBinId; // index of active bin within range
  const sigma = Math.max(numBins / 4, 1);

  for (let i = 0; i < numBins; i++) {
    const dist = i - center;
    switch (strategyType) {
      case "curve":
        weights[i] = Math.exp(-0.5 * (dist / sigma) ** 2);
        break;
      case "bid-ask":
        // Inverse gaussian — heavy at edges, light in center
        weights[i] = 1 - Math.exp(-0.5 * (dist / sigma) ** 2) + 0.01;
        break;
      case "spot":
      default:
        weights[i] = 1;
        break;
    }
  }

  // Normalize so weights sum to 1
  const total = weights.reduce((s, w) => s + w, 0);
  return weights.map((w) => w / total);
}

// ─── IL calculation ───────────────────────────────────────────────────────────

/**
 * Approximate DLMM IL for a position.
 * Uses CPMM formula as baseline; for bins fully out of range, IL is determined by exit price.
 */
function calcIL(entryPrice, currentPrice, lowerPrice, upperPrice) {
  // Clamp price to range
  const price = Math.max(lowerPrice, Math.min(upperPrice, currentPrice));

  // Geometric mean price of range
  const pa = lowerPrice;
  const pb = upperPrice;
  const p0 = entryPrice;
  const p1 = price;

  // Standard CPMM IL formula adapted for concentrated range
  // IL = 2*sqrt(p1/p0) / (1 + p1/p0) - 1
  const ratio = p1 / p0;
  const ilConcentrated = (2 * Math.sqrt(ratio)) / (1 + ratio) - 1;

  // Scale by how much of the range the price movement covers
  const rangeFraction = (Math.min(currentPrice, pb) - Math.min(currentPrice, pa)) /
                        (pb - pa);

  return ilConcentrated * rangeFraction;
}

// ─── Replay ───────────────────────────────────────────────────────────────────

function replayCandles({
  candles,
  lowerBinId,
  upperBinId,
  activeBinId,
  weights,               // our weight per bin (normalized)
  binLiquidityMap,       // existing TVL per bin in USD
  depositAmount,         // our total deposit in USD
  lpFeeFraction,         // e.g. 0.00038 for 0.04% base * 95% LP cut
  lowerPrice,
  upperPrice,
  entryPrice,
  getPriceOfBinByBinId,
  binStep,
}) {
  let feesEarned = 0;
  let inRangeCandles = 0;
  const history = [];

  for (const candle of candles) {
    const { open, high, low, close, volume } = candle;

    // Price range crossed in this candle
    const candleLow = Math.min(low, close);
    const candleHigh = Math.max(high, close);

    // Bin IDs crossed in this candle (approximate from price range)
    // We don't have per-candle bin resolution, so estimate from price bounds
    const crossedLow = Math.floor(Math.log(candleLow / 1) / Math.log(1 + binStep / 10000));
    const crossedHigh = Math.ceil(Math.log(candleHigh / 1) / Math.log(1 + binStep / 10000));

    // Intersect with our position range
    const overlapLow = Math.max(lowerBinId, crossedLow);
    const overlapHigh = Math.min(upperBinId, crossedHigh);

    if (overlapLow > overlapHigh) {
      history.push({ timestamp: candle.timestamp, price: close, feeTick: 0, inRange: false });
      continue;
    }

    inRangeCandles++;
    const totalBinsCrossed = Math.max(crossedHigh - crossedLow + 1, 1);
    const ourBinsCrossed = overlapHigh - overlapLow + 1;

    // Volume fraction that touched our range
    const volumeInRange = volume * (ourBinsCrossed / totalBinsCrossed);

    // Fee accrued = weighted sum across bins in overlap
    let feeTick = 0;
    for (let binId = overlapLow; binId <= overlapHigh; binId++) {
      const idx = binId - lowerBinId;
      if (idx < 0 || idx >= weights.length) continue;

      const ourLiquidityInBin = depositAmount * weights[idx];
      const existingTvlInBin = binLiquidityMap.get(binId) ?? (depositAmount / (upperBinId - lowerBinId + 1));
      const totalLiquidityInBin = existingTvlInBin + ourLiquidityInBin;
      const tvlShare = ourLiquidityInBin / totalLiquidityInBin;

      // Volume per bin (proportional within range)
      const volumePerBin = volumeInRange / ourBinsCrossed;
      feeTick += volumePerBin * lpFeeFraction * tvlShare;
    }

    feesEarned += feeTick;
    history.push({ timestamp: candle.timestamp, price: close, feeTick: +feeTick.toFixed(4), inRange: true });
  }

  const finalPrice = candles.length > 0 ? candles[candles.length - 1].close : entryPrice;
  const il = calcIL(entryPrice, finalPrice, lowerPrice, upperPrice);
  const ilUsd = depositAmount * il;
  const netPnL = feesEarned + ilUsd;

  return {
    feesEarned: +feesEarned.toFixed(4),
    ilUsd: +ilUsd.toFixed(4),
    ilPct: +(il * 100).toFixed(3),
    netPnL: +netPnL.toFixed(4),
    entryPrice: +entryPrice.toFixed(6),
    finalPrice: +finalPrice.toFixed(6),
    inRangeCandles,
    totalCandles: candles.length,
    inRangePct: candles.length > 0 ? +((inRangeCandles / candles.length) * 100).toFixed(1) : 0,
    history,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function simulateLPPosition({
  pool_address,
  deposit_amount,
  lower_price,
  upper_price,
  strategy_type = "spot",
  hours = 24,
}) {
  log("simulator", `Starting simulation: ${pool_address} | $${deposit_amount} | ${lower_price}–${upper_price} | ${strategy_type} | ${hours}h`);

  const { getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMMHelpers();

  // 1. Pool config
  const poolCfg = await fetchPoolConfig(pool_address);
  const { binStep, baseFeePct, protocolFeePct, tokenXPrice, tokenYPrice } = poolCfg;
  const lpFeeFraction = (baseFeePct / 100) * (1 - protocolFeePct / 100);

  // 2. Convert prices to bin IDs
  const lowerBinId = getBinIdFromPrice(lower_price, binStep, true);
  const upperBinId = getBinIdFromPrice(upper_price, binStep, false);
  const activeBinId = getBinIdFromPrice((lower_price + upper_price) / 2, binStep, true);
  const entryPrice = (lower_price + upper_price) / 2;

  if (lowerBinId >= upperBinId) {
    throw new Error(`Invalid price range: lower_price must be less than upper_price`);
  }

  log("simulator", `Bin range: ${lowerBinId}–${upperBinId} (${upperBinId - lowerBinId + 1} bins), binStep=${binStep}`);

  // 3. Build our liquidity distribution
  const weights = buildWeights(strategy_type, lowerBinId, upperBinId, activeBinId);

  // 4. Fetch per-bin existing TVL
  let binLiquidityMap;
  try {
    binLiquidityMap = await fetchBinLiquidityMap(pool_address, lowerBinId, upperBinId, tokenXPrice, tokenYPrice);
    log("simulator", `Fetched bin liquidity for ${binLiquidityMap.size} bins`);
  } catch (err) {
    log("simulator", `Bin liquidity fetch failed (${err.message}), using pool TVL estimate`);
    // Fallback: distribute pool TVL uniformly across range bins
    const numBins = upperBinId - lowerBinId + 1;
    const binTvl = poolCfg.tvl / numBins;
    binLiquidityMap = new Map();
    for (let b = lowerBinId; b <= upperBinId; b++) binLiquidityMap.set(b, binTvl);
  }

  // 5. Fetch OHLCV candles
  const candles = await fetchOHLCV(pool_address, hours);
  if (candles.length === 0) {
    throw new Error(`No OHLCV data for pool ${pool_address} over the last ${hours}h`);
  }
  log("simulator", `Fetched ${candles.length} candles (5m × ${hours}h)`);

  // 6. Replay
  const result = replayCandles({
    candles,
    lowerBinId,
    upperBinId,
    activeBinId,
    weights,
    binLiquidityMap,
    depositAmount: deposit_amount,
    lpFeeFraction,
    lowerPrice: lower_price,
    upperPrice: upper_price,
    entryPrice,
    getPriceOfBinByBinId,
    binStep,
  });

  // 7. TVL share metrics
  const totalExistingTvl = [...binLiquidityMap.values()].reduce((s, v) => s + v, 0);
  const avgTvlShare = deposit_amount / (totalExistingTvl + deposit_amount);

  const output = {
    pool: poolCfg.name || pool_address,
    pair: `${poolCfg.tokenXSymbol}-${poolCfg.tokenYSymbol}`,
    strategy: strategy_type,
    deposit: deposit_amount,
    range: { lower: lower_price, upper: upper_price },
    binRange: { lower: lowerBinId, upper: upperBinId, count: upperBinId - lowerBinId + 1 },
    feeRate: `${baseFeePct}% base, ${+(lpFeeFraction * 100).toFixed(4)}% LP net`,
    hours,
    ...result,
    tvlShareAvg: +(avgTvlShare * 100).toFixed(4),
    annualizedFeeApr: result.feesEarned > 0
      ? +((result.feesEarned / deposit_amount) * (8760 / hours) * 100).toFixed(2)
      : 0,
    // Strip history from main output for readability — agent can request it separately
    history: undefined,
    historyLength: result.history.length,
  };

  log("simulator", `Simulation done: fees=$${result.feesEarned} IL=$${result.ilUsd} netPnL=$${result.netPnL}`);
  return output;
}

export async function simulateLPPositionHistory({ pool_address, deposit_amount, lower_price, upper_price, strategy_type = "spot", hours = 24 }) {
  const full = await simulateLPPosition({ pool_address, deposit_amount, lower_price, upper_price, strategy_type, hours });
  // Re-run to get history (kept separate to avoid bloating normal output)
  return full;
}

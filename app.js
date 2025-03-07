const axios = require('axios');

// Configuration
const API_KEY = '7a58bcb89fc15b9b59803a5926f9a15a';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM`;
const POOL_ADDRESS = '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59'; // WETH/USDC pool
const SECONDS_PER_DAY = 86400;
const DAYS_PER_YEAR = 365;

// Reference values from frontend
const REFERENCE = [
  {
    lowerPrice: 2002.24,
    upperPrice: 2303.1,
    width: 300.86,
    apr: 149.62
  },
  {
    lowerPrice: 2083.95,
    upperPrice: 2235.04,
    width: 151.09,
    apr: 299.24
  }
];

/**
 * Calculate projected APR for a custom price range in USDC
 * @param {number} lowerPriceUSDC - Lower price in USDC (e.g., 2000)
 * @param {number} upperPriceUSDC - Upper price in USDC (e.g., 2300)
 */
async function calculateProjectedAPR(lowerPriceUSDC, upperPriceUSDC) {
  try {
    // Step 1: Fetch basic pool data
    const poolData = await fetchPoolData(POOL_ADDRESS);
    if (!poolData) {
      console.error('Failed to fetch pool data');
      return null;
    }

    console.log('Pool data:', JSON.stringify(poolData, null, 2));
    
    // Step 2: Get current tick and price
    const currentTick = parseInt(poolData.tick);
    const currentPrice = parseFloat(poolData.token1Price); // USDC per WETH
    
    console.log(`Current tick: ${currentTick}`);
    console.log(`Current price: ${currentPrice} USDC per WETH`);
    
    // For this specific pool, we need to understand that:
    // 1. Higher price = lower tick (they're inversely related)
    // 2. Since we're dealing with negative ticks, higher price = less negative tick
    
    // Calculate price-to-tick for WETH/USDC based on current values
    const priceToTickFactor = currentTick / Math.log(currentPrice);
    console.log(`Price-to-tick factor: ${priceToTickFactor}`);
    
    // Convert prices to ticks using the derived factor
    const lowerTick = Math.floor(priceToTickFactor * Math.log(upperPriceUSDC)); // Inverted because of price-tick relationship
    const upperTick = Math.ceil(priceToTickFactor * Math.log(lowerPriceUSDC)); 
    
    console.log(`Raw price-to-tick conversion: ${lowerTick} - ${upperTick}`);
    
    // Get fee tier and convert to tick spacing
    const feeTier = parseInt(poolData.feeTier);
    const tickSpacing = getTickSpacingFromFeeTier(feeTier);
    
    // Adjust ticks to valid tick spacing
    const adjustedLowerTick = Math.floor(lowerTick / tickSpacing) * tickSpacing;
    const adjustedUpperTick = Math.ceil(upperTick / tickSpacing) * tickSpacing;
    
    console.log(`Price range: ${lowerPriceUSDC} - ${upperPriceUSDC} USDC`);
    console.log(`Adjusted to tick spacing (${tickSpacing}): ${adjustedLowerTick} - ${adjustedUpperTick}`);
    
    // Step 5: Calculate position bins
    const positionTickRange = Math.abs(adjustedUpperTick - adjustedLowerTick);
    const positionBins = Math.floor(positionTickRange / tickSpacing);
    
    // Check if position is in range
    const isInRange = (currentTick <= adjustedLowerTick && currentTick >= adjustedUpperTick) ||
                      (currentTick >= adjustedLowerTick && currentTick <= adjustedUpperTick);
    console.log(`Position is ${isInRange ? 'IN' : 'OUT OF'} range`);
    
    // Step 6: Get historical fee data
    const timeFrame = 7; // Get 7-day data for better averaging
    const feeData = await fetchHistoricalFeeData(POOL_ADDRESS, timeFrame);
    
    // Step 7: Calculate Fee APR
    // Use either historical data or current fees if historical data is unavailable
    const dailyFeesUSD = feeData.dailyFeesUSD > 0 
      ? parseFloat(feeData.dailyFeesUSD)
      : parseFloat(poolData.feesUSD) / 7; // Assuming feesUSD is weekly
    
    // Calculate fee APR based on fees and position width
    const feeResult = calculateFeeAPR(
      dailyFeesUSD,
      parseFloat(poolData.liquidity),
      currentTick,
      adjustedLowerTick,
      adjustedUpperTick,
      tickSpacing,
      parseFloat(poolData.totalValueLockedUSD),
      isInRange
    );
    
    // Step 8: Calculate emissions APR based on frontend reference and range width
    const rangeWidthUSD = upperPriceUSDC - lowerPriceUSDC;
    const rangeWidthPct = rangeWidthUSD / currentPrice;
    
    // Calculate APR based on frontend behavior (improved inverse relationship)
    const emissionsAPR = calculateDynamicEmissionsAPR(rangeWidthUSD, isInRange);
    
    // Add fee APR and emissions APR for total
    const totalAPR = (feeResult.positionAPR + emissionsAPR);
    
    // Return the results
    return {
      pool: {
        id: POOL_ADDRESS,
        name: `${poolData.token0.symbol}/${poolData.token1.symbol}`,
        feeTier: feeTier / 10000, // Convert to percentage
        currentPrice: currentPrice,
        currentTick: currentTick,
        tickSpacing: tickSpacing
      },
      position: {
        lowerPriceUSDC: lowerPriceUSDC,
        upperPriceUSDC: upperPriceUSDC,
        lowerTick: adjustedLowerTick,
        upperTick: adjustedUpperTick,
        tickRange: positionTickRange,
        bins: positionBins,
        rangeWidthUSD: rangeWidthUSD,
        rangeWidthPct: rangeWidthPct,
        isInRange: isInRange
      },
      fees: {
        dailyFeesUSD: dailyFeesUSD,
        annualFeesUSD: dailyFeesUSD * DAYS_PER_YEAR,
        feeAPR: feeResult.positionAPR,
        emissionsAPR: emissionsAPR,
        totalAPR: totalAPR
      },
      reference: REFERENCE
    };
  } catch (error) {
    console.error('Error calculating projected APR:', error);
    if (error.response) {
      console.error('GraphQL response:', JSON.stringify(error.response.data));
    }
    return null;
  }
}

/**
 * Calculate emissions APR dynamically based on range width and reference values
 */
function calculateDynamicEmissionsAPR(rangeWidthUSD, isInRange) {
  if (!isInRange) {
    return 0; // No emissions if out of range
  }
  
  // Sort reference points by width (smallest to largest)
  const sortedRef = [...REFERENCE].sort((a, b) => a.width - b.width);
  
  // If range is narrower than the narrowest reference
  if (rangeWidthUSD < sortedRef[0].width) {
    // Extrapolate higher APR for narrower ranges
    const ratio = sortedRef[0].width / rangeWidthUSD;
    return sortedRef[0].apr * ratio;
  }
  
  // If range is wider than the widest reference
  if (rangeWidthUSD > sortedRef[sortedRef.length - 1].width) {
    // Extrapolate lower APR for wider ranges
    const ratio = sortedRef[sortedRef.length - 1].width / rangeWidthUSD;
    return sortedRef[sortedRef.length - 1].apr * ratio;
  }
  
  // For ranges between reference points, interpolate
  for (let i = 0; i < sortedRef.length - 1; i++) {
    if (rangeWidthUSD >= sortedRef[i].width && rangeWidthUSD <= sortedRef[i + 1].width) {
      // Linear interpolation between reference points
      const widthRatio = (rangeWidthUSD - sortedRef[i].width) / (sortedRef[i + 1].width - sortedRef[i].width);
      return sortedRef[i].apr + (sortedRef[i + 1].apr - sortedRef[i].apr) * (1 - widthRatio);
    }
  }
  
  // Fallback: use inverse relationship with the closest reference point
  const closestRef = sortedRef.reduce((prev, curr) => 
    Math.abs(curr.width - rangeWidthUSD) < Math.abs(prev.width - rangeWidthUSD) ? curr : prev
  );
  
  const ratio = closestRef.width / rangeWidthUSD;
  return closestRef.apr * ratio;
}

/**
 * Calculate fee APR for a position
 */
function calculateFeeAPR(
  dailyFeesUSD,
  liquidity,
  currentTick,
  lowerTick,
  upperTick,
  tickSpacing,
  totalValueLockedUSD,
  isInRange
) {
  // Calculate annual fees
  const annualFeesUSD = dailyFeesUSD * DAYS_PER_YEAR;
  
  // Safety check for liquidity
  if (liquidity === 0 || totalValueLockedUSD === 0) {
    console.log('Zero liquidity or TVL detected, returning 0 APR');
    return {
      activeRangeAPR: 0,
      positionAPR: 0
    };
  }
  
  // Calculate active range APR (fees per unit of liquidity in the active range)
  // Use TVL for APR calculation as it's more reliable than raw liquidity numbers
  const activeRangeAPR = (annualFeesUSD / totalValueLockedUSD) * 100;
  
  // Calculate position APR based on the number of bins
  const positionBins = Math.floor(Math.abs(upperTick - lowerTick) / tickSpacing);
  
  // If position bins is zero, prevent division by zero
  if (positionBins <= 0) {
    return {
      activeRangeAPR: activeRangeAPR,
      positionAPR: 0
    };
  }
  
  // If the position is out of range, no fees
  if (!isInRange) {
    return {
      activeRangeAPR: activeRangeAPR,
      positionAPR: 0 // Out of range
    };
  }
  
  // Calculate position APR - following your formula:
  // Position APR = Active Range APR / Number of Bins
  const positionAPR = activeRangeAPR / positionBins;
  
  return {
    activeRangeAPR,
    positionAPR
  };
}

/**
 * Fetch pool data from the subgraph
 */
async function fetchPoolData(poolId) {
  const formattedPoolId = poolId.toLowerCase();
  console.log(`Fetching data for pool: ${formattedPoolId}`);
  
  const query = `
    {
      pool(id: "${formattedPoolId}") {
        id
        feeTier
        liquidity
        sqrtPrice
        tick
        feesUSD
        token0 {
          id
          symbol
          decimals
        }
        token1 {
          id
          symbol
          decimals
        }
        token0Price
        token1Price
        totalValueLockedUSD
      }
    }
  `;

  try {
    const response = await axios.post(SUBGRAPH_URL, { query });
    
    if (response.data && response.data.data && response.data.data.pool) {
      return response.data.data.pool;
    }
    
    if (response.data && response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching pool data:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return null;
  }
}

/**
 * Fetch historical fee data for better APR estimation
 */
async function fetchHistoricalFeeData(poolId, days = 7) {
  const formattedPoolId = poolId.toLowerCase();
  const timestamp = Math.floor(Date.now() / 1000) - (days * SECONDS_PER_DAY);
  
  const query = `
    {
      poolDayDatas(
        first: ${days}
        orderBy: date
        orderDirection: desc
        where: {
          pool: "${formattedPoolId}"
          date_gt: ${timestamp}
        }
      ) {
        date
        feesUSD
        volumeUSD
      }
    }
  `;

  try {
    const response = await axios.post(SUBGRAPH_URL, { query });
    
    if (response.data && response.data.data && response.data.data.poolDayDatas) {
      const dayDatas = response.data.data.poolDayDatas;
      
      if (dayDatas.length === 0) {
        console.log('No historical fee data found for the specified period');
        return { dailyFeesUSD: 0 };
      }
      
      // Calculate average daily fees
      const totalFees = dayDatas.reduce((sum, day) => sum + parseFloat(day.feesUSD || 0), 0);
      const dailyFeesUSD = totalFees / dayDatas.length;
      
      console.log(`Historical daily fees: $${dailyFeesUSD.toFixed(2)} (based on ${dayDatas.length} days)`);
      return { dailyFeesUSD };
    }
    
    if (response.data && response.data.errors) {
      console.error('GraphQL errors fetching historical data:', response.data.errors);
    }
    
    return { dailyFeesUSD: 0 };
  } catch (error) {
    console.error('Error fetching historical fee data:', error.message);
    return { dailyFeesUSD: 0 };
  }
}

/**
 * Get tick spacing based on fee tier
 */
function getTickSpacingFromFeeTier(feeTier) {
  switch (parseInt(feeTier)) {
    case 100: return 1;    // 0.01%
    case 500: return 10;   // 0.05%
    case 3000: return 60;  // 0.3%
    case 10000: return 200; // 1%
    default: 
      console.log(`Unknown fee tier: ${feeTier}, using default tick spacing of 60`);
      return 60;    // Default to 0.3%
  }
}

/**
 * Main function to calculate APR for a price range
 */
async function main() {
  // Get price range from command line or use defaults
  let lowerPriceUSDC, upperPriceUSDC;
  
  if (process.argv[2] && process.argv[3]) {
    lowerPriceUSDC = parseFloat(process.argv[2]);
    upperPriceUSDC = parseFloat(process.argv[3]);
  } else {
    // Default price range matching second frontend reference
    lowerPriceUSDC = 2083.95;
    upperPriceUSDC = 2235.04;
  }
  
  console.log(`Calculating APR for WETH/USDC position with price range: $${lowerPriceUSDC} - $${upperPriceUSDC}`);
  
  const result = await calculateProjectedAPR(lowerPriceUSDC, upperPriceUSDC);
  
  if (result) {
    console.log('\nAPR Calculation Results:');
    console.log('==================================================');
    console.log(`Pool: ${result.pool.name}`);
    console.log(`Fee Tier: ${result.pool.feeTier}%`);
    console.log(`Current Price: ${result.pool.currentPrice.toFixed(2)} USDC per WETH`);
    console.log(`Current Tick: ${result.pool.currentTick}`);
    console.log('--------------------------------------------------');
    console.log(`Position Range: $${result.position.lowerPriceUSDC.toFixed(2)} - $${result.position.upperPriceUSDC.toFixed(2)}`);
    console.log(`Range Width: $${result.position.rangeWidthUSD.toFixed(2)} (${(result.position.rangeWidthPct * 100).toFixed(2)}% of current price)`);
    console.log(`Tick Range: ${result.position.lowerTick} to ${result.position.upperTick}`);
    console.log(`Bins: ${result.position.bins}`);
    console.log(`Status: Position is ${result.position.isInRange ? 'IN' : 'OUT OF'} range`);
    console.log('--------------------------------------------------');
    console.log(`Fee APR: ${result.fees.feeAPR.toFixed(2)}%`);
    console.log(`Emissions APR: ${result.fees.emissionsAPR.toFixed(2)}%`);
    console.log(`Total APR: ${result.fees.totalAPR.toFixed(2)}%`);
    console.log('==================================================');
    
    // Print specific APR for known reference ranges for comparison
    console.log('\nReference Range APRs:');
    result.reference.forEach(ref => {
      console.log(`- Range $${ref.lowerPrice}-$${ref.upperPrice} (width $${ref.width.toFixed(2)}): ${ref.apr.toFixed(2)}%`);
    });
    
    console.log('\nAPR Calculation Method:');
    console.log('1. The emissions APR is calculated based on the range width.');
    console.log('2. Narrower ranges receive higher APRs, wider ranges receive lower APRs.');
    console.log('3. Uses reference points from the frontend to calibrate the calculation.');
    console.log('4. Fee APR is added to emissions APR for the total APR.');
  } else {
    console.log('Could not calculate APR');
  }
}

// Run the main function if this script is executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  calculateProjectedAPR
};
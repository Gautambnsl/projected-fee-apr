const axios = require('axios');

// Configuration
const API_KEY = 'f97dce9c42529efccec5ee1b8f5b86af';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/3utanEBA9nqMjPnuQP1vMCCys6enSM3EawBpKTVwnUw2`;
const WETH_USDC_POOL_ADDRESS = '0x00bf1da5140eabb4bf71a0b47e6672fa9c7be01a';
const SECONDS_PER_YEAR = 31536000;

// Function to fetch pool data using the exact schema fields
async function fetchPoolData(poolAddress) {
  console.log(`Fetching data for pool ${poolAddress}...`);
  
  const query = `
    {
      pool(id: "${poolAddress.toLowerCase()}") {
        id
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
        tickSpacing
        tick
        feesUSD
        volumeUSD
        totalValueLockedToken0
        totalValueLockedToken1
        totalValueLockedUSD
        token0Price
        token1Price
      }
    }
  `;

  try {
    const response = await axios.post(SUBGRAPH_URL, { query });
    
    if (response.data && response.data.data && response.data.data.pool) {
      return response.data.data.pool;
    } else {
      console.error('Error fetching pool data:', response.data.errors);
      if (response.data.errors) {
        response.data.errors.forEach(error => {
          console.error(`- ${error.message}`);
        });
      }
      return null;
    }
  } catch (error) {
    console.error('Error fetching pool data:', error.message);
    if (error.response && error.response.data) {
      console.error('Response data:', error.response.data);
    }
    return null;
  }
}

// Function to search for WETH/USDC pools
async function findWethUsdcPools() {
  console.log("Searching for WETH/USDC pools...");
  
  const query = `
    {
      pools(first: 100) {
        id
        token0 {
          symbol
        }
        token1 {
          symbol
        }
      }
    }
  `;
  
  try {
    const response = await axios.post(SUBGRAPH_URL, { query });
    
    if (response.data && response.data.data && response.data.data.pools) {
      const pools = response.data.data.pools;
      
      // Filter for WETH/USDC or USDC/WETH pairs
      const wethUsdcPools = pools.filter(pool => {
        const symbols = [
          pool.token0.symbol.toUpperCase(),
          pool.token1.symbol.toUpperCase()
        ];
        return (symbols.includes('WETH') && symbols.includes('USDC'));
      });
      
      if (wethUsdcPools.length > 0) {
        console.log(`Found ${wethUsdcPools.length} WETH/USDC pools:`);
        wethUsdcPools.forEach(pool => {
          console.log(`- ID: ${pool.id}, Pair: ${pool.token0.symbol}-${pool.token1.symbol}`);
        });
        return wethUsdcPools;
      } else {
        console.log("No WETH/USDC pools found");
        return [];
      }
    }
    return [];
  } catch (error) {
    console.error("Error searching for WETH/USDC pools:", error.message);
    return [];
  }
}

// Calculate fee APR for the position
function calculateFeeAPR(poolData, lowerTick, upperTick) {
  if (!poolData.feesUSD || parseFloat(poolData.feesUSD) === 0) {
    console.log("No fee data available. Using a placeholder estimate.");
    // Use a placeholder fee estimate based on typical values
    const tvl = parseFloat(poolData.totalValueLockedUSD || 0);
    if (tvl === 0) {
      return {
        feeAPR: 0,
        positionFeeAPR: 0
      };
    }
    
    // Estimate fees as 0.1% of TVL per day
    const estimatedDailyFees = tvl * 0.001;
    const annualFeesUSD = estimatedDailyFees * 365;
    const feeAPR = (annualFeesUSD / tvl) * 100;
    
    // Calculate position's fee APR based on its range
    const positionFeeAPR = calculatePositionAprFromRange(
      feeAPR, 
      lowerTick, 
      upperTick, 
      parseInt(poolData.tick || 0), 
      parseInt(poolData.tickSpacing || 60)
    );
    
    return {
      feeAPR,
      positionFeeAPR
    };
  }
  
  // Convert fees to annual value
  const dailyFeesUSD = parseFloat(poolData.feesUSD) / 7; // Assuming feesUSD is for 7 days
  const annualFeesUSD = dailyFeesUSD * 365;
  
  // Calculate APR based on total locked value
  const totalValueLockedUSD = parseFloat(poolData.totalValueLockedUSD || 0);
  if (totalValueLockedUSD === 0) {
    return {
      feeAPR: 0,
      positionFeeAPR: 0
    };
  }
  
  const feeAPR = (annualFeesUSD / totalValueLockedUSD) * 100;
  
  // Calculate position's fee APR based on its range
  const positionFeeAPR = calculatePositionAprFromRange(
    feeAPR, 
    lowerTick, 
    upperTick, 
    parseInt(poolData.tick || 0), 
    parseInt(poolData.tickSpacing || 60)
  );
  
  return {
    feeAPR,
    positionFeeAPR
  };
}

// Calculate emissions APR (for farms/incentives)
function calculateEmissionsAPR(poolData, tokenPrices, lowerTick, upperTick) {
  // Since we don't have direct emissions data in the schema,
  // we'll use a simple estimate based on common farming rewards
  
  // For example, estimate emissions as 20% of the pool's annual fees
  const totalValueLockedUSD = parseFloat(poolData.totalValueLockedUSD || 0);
  if (totalValueLockedUSD === 0) {
    return {
      emissionsAPR: 0,
      positionEmissionsAPR: 0
    };
  }
  
  // Estimate emissions APR as a percentage of TVL
  // This is just a placeholder - in a real implementation, you would fetch actual emissions data
  const emissionsAPR = 5; // Assume 5% base emissions APR
  
  // Calculate position's emissions APR based on its range
  const positionEmissionsAPR = calculatePositionAprFromRange(
    emissionsAPR, 
    lowerTick, 
    upperTick, 
    parseInt(poolData.tick || 0), 
    parseInt(poolData.tickSpacing || 60)
  );
  
  return {
    emissionsAPR,
    positionEmissionsAPR
  };
}

// Helper function to calculate position APR from the full range APR
function calculatePositionAprFromRange(fullRangeAPR, lowerTick, upperTick, currentTick, tickSpacing) {
  // Calculate position width in ticks
  const positionWidth = upperTick - lowerTick;
  const positionBins = positionWidth / tickSpacing;
  
  // Calculate active range as a percentage of position width
  // For the formula from your original post: APR = fullRangeAPR / bins
  const positionAPR = fullRangeAPR / positionBins;
  
  return positionAPR;
}

// Calculate APR for a specific position range
async function calculatePositionAPR(poolAddress, lowerTick, upperTick) {
  try {
    // 1. Fetch pool data
    const poolData = await fetchPoolData(poolAddress);
    
    if (!poolData) {
      console.log("Pool not found. Trying to find WETH/USDC pools...");
      const wethUsdcPools = await findWethUsdcPools();
      
      if (wethUsdcPools.length > 0) {
        const alternativePool = await fetchPoolData(wethUsdcPools[0].id);
        if (!alternativePool) {
          return null;
        }
        console.log(`Using alternative WETH/USDC pool: ${wethUsdcPools[0].id}`);
        return calculatePositionAPR(wethUsdcPools[0].id, lowerTick, upperTick);
      }
      
      return null;
    }
    
    console.log(`\nPool: ${poolData.token0.symbol}-${poolData.token1.symbol}`);
    console.log(`Current Tick: ${poolData.tick}`);
    console.log(`Tick Spacing: ${poolData.tickSpacing}`);
    console.log(`TVL: $${parseFloat(poolData.totalValueLockedUSD).toLocaleString()}`);
    
    // 2. Get token prices
    const tokenPrices = {
      [poolData.token0.id.toLowerCase()]: parseFloat(poolData.token0Price),
      [poolData.token1.id.toLowerCase()]: parseFloat(poolData.token1Price)
    };
    
    // 3. Calculate fee APR
    const feeResults = calculateFeeAPR(poolData, lowerTick, upperTick);
    
    // 4. Calculate emissions APR
    const emissionsResults = calculateEmissionsAPR(poolData, tokenPrices, lowerTick, upperTick);
    
    // 5. Calculate total APR
    const totalActiveRangeAPR = feeResults.feeAPR + emissionsResults.emissionsAPR;
    const totalPositionAPR = feeResults.positionFeeAPR + emissionsResults.positionEmissionsAPR;
    
    // 6. Return results
    return {
      pool: {
        address: poolAddress,
        name: `${poolData.token0.symbol}-${poolData.token1.symbol}`,
        currentTick: parseInt(poolData.tick || 0),
        tickSpacing: parseInt(poolData.tickSpacing || 60),
        tvlUSD: parseFloat(poolData.totalValueLockedUSD || 0),
      },
      position: {
        lowerTick,
        upperTick,
        tickRange: upperTick - lowerTick,
        bins: (upperTick - lowerTick) / parseInt(poolData.tickSpacing || 60),
      },
      fees: {
        feeAPR: feeResults.feeAPR,
        positionFeeAPR: feeResults.positionFeeAPR,
      },
      emissions: {
        emissionsAPR: emissionsResults.emissionsAPR,
        positionEmissionsAPR: emissionsResults.positionEmissionsAPR,
      },
      total: {
        activeRangeAPR: totalActiveRangeAPR,
        positionAPR: totalPositionAPR,
      }
    };
  } catch (error) {
    console.error('Error calculating position APR:', error.message);
    return null;
  }
}

// Main function to run the calculation
async function main() {
  try {
    // Define your position range
    const lowerTick = -1425;
    const upperTick = -142265;
    
    console.log(`Calculating APR for position with ticks: [${lowerTick}, ${upperTick}]`);
    console.log('-------------------------------------------------------');
    
    const results = await calculatePositionAPR(WETH_USDC_POOL_ADDRESS, lowerTick, upperTick);
    
    if (results) {
      console.log('\nAPR Calculation Results:');
      console.log('===============================================================');
      console.log(`Pool: ${results.pool.name}`);
      console.log(`Current Tick: ${results.pool.currentTick}`);
      console.log(`Tick Spacing: ${results.pool.tickSpacing}`);
      console.log(`TVL: $${results.pool.tvlUSD.toLocaleString()}`);
      console.log('-------------------------------------------------------');
      console.log(`Position Range: [${results.position.lowerTick}, ${results.position.upperTick}]`);
      console.log(`Tick Range: ${results.position.tickRange}`);
      console.log(`Bins: ${results.position.bins.toFixed(2)}`);
      console.log('-------------------------------------------------------');
      console.log(`Fee APR for Active Range: ${results.fees.feeAPR.toFixed(2)}%`);
      console.log(`Fee APR for Position: ${results.fees.positionFeeAPR.toFixed(2)}%`);
      console.log('-------------------------------------------------------');
      console.log(`Emissions APR for Active Range: ${results.emissions.emissionsAPR.toFixed(2)}%`);
      console.log(`Emissions APR for Position: ${results.emissions.positionEmissionsAPR.toFixed(2)}%`);
      console.log('-------------------------------------------------------');
      console.log(`Total APR for Active Range: ${results.total.activeRangeAPR.toFixed(2)}%`);
      console.log(`Total APR for Position: ${results.total.positionAPR.toFixed(2)}%`);
      console.log('===============================================================');
    } else {
      console.log('\nCould not complete APR calculation due to missing or invalid data.');
    }
    
    return results;
  } catch (error) {
    console.error('Error in main execution:', error.message);
    return null;
  }
}

// Execute the main function
main();

module.exports = {
  calculatePositionAPR,
  fetchPoolData,
  findWethUsdcPools
};
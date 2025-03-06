const axios = require("axios");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const SCRIPT_INTERVAL_MINUTES = 60; // Change this to adjust script interval
const SCRIPT_INTERVAL_MS = SCRIPT_INTERVAL_MINUTES * 60 * 1000;

const keysPath = path.join(process.cwd(), "keys.json");
const countdownPath = path.join(process.cwd(), "countdown.json");
const WALLETS = JSON.parse(fs.readFileSync(keysPath, "utf8"));

const RPC_URL = "https://base-mainnet.g.alchemy.com/v2/irCKY81naH96CYDupXi1SM9TGRrOq-Ob";
const CONTRACT_ADDRESS = "0x1A07595aF2FD14C495096ef5E50616D5Ea09B36D";
const CONTRACT_ABI = [
  "function redeem(string memory orderId, uint256 amount, uint256 timestamp, bytes memory signature) external"
];
const BASE_URL = "https://api.gaianet.ai/api/v1";

async function connectWallet(privateKey) {
  const userWallet = new ethers.Wallet(privateKey);
  const walletAddress = userWallet.address;
  const timestamp = Math.floor(Date.now() / 1000);
  const messageObj = { wallet_address: walletAddress, timestamp };

  const signature = await userWallet.signMessage(JSON.stringify(messageObj));

  const body = {
    message: messageObj,
    wallet_address: walletAddress,
    timestamp,
    signature,
  };

  const resp = await axios.post(`${BASE_URL}/users/connect-wallet/`, body, {
    headers: { "Content-Type": "application/json" },
  });

  if (resp.data.code !== 0) {
    throw new Error(`[connectWallet] Server error: ${resp.data.msg}`);
  }
  return resp.data.data.access_token;
}

async function getPointsRedeemable(accessToken) {
  const resp = await axios.get(`${BASE_URL}/reward/points-redeem/preview/`, {
    headers: { Authorization: accessToken },
  });
  if (resp.data.code !== 0) {
    throw new Error(`[getPointsRedeemable] Server error: ${resp.data.msg}`);
  }
  return resp.data.data;
}

async function shouldSkipWallet(privateKey) {
  try {
    const accessToken = await connectWallet(privateKey);
    const pointsData = await getPointsRedeemable(accessToken);
    const pointsToRedeem = pointsData.today_redeemable_points;

    if (pointsToRedeem === 0) {
      console.log(`   ⚠ No claimable points. Skipping this wallet.`);
      return true;
    }
    return false;
  } catch (error) {
    console.error("   ⚠ Error checking claimable points:", error.message);
    return true;
  }
}

async function createRedeemOrder(accessToken, pointsToRedeem) {
  const body = { points_to_redeem: pointsToRedeem };
  const headers = {
    "Content-Type": "application/json",
    Authorization: accessToken,
  };
  const resp = await axios.post(`${BASE_URL}/credit/create-redeem-order/`, body, { headers });
  if (resp.data.code !== 0) {
    throw new Error(`[createRedeemOrder] Server error: ${resp.data.msg}`);
  }
  return resp.data.data;
}

async function redeemOnContract(privateKey, orderId, amount, timestamp, signature) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const userWallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, userWallet);

  const tx = await contract.redeem(orderId, amount, timestamp, signature);
  const receipt = await tx.wait();
  return { txHash: tx.hash, block: receipt.blockNumber, status: receipt.status };
}

async function claimForWallet(privateKey, index, total) {
  const walletAddress = new ethers.Wallet(privateKey).address;
  console.log(`\n[${index + 1}/${total}] Wallet: ${walletAddress}`);

  const skip = await shouldSkipWallet(privateKey);
  if (skip) return;

  const accessToken = await connectWallet(privateKey);
  console.log("   ✓ Wallet connected, token received.");

  const pointsData = await getPointsRedeemable(accessToken);
  const pointsToRedeem = pointsData.today_redeemable_points;
  console.log(`   Available points: ${pointsToRedeem} (claiming the same amount).`);

  const orderData = await createRedeemOrder(accessToken, pointsToRedeem);
  console.log(`   ✓ Order created. ID: ${orderData.id}`);

  const { id, credits_amount_scaled, timestamp, signature } = orderData;
  const result = await redeemOnContract(privateKey, id, credits_amount_scaled, timestamp, signature);

  const statusStr = (result.status === 1) ? "SUCCESS" : "FAIL";
  console.log(`   ✓ Tx: ${result.txHash}, block: ${result.block}, status: ${statusStr}`);
}

async function countdown(ms) {
  let remainingSeconds = Math.floor(ms / 1000);
  
  while (remainingSeconds > 0) {
    process.stdout.write(`\rRestarting in: ${formatTime(remainingSeconds)}    `);
    saveCountdown(remainingSeconds * 1000); // Save progress every second
    await new Promise(resolve => setTimeout(resolve, 1000));
    remainingSeconds--;
  }

  console.log("\nRestarting now!");
  fs.unlinkSync(countdownPath); // Remove countdown file when done
}

function saveCountdown(ms) {
  fs.writeFileSync(countdownPath, JSON.stringify({ remaining_ms: ms }, null, 2));
}

function loadCountdown() {
  if (fs.existsSync(countdownPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(countdownPath, "utf8"));
      return data.remaining_ms || SCRIPT_INTERVAL_MS;
    } catch (error) {
      console.error("Error loading countdown file:", error);
    }
  }
  return SCRIPT_INTERVAL_MS;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

async function mainLoop() {
  while (true) {
    console.log(`\n[main] Starting claim process for ${WALLETS.length} wallets...`);
    for (let i = 0; i < WALLETS.length; i++) {
      try {
        await claimForWallet(WALLETS[i], i, WALLETS.length);
      } catch (err) {
        console.error("Error:", err.message);
      }
    }

    console.log(`\nAll done! Restarting in ${SCRIPT_INTERVAL_MINUTES} minutes...`);
    await countdown(loadCountdown()); // Load countdown if restarted
  }
}

mainLoop();

import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';
import inquirer from 'inquirer';
import { get as getEmoji } from 'node-emoji'; // Fixed import
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

dotenv.config();

console.log('Pharos Bot: Script loading...');

// Configuration interface
interface Config {
  walletAddress: string;
  privateKey: string;
  authToken: string;
  rpcUrl: string;
  friendAddresses: string[];
}

interface Token {
  address: string;
  name: string;
  decimals: number;
}

interface Tokens {
  [key: string]: Token;
}

interface SwapParams {
  tokenIn?: string;
  tokenOut?: string;
  swapAmount?: number;
  swapTimes?: number;
  sendAmount?: number;
  sendTimes?: number;
  friends?: string[];
}

// Configuration file handling
const CONFIG_PATH: string = path.join(__dirname, 'config.json');
const TOKEN_CACHE_PATH: string = path.join(__dirname, 'tokens_cache.json');

let config: Config = {
  walletAddress: process.env.WALLET_ADDRESS || '',
  privateKey: process.env.PRIVATE_KEY || '',
  authToken: process.env.AUTH_TOKEN || '',
  rpcUrl: process.env.RPC_URL || 'https://testnet.dplabs-internal.com',
  friendAddresses: process.env.FRIEND_ADDRESSES ? process.env.FRIEND_ADDRESSES.split(',') : [],
};

// Load config if exists
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const loadedConfig: Config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...config, ...loadedConfig };
  }
} catch (error: any) {
  console.error(chalk.red(`${getEmoji('warning')} Error loading config: ${error.message}`));
}

// Save config helper
function saveConfig(): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(chalk.green(`${getEmoji('floppy_disk')} Configuration saved successfully!`));
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('warning')} Error saving config: ${error.message}`));
  }
}

// Contract addresses
const TOKENS: Tokens = {
  USDC: {
    address: '0xAD902CF99C2dE2f1Ba5ec4D642Fd7E49cae9EE37',
    name: 'USDC',
    decimals: 6,
  },
  USDT: {
    address: '0xEd59De2D7ad9C043442e381231eE3646FC3C2939',
    name: 'USDT',
    decimals: 6,
  },
};

const ROUTER_ADDRESS: string = '0x1a4de519154ae51200b0ad7c90f7fac75547888a';

// Initialize ethers
let provider: ethers.providers.JsonRpcProvider | undefined;
let wallet: ethers.Wallet | undefined;

// ERC20 ABI
const ERC20_ABI: string[] = [
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

// Router ABI (multicall)
const ROUTER_ABI: string[] = [
  'function multicall(uint256 collectionAndSelfcalls, bytes[] data) public',
];

// Fetch token metadata (optional)
interface TokenMetadata {
  tokens: Array<{ address: string; symbol: string }>;
}

async function fetchTokenMetadata(): Promise<TokenMetadata | null> {
  try {
    const cacheExists: boolean = fs.existsSync(TOKEN_CACHE_PATH);
    if (cacheExists) {
      const cache: { timestamp: number; data: TokenMetadata } = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
      const cacheAge: number = (Date.now() - cache.timestamp) / 1000;
      if (cacheAge < 24 * 60 * 60) {
        console.log(chalk.blue(`${getEmoji('floppy_disk')} Using cached token metadata`));
        return cache.data;
      }
    }

    console.log(chalk.blue(`${getEmoji('cloud')} Fetching token metadata from Uniswap API...`));
    const response = await axios.get<TokenMetadata>('https://ipfs.io/ipns/tokens.uniswap.org', {
      headers: {
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'en-US,en;q=0.9',
        origin: 'https://testnet.zenithswap.xyz',
        referer: 'https://testnet.zenithswap.xyz/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    });

    const data: TokenMetadata = response.data;
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }, null, 2));
    console.log(chalk.green(`${getEmoji('white_check_mark')} Token metadata cached`));
    return data;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Error fetching token metadata: ${error.message}`));
    if (fs.existsSync(TOKEN_CACHE_PATH)) {
      console.log(chalk.yellow(`${getEmoji('warning')} Falling back to cached token metadata`));
      return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8')).data;
    }
    return null;
  }
}

// Validate tokens
async function validateTokens(tokenInAddress: string, tokenOutAddress: string): Promise<boolean> {
  const validTokens: string[] = Object.values(TOKENS).map((t: Token) => t.address.toLowerCase());
  const isTokenInValid: boolean = validTokens.includes(tokenInAddress.toLowerCase());
  const isTokenOutValid: boolean = validTokens.includes(tokenOutAddress.toLowerCase());

  if (!isTokenInValid || !isTokenOutValid) {
    console.error(chalk.red(`${getEmoji('warning')} Invalid token pair: ${tokenInAddress}, ${tokenOutAddress}`));
    return false;
  }

  try {
    const metadata: TokenMetadata | null = await fetchTokenMetadata();
    if (metadata && metadata.tokens) {
      const tokenInData = metadata.tokens.find((t) => t.address.toLowerCase() === tokenInAddress.toLowerCase());
      const tokenOutData = metadata.tokens.find((t) => t.address.toLowerCase() === tokenOutAddress.toLowerCase());
      if (tokenInData && tokenOutData) {
        console.log(chalk.blue(`${getEmoji('mag')} API-validated tokens: ${tokenInData.symbol} → ${tokenOutData.symbol}`));
      } else {
        console.log(chalk.yellow(`${getEmoji('warning')} Tokens not found in API metadata, relying on hardcoded validation`));
      }
    }
  } catch (error: any) {
    console.log(chalk.yellow(`${getEmoji('warning')} API metadata unavailable, using hardcoded validation`));
  }

  const tokenInName: string = TOKENS[
    Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenInAddress.toLowerCase())!
  ].name;
  const tokenOutName: string = TOKENS[
    Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenOutAddress.toLowerCase())!
  ].name;
  console.log(chalk.blue(`${getEmoji('mag')} Validated tokens: ${tokenInName} → ${tokenOutName}`));
  return true;
}

// Initialize provider
async function initProvider(): Promise<boolean> {
  console.log(chalk.blue(`Attempting to connect to RPC: ${config.rpcUrl}`));
  let attempts: number = 3;
  while (attempts > 0) {
    try {
      provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
      const network: ethers.providers.Network = await provider.getNetwork();
      console.log(chalk.green(`${getEmoji('link')} Connected to network: ${network.name} (Chain ID: ${network.chainId})`));
      return true;
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} RPC Connection Error: ${error.message}`));
      attempts--;
      if (attempts === 0) {
        console.log(chalk.yellow(`${getEmoji('warning')} Max retry attempts reached.`));
        const { newRpc } = await inquirer.prompt<{ newRpc: string }>([
          {
            type: 'input',
            name: 'newRpc',
            message: 'Enter a valid RPC URL:',
            default: 'https://testnet.dplabs-internal.com',
          },
        ]);
        config.rpcUrl = newRpc;
        saveConfig();
        attempts = 3;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return false;
}

// Setup wallet
async function setupWallet(privateKey: string): Promise<boolean> {
  if (!privateKey) {
    console.error(chalk.red(`${getEmoji('x')} No private key provided`));
    return false;
  }

  try {
    privateKey = privateKey.replace(/^0x/, '');
    wallet = new ethers.Wallet(privateKey, provider);
    config.walletAddress = wallet.address;
    config.privateKey = `0x${privateKey}`;
    console.log(chalk.cyan(`${getEmoji('key')} Wallet Address: ${config.walletAddress}`));
    saveConfig();
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Wallet Setup Error: ${error.message}`));
    return false;
  }
}

// API request helper
interface ApiResponse<T = any> {
  data: T;
  msg?: string;
}

async function makeApiRequest<T>(method: string, url: string, data: any = {}, retries: number = 3): Promise<ApiResponse<T>> {
  let attempt: number = 0;

  while (attempt < retries) {
    try {
      const axiosConfig = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json, text/plain, */*',
          origin: 'https://testnet.pharosnetwork.xyz',
          referer: 'https://testnet.pharosnetwork.xyz/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
        data: method === 'POST' ? data : undefined,
      };
      const response = await axios(axiosConfig);
      return response.data;
    } catch (error: any) {
      attempt++;
      const statusCode: number | undefined = error.response?.status;
      const errorMsg: string = error.response?.data?.msg || error.message;

      console.error(
        chalk.yellow(`${getEmoji('warning')} Attempt ${attempt}/${retries} - Error in ${method} ${url}: ${statusCode} ${errorMsg}`)
      );

      if (attempt >= retries) {
        throw new Error(`API Request failed after ${retries} attempts: ${errorMsg}`);
      }

      const delay: number = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('API request failed');
}

// API Functions
async function dailySignIn(): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/in?address=${config.walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest('POST', url);
    console.log(chalk.green(`${getEmoji('calendar')} Sign-In: ${response.msg}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Sign-In Error: ${error.message}`));
    return false;
  }
}

interface SignInStatus {
  status: string;
}

async function checkSignInStatus(): Promise<SignInStatus | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/status?address=${config.walletAddress}`;
    const response: ApiResponse<SignInStatus> = await makeApiRequest('GET', url);
    console.log(chalk.blue(`${getEmoji('mag')} Sign-In Status: ${response.data.status}`));
    return response.data;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Sign-In Status Error: ${error.message}`));
    return null;
  }
}

interface UserProfile {
  UserName: string;
  TotalPoints: string;
  InviteCode: string;
}

async function getUserProfile(): Promise<UserProfile | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/user/profile?address=${config.walletAddress}`;
    const response: ApiResponse<{ user_info: UserProfile }> = await makeApiRequest('GET', url);
    console.log(chalk.blue(`${getEmoji('bust_in_silhouette')} User Profile:`));
    console.log(chalk.blue(`  UserName: ${response.data.user_info.UserName || 'N/A'}`));
    console.log(chalk.blue(`  TotalPoints: ${response.data.user_info.TotalPoints || '0'}`));
    console.log(chalk.blue(`  InviteCode: ${response.data.user_info.InviteCode || 'N/A'}`));
    return response.data.user_info;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} User Profile Error: ${error.message}`));
    return null;
  }
}

async function claimDailyFaucet(): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/faucet/daily?address=${config.walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest('POST', url);
    console.log(chalk.green(`${getEmoji('moneybag')} Daily Faucet: ${response.msg}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Daily Faucet Error: ${error.message}`));
    return false;
  }
}

interface FaucetStatus {
  avaliable_timestamp: number;
  is_able_to_faucet: boolean;
}

async function checkFaucetStatus(): Promise<FaucetStatus | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/faucet/status?address=${config.walletAddress}`;
    const response: ApiResponse<FaucetStatus> = await makeApiRequest('GET', url);
    console.log(chalk.blue(`${getEmoji('hourglass')} Faucet Status: ${JSON.stringify(response.data)}`));
    return response.data;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Faucet Status Error: ${error.message}`));
    return null;
  }
}

async function claimTokenFaucet(tokenAddress: string, retries: number = 3): Promise<string | null | boolean> {
  const url: string = 'https://testnet-router.zenithswap.xyz/api/v1/faucet';
  const payload = { tokenAddress, userAddress: config.walletAddress };

  const balanceInfo = await checkBalance(tokenAddress);
  const decimals: number =
    TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.decimals || 6;
  const requiredAmount = ethers.utils.parseUnits('0.1', decimals);
  if (balanceInfo.raw.gte(requiredAmount)) {
    const tokenName: string = TOKENS[
      Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
    ].name;
    console.log(chalk.blue(`${getEmoji('bar_chart')} Sufficient balance for ${tokenName}, skipping faucet`));
    return true;
  }

  let attempt: number = 0;
  while (attempt < retries) {
    try {
      const tokenName: string = TOKENS[
        Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
      ].name;
      console.log(chalk.blue(`${getEmoji('coin')} Attempting to claim token faucet for ${tokenName} (Attempt ${attempt + 1}/${retries})`));
      const response = await axios.post<{ data: { txHash: string } }>(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          accept: '*/*',
          origin: 'https://testnet.zenithswap.xyz',
          referer: 'https://testnet.zenithswap.xyz/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
      });

      if (response.data && response.data.data && response.data.data.txHash) {
        console.log(chalk.green(`${getEmoji('coin')} Token Faucet (${tokenName}) Tx: ${response.data.data.txHash}`));
        return response.data.data.txHash;
      } else {
        console.log(chalk.yellow(`${getEmoji('warning')} Token Faucet (${tokenName}): No transaction hash in response`));
        attempt++;
        if (attempt >= retries) {
          console.error(chalk.red(`${getEmoji('x')} Token Faucet failed after ${retries} attempts`));
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (error: any) {
      attempt++;
      const errorMsg: string = error.response?.data?.msg || error.message;
      console.error(chalk.red(`${getEmoji('x')} Token Faucet Error (Attempt ${attempt}/${retries}): ${errorMsg}`));
      if (attempt >= retries) {
        console.error(chalk.red(`${getEmoji('x')} Token Faucet failed after ${retries} attempts`));
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return null;
}

// Check token balance
interface BalanceInfo {
  raw: ethers.BigNumber;
  formatted: string;
  decimals: number;
}

async function checkBalance(tokenAddress: string): Promise<BalanceInfo> {
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const decimals: number =
      TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.decimals || 6;
    const balance: ethers.BigNumber = await tokenContract.balanceOf(config.walletAddress);
    const formattedBalance: string = ethers.utils.formatUnits(balance, decimals);

    const tokenName: string =
      TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.name ||
      'Unknown Token';
    console.log(chalk.blue(`${getEmoji('bar_chart')} ${tokenName} Balance: ${formattedBalance}`));
    return { raw: balance, formatted: formattedBalance, decimals };
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance Check Error: ${error.message}`));
    return { raw: ethers.BigNumber.from(0), formatted: '0', decimals: 6 };
  }
}

async function checkBalanceAndApproval(tokenAddress: string, amount: number, decimals: number, spender: string): Promise<boolean> {
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const balance: ethers.BigNumber = await tokenContract.balanceOf(config.walletAddress);
    const required = ethers.utils.parseUnits(amount.toString(), decimals);

    if (balance.lt(required)) {
      const tokenName: string = TOKENS[
        Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
      ].name;
      console.error(chalk.red(`${getEmoji('warning')} Insufficient ${tokenName} balance: ${ethers.utils.formatUnits(balance, decimals)} < ${amount}`));
      return false;
    }

    const allowance: ethers.BigNumber = await tokenContract.allowance(config.walletAddress, spender);
    const tokenName: string = TOKENS[
      Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
    ].name;
    console.log(chalk.blue(`${getEmoji('mag')} Current ${tokenName} allowance: ${ethers.utils.formatUnits(allowance, decimals)}`));
    if (allowance.lt(required)) {
      console.log(chalk.blue(`${getEmoji('key')} Approving ${amount} ${tokenName} for ${spender}...`));
      const estimatedGas: ethers.BigNumber = await tokenContract.estimateGas.approve(spender, ethers.constants.MaxUint256);
      const feeData = await provider!.getFeeData();
      const approveTx = await tokenContract.approve(spender, ethers.constants.MaxUint256, {
        gasLimit: Math.ceil(Number(estimatedGas) * 1.2),
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'), // Fallback to 2 gwei
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'), // Fallback to 1 gwei
      });
      await approveTx.wait();
      console.log(chalk.green(`${getEmoji('checkered_flag')} Approval Tx: ${approveTx.hash}`));
    } else {
      console.log(chalk.blue(`${getEmoji('white_check_mark')} Sufficient ${tokenName} allowance, skipping approval`));
    }

    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance/approval check failed: ${error.message}`));
    return false;
  }
}

// Generate multicall data
function getMulticallData(tokenIn: string, tokenOut: string, amount: number, decimals: number, walletAddress: string): string[] {
  try {
    const scaledAmount = ethers.utils.parseUnits(amount.toString(), decimals);
    const data = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256', 'address', 'uint256', 'uint256','uint256'],
      [tokenIn, tokenOut, 500, walletAddress, scaledAmount, 0, 0]
    );
    return [ethers.utils.hexConcat(['0x04e45aaf', data])];
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Failed to generate multicall data: ${error.message}`));
    return [];
  }
}

async function swapTokens(tokenIn: string, tokenOut: string, amount: number, times: number): Promise<number> {
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  let successCount: number = 0;

  if (!(await validateTokens(tokenIn, tokenOut))) {
    console.error(chalk.red(`${getEmoji('x')} Token validation failed`));
    return 0;
  }

  const pair = {
    from: TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenIn.toLowerCase())!].name,
    to: TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenOut.toLowerCase())!].name,
  };

  const decimals: number = TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenIn.toLowerCase())!].decimals;

  for (let i = 0; i < times; i++) {
    let attempt: number = 0;
    const maxAttempts: number = 3;

    while (attempt < maxAttempts) {
      try {
        console.log(chalk.cyan(`${getEmoji('arrows_counterclockwise')} Swap ${i + 1}/${times}: ${pair.from} -> ${pair.to} (${amount} ${pair.from}) (Attempt ${attempt + 1}/${maxAttempts})`));

        if (!(await checkBalanceAndApproval(tokenIn, amount, decimals, ROUTER_ADDRESS))) {
          console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed: Insufficient balance or approval`));
          break;
        }

        const multicallData: string[] = getMulticallData(tokenIn, tokenOut, amount, decimals, config.walletAddress);
        console.log(chalk.blue(`${getEmoji('mag')} Multicall Data: ${JSON.stringify(multicallData)}`)); // Debug log
        if (!multicallData || multicallData.length === 0 || multicallData.some((data) => !data || data === '0x')) {
          console.error(chalk.red(`${getEmoji('x')} Invalid or empty multicall data for ${pair.from} -> ${pair.to}`));
          break;
        }

        const deadline: number = Math.floor(Date.now() / 1000) + 600; // Increased to 10 minutes
        let estimatedGas: ethers.BigNumber;
        try {
          // Simulate the transaction with callStatic
          await routerContract.callStatic.multicall(deadline, multicallData, {
            from: config.walletAddress,
          });
          estimatedGas = await routerContract.estimateGas.multicall(deadline, multicallData, {
            from: config.walletAddress,
          });
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Gas estimation or simulation failed for swap ${i + 1}: ${error.message}`));
          break;
        }

        const feeData = await provider!.getFeeData();
        const tx = await routerContract.multicall(deadline, multicallData, {
          gasLimit: Math.ceil(Number(estimatedGas) * 1.5), // Increased buffer
          maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('5', 'gwei'), // Increased fallback
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('2', 'gwei'), // Increased fallback
        });

        console.log(chalk.yellow(`${getEmoji('hourglass')} Swap ${i + 1} pending: ${tx.hash}`));

        // Add timeout to tx.wait()
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction timed out')), 60000) // 60 seconds
        );
        const receipt = await Promise.race([tx.wait(), timeoutPromise]);

        if (receipt.status === 0) {
          throw new Error(`Transaction reverted: ${tx.hash}`);
        }
        console.log(chalk.green(`${getEmoji('rocket')} Swap ${i + 1} Tx: ${receipt.transactionHash}`));
        console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/tx/${receipt.transactionHash}`));
        successCount++;

        if (i < times - 1) {
          const delay: number = Math.floor(Math.random() * 2000) + 1000;
          console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delay / 1000} seconds before next swap...`));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        break; // Success, exit retry loop
      } catch (error: any) {
        attempt++;
        console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} Error (Attempt ${attempt}/${maxAttempts}): ${error.message}`));
        if (error.transaction) {
          console.error(chalk.red(`${getEmoji('x')} Transaction details: ${JSON.stringify(error.transaction, null, 2)}`));
        }
        if (error.receipt) {
          console.error(chalk.red(`${getEmoji('x')} Receipt: ${JSON.stringify(error.receipt, null, 2)}`));
        }
        if (attempt >= maxAttempts) {
          console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed after ${maxAttempts} attempts`));
          break;
        }
        const delay: number = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.log(chalk.green(`${getEmoji('chart_with_upwards_trend')} Swap Summary: ${successCount}/${times} successful swaps`));
  return successCount;
}

// Send to friends
async function sendToFriends(token: string, amount: number, times: number, friends: string[]): Promise<number> {
  if (!friends || friends.length === 0) {
    console.error(chalk.red(`${getEmoji('warning')} No friend addresses provided`));
    return 0;
  }

  const tokenContract = new ethers.Contract(token, ERC20_ABI, wallet);
  const decimals: number =
    TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === token.toLowerCase())!]?.decimals || 6;
  const amountWei = ethers.utils.parseUnits(amount.toString(), decimals);
  const tokenName: string = TOKENS[
    Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === token.toLowerCase())!
  ].name;
  let successCount: number = 0;

  for (let i = 0; i < times; i++) {
    const friendIndex: number = i % friends.length;
    const friend: string = friends[friendIndex];

    try {
      console.log(chalk.cyan(`${getEmoji('gift')} Sending ${amount} ${tokenName} to ${friend} (${i + 1}/${times})...`));

      const balance: ethers.BigNumber = await tokenContract.balanceOf(config.walletAddress);
      if (balance.lt(amountWei)) {
        console.error(
          chalk.red(
            `${getEmoji('warning')} Insufficient ${tokenName} balance for transfer to ${friend}. Have ${ethers.utils.formatUnits(
              balance,
              decimals
            )}, need ${amount}`
          )
        );
        continue;
      }

      const tx = await tokenContract.transfer(friend, amountWei, {
        gasLimit: 300000,
        gasPrice: 0,
      });

      console.log(chalk.yellow(`${getEmoji('hourglass')} Transfer pending: ${tx.hash}`));
      const receipt = await tx.wait();
      console.log(chalk.green(`${getEmoji('tada')} Send Tx: ${receipt.transactionHash}`));
      console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/tx/${receipt.transactionHash}`));
      successCount++;

      if (i < times - 1) {
        const delay: number = Math.floor(Math.random() * 3000) + 2000;
        console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delay / 1000} seconds before next transfer...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Send to ${friend} Error: ${error.message}`));
    }
  }

  console.log(chalk.green(`${getEmoji('gift')} Send Summary: ${successCount}/${times} successful transfers`));
  return successCount;
}

// Run daily tasks
async function runDailyTasks(featureNumber: number, params: SwapParams = {}): Promise<FaucetStatus | null> {
  console.log(chalk.blue(`${getEmoji('rocket')} Running daily tasks for Feature ${featureNumber}...`));
  await dailySignIn();
  await checkSignInStatus();
  await getUserProfile();
  await claimDailyFaucet();
  const faucetStatus: FaucetStatus | null = await checkFaucetStatus();

  if ((featureNumber === 1 || featureNumber === 2 || featureNumber === 4) && params.tokenIn && params.tokenOut && params.swapAmount && params.swapTimes) {
    await claimTokenFaucet(params.tokenIn);
    await swapTokens(params.tokenIn, params.tokenOut, params.swapAmount, params.swapTimes);
  }

  if ((featureNumber === 1 || featureNumber === 4) && params.tokenIn && params.sendAmount && params.sendTimes && params.friends) {
    await sendToFriends(params.tokenIn, params.sendAmount, params.sendTimes, params.friends);
  }

  console.log(chalk.green(`${getEmoji('tada')} Daily tasks for Feature ${featureNumber} completed!`));
  return faucetStatus;
}

// Schedule tasks
async function scheduleAndLogTasks(featureNumber: number, params: SwapParams = {}): Promise<void> {
  console.log(chalk.blue(`${getEmoji('calendar')} Executing immediate tasks for Feature ${featureNumber}...`));
  let faucetStatus: FaucetStatus | null = await runDailyTasks(featureNumber, params);

  while (true) {
    const currentTime: number = Math.floor(Date.now() / 1000);
    const nextRunTime: number = faucetStatus?.avaliable_timestamp || currentTime + 24 * 60 * 60;

    if (faucetStatus && !faucetStatus.is_able_to_faucet) {
      console.log(chalk.blue(`${getEmoji('clock3')} Daily check-in scheduled for ${new Date(nextRunTime * 1000).toUTCString()}`));
    }

    while (Math.floor(Date.now() / 1000) < nextRunTime) {
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }

    console.log(chalk.blue(`${getEmoji('calendar')} Running scheduled daily tasks for Feature ${featureNumber}...`));
    faucetStatus = await runDailyTasks(featureNumber, params);
  }
}

// Configuration Menu
async function configMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('gear')} ========================================================`));
  console.log(chalk.cyan(`${getEmoji('gear')} Configuration Settings`));
  console.log(chalk.cyan(`${getEmoji('gear')} ========================================================`));

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an option:',
      choices: ['Update Private Key', 'Update Bearer Token', 'Update RPC URL', 'Manage Friend Addresses', 'Back to Main Menu'],
    },
  ]);

  switch (action) {
    case 'Update Private Key':
      const { privateKey } = await inquirer.prompt<{ privateKey: string }>([
        {
          type: 'input',
          name: 'privateKey',
          message: `${getEmoji('key')} Enter your Private Key (with or without 0x prefix):`,
          validate: (input: string) => (input.replace(/^0x/, '').length >= 64 ? true : 'Please enter a valid private key'),
        },
      ]);
      config.privateKey = privateKey;
      saveConfig();
      await setupWallet(privateKey);
      break;

    case 'Update Bearer Token':
      const { bearerToken } = await inquirer.prompt<{ bearerToken: string }>([
        {
          type: 'input',
          name: 'bearerToken',
          message: `${getEmoji('lock')} Enter your Bearer Token:`,
        },
      ]);
      config.authToken = bearerToken;
      saveConfig();
      break;

    case 'Update RPC URL':
      const { rpcUrl } = await inquirer.prompt<{ rpcUrl: string }>([
        {
          type: 'input',
          name: 'rpcUrl',
          message: `${getEmoji('link')} Enter RPC URL:`,
          default: config.rpcUrl,
        },
      ]);
      config.rpcUrl = rpcUrl;
      saveConfig();
      await initProvider();
      break;

    case 'Manage Friend Addresses':
      await manageFriendsMenu();
      break;
  }

  if (action !== 'Back to Main Menu') {
    await configMenu();
  }
}

// Manage friends menu
async function manageFriendsMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ========================================================`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} Friend Addresses Management`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ========================================================`));

  if (config.friendAddresses && config.friendAddresses.length > 0) {
    console.log(chalk.blue(`Current friends (${config.friendAddresses.length}):`));
    config.friendAddresses.forEach((addr: string, i: number) => {
      console.log(chalk.blue(`${i + 1}. ${addr}`));
    });
  } else {
    console.log(chalk.yellow(`${getEmoji('warning')} No friend addresses configured`));
  }

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an option:',
      choices: ['Add Friend Address', 'Remove Friend Address', 'Clear All Friends', 'Import Multiple Addresses', 'Back to Config Menu'],
    },
  ]);

  switch (action) {
    case 'Add Friend Address':
      const { address } = await inquirer.prompt<{ address: string }>([
        {
          type: 'input',
          name: 'address',
          message: `${getEmoji('bust_in_silhouette')} Enter friend's address:`,
          validate: (input: string) => (ethers.utils.isAddress(input) ? true : 'Please enter a valid Ethereum address'),
       },
      ]);
      if (!config.friendAddresses) config.friendAddresses = [];
      config.friendAddresses.push(address);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friend added!`));
      break;

    case 'Remove Friend Address':
      if (!config.friendAddresses || config.friendAddresses.length === 0) {
        console.log(chalk.yellow(`${getEmoji('warning')} No friends to remove`));
        break;
      }

      const { indexToRemove } = await inquirer.prompt<{ indexToRemove: number }>([
        {
          type: 'list',
          name: 'indexToRemove',
          message: 'Select friend to remove:',
          choices: config.friendAddresses.map((addr: string, i: number) => ({ name: `${i + 1}. ${addr}`, value: i })),
        },
      ]);

      config.friendAddresses.splice(indexToRemove, 1);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friend removed!`));
      break;

    case 'Clear All Friends':
      const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure you want to remove all friends?',
          default: false,
        },
      ]);

      if (confirm) {
        config.friendAddresses = [];
        saveConfig();
        console.log(chalk.green(`${getEmoji('white_check_mark')} All friends removed!`));
      }
      break;

    case 'Import Multiple Addresses':
      const { addresses } = await inquirer.prompt<{ addresses: string }>([
        {
          type: 'input',
          name: 'addresses',
          message: `${getEmoji('page_with_curl')} Enter comma-separated addresses:`,
          validate: (input: string) => {
            const addrs: string[] = input.split(',').map((a) => a.trim());
            return addrs.every((addr) => ethers.utils.isAddress(addr)) ? true : 'One or more addresses are invalid';
          },
        },
      ]);

      config.friendAddresses = [...new Set([...(config.friendAddresses || []), ...addresses.split(',').map((a) => a.trim())])];
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friends imported!`));
      break;
  }

  if (action !== 'Back to Config Menu') {
    await manageFriendsMenu();
  }
}

// Main Menu
async function mainMenu(): Promise<void> {
  console.clear();
  console.log(chalk.magenta(`${getEmoji('star')} ========================================================`));
  console.log(chalk.magenta(`${getEmoji('robot')} Pharos Automatic Bot ${getEmoji('sparkles')}`));
  console.log(chalk.magenta(`                                                        `));
  console.log(chalk.magenta(`${getEmoji('one')} [1] Swap, Check In, and Send to Friends`));
  console.log(chalk.magenta(`${getEmoji('two')} [2] Swap and Check In`));
  console.log(chalk.magenta(`${getEmoji('three')} [3] Check In Only`));
  console.log(chalk.magenta(`${getEmoji('four')} [4] Swap, Check In, and Send to Friends`));
  console.log(chalk.magenta(`${getEmoji('wrench')} [5] Configuration`));
  console.log(chalk.magenta(`${getEmoji('x')} [6] Exit`));
  console.log(chalk.magenta(`${getEmoji('star')} ========================================================`));

  const { feature } = await inquirer.prompt<{ feature: string }>([
    {
      type: 'list',
      name: 'feature',
      message: 'Select a feature to run:',
      choices: [
        '1 - Swap, Check In, and Send to Friends',
        '2 - Swap and Check In',
        '3 - Check In Only',
        '4 - Swap, Check In, and Send to Friends',
        '5 - Configuration',
        '6 - Exit',
      ],
    },
  ]);

  const featureNumber: number = parseInt(feature.split(' - ')[0]);

  if (featureNumber === 5) {
    await configMenu();
    await mainMenu();
    return;
  }

  if (featureNumber === 6) {
    console.log(chalk.yellow(`${getEmoji('wave')} Exiting Pharos Bot...`));
    process.exit(0);
  }

  let params: SwapParams = {};
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4) {
    const { swapDirection, swapAmount, swapTimes } = await inquirer.prompt<{
      swapDirection: 'USDC_TO_USDT' | 'USDT_TO_USDC';
      swapAmount: number;
      swapTimes: number;
    }>([
      {
        type: 'list',
        name: 'swapDirection',
        message: 'Select swap direction:',
        choices: [
          { name: 'USDC → USDT', value: 'USDC_TO_USDT' },
          { name: 'USDT → USDC', value: 'USDT_TO_USDC' },
        ],
        default: 'USDC_TO_USDT',
      },
      {
        type: 'number',
        name: 'swapAmount',
        message: 'Enter swap amount:',
        default: 0.1,
        validate: (input: number) => (input > 0 ? true : 'Amount must be positive'),
      },
      {
        type: 'number',
        name: 'swapTimes',
        message: 'Enter number of swaps:',
        default: 1,
        validate: (input: number) => (input >= 1 ? true : 'Number of swaps must be at least 1'),
      },
    ]);

    // Map swap direction to token addresses
    params.tokenIn = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDC.address : TOKENS.USDT.address;
    params.tokenOut = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDT.address : TOKENS.USDC.address;
    params.swapAmount = swapAmount;
    params.swapTimes = swapTimes;

    if (featureNumber === 1 || featureNumber === 4) {
      const { sendAmount, sendTimes } = await inquirer.prompt<{ sendAmount: number; sendTimes: number }>([
        {
          type: 'number',
          name: 'sendAmount',
          message: 'Enter amount to send to friends:',
          default: 0.1,
          validate: (input: number) => (input > 0 ? true : 'Amount must be positive'),
        },
        {
          type: 'number',
          name: 'sendTimes',
          message: 'Enter number of sends:',
          default: 1,
          validate: (input: number) => (input >= 1 ? true : 'Number of sends must be at least 1'),
        },
      ]);
      params.sendAmount = sendAmount;
      params.sendTimes = sendTimes;
      params.friends = config.friendAddresses;
    }
  }

  await scheduleAndLogTasks(featureNumber, params);
}

// Initialize and start
async function start(): Promise<void> {
  console.log(chalk.cyan(`${getEmoji('rocket')} Initializing Pharos Bot...`));
  if (!(await initProvider())) {
    console.error(chalk.red(`${getEmoji('x')} Failed to initialize provider. Exiting...`));
    process.exit(1);
  }

  if (!(await setupWallet(config.privateKey))) {
    console.log(chalk.yellow(`${getEmoji('warning')} Please configure your private key`));
    await configMenu();
    if (!(await setupWallet(config.privateKey))) {
      console.error(chalk.red(`${getEmoji('x')} Wallet setup failed. Exiting...`));
      process.exit(1);
    }
  }

  await mainMenu();
}

start().catch((error: any) => {
  console.error(chalk.red(`${getEmoji('x')} Fatal Error: ${error.message}`));
  process.exit(1);
});
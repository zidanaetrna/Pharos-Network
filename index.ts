import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';
import inquirer from 'inquirer';
import { get as getEmoji } from 'node-emoji';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

dotenv.config();

console.log('Pharos Bot: Script loading...');

// Configuration interfaces
interface WalletConfig {
  address: string;
  privateKey: string;
  authToken: string;
}

interface Config {
  wallets: WalletConfig[];
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

interface ApiResponse<T = any> {
  data: T;
  msg?: string;
  code?: number;
}

// Configuration file handling
const CONFIG_PATH: string = path.join(__dirname, 'config.json');
const TOKEN_CACHE_PATH: string = path.join(__dirname, 'tokens_cache.json');

let config: Config = {
  wallets: [],
  rpcUrl: process.env.RPC_URL || 'https://testnet.dplabs-internal.com',
  friendAddresses: process.env.FRIEND_ADDRESSES ? process.env.FRIEND_ADDRESSES.split(',') : [],
};

// Load and migrate config
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const rawConfig: any = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (rawConfig.walletAddress && rawConfig.privateKey && rawConfig.authToken) {
      config.wallets = [
        {
          address: rawConfig.walletAddress,
          privateKey: rawConfig.privateKey,
          authToken: rawConfig.authToken,
        },
      ];
      config.rpcUrl = rawConfig.rpcUrl || config.rpcUrl;
      config.friendAddresses = rawConfig.friendAddresses || [];
      console.log(chalk.yellow(`${getEmoji('warning')} Migrated old config format to new format`));
    } else {
      config = { ...config, ...rawConfig };
    }
    config.wallets = config.wallets.filter((wallet) => wallet.address && wallet.privateKey && wallet.authToken);
    if (config.wallets.length === 0) {
      console.log(chalk.yellow(`${getEmoji('warning')} No valid wallets found in config`));
    }
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
const PHRS_DECIMALS: number = 18;
const MINIMUM_PHRS_BALANCE: string = '0.01';
const MINIMUM_TOKEN_BALANCE: string = '0.1';

// Initialize ethers
let provider: ethers.providers.JsonRpcProvider | undefined;
let wallets: ethers.Wallet[] = [];

// ERC20 ABI
const ERC20_ABI: string[] = [
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

// Router ABI
const ROUTER_ABI: string[] = [
  'function multicall(uint256 collectionAndSelfcalls, bytes[] data) public',
];

// User-agent pool for rotation
const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

// Fetch token metadata
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
        'user-agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
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
      const network = {
        name: 'pharos-testnet',
        chainId: 1000, // Adjust if known
      };
      provider = new ethers.providers.JsonRpcProvider(config.rpcUrl, network);
      const detectedNetwork: ethers.providers.Network = await provider.getNetwork();
      console.log(chalk.green(`${getEmoji('link')} Connected to network: ${detectedNetwork.name} (Chain ID: ${detectedNetwork.chainId})`));
      provider.resolveName = async () => { throw new Error('ENS not supported'); };
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

// Setup wallets
async function setupWallets(): Promise<boolean> {
  wallets = [];
  let allValid = true;

  for (const walletConfig of config.wallets) {
    if (!walletConfig.privateKey || !walletConfig.authToken || !ethers.utils.isAddress(walletConfig.address)) {
      console.error(chalk.red(`${getEmoji('x')} Invalid configuration for wallet: ${JSON.stringify(walletConfig)}`));
      allValid = false;
      continue;
    }

    try {
      const privateKey = walletConfig.privateKey.replace(/^0x/, '');
      const wallet = new ethers.Wallet(privateKey, provider);
      if (wallet.address.toLowerCase() !== walletConfig.address.toLowerCase()) {
        console.error(chalk.red(`${getEmoji('x')} Address mismatch for wallet: ${walletConfig.address}`));
        allValid = false;
        continue;
      }
      walletConfig.address = wallet.address;
      walletConfig.privateKey = `0x${privateKey}`;
      wallets.push(wallet);
      console.log(chalk.cyan(`${getEmoji('key')} Wallet Address: ${walletConfig.address}`));
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Wallet Setup Error for ${walletConfig.address || 'unknown'}: ${error.message}`));
      allValid = false;
    }
  }

  if (allValid && config.wallets.length > 0) {
    saveConfig();
    return true;
  }
  return false;
}

// Prompt for additional wallets
async function promptForAdditionalWallets(): Promise<void> {
  if (config.wallets.length === 1 && config.wallets[0].privateKey && config.wallets[0].authToken && ethers.utils.isAddress(config.wallets[0].address)) {
    const { addMore } = await inquirer.prompt<{ addMore: boolean }>([
      {
        type: 'confirm',
        name: 'addMore',
        message: 'Just one main wallet detected. Would you like to add another? (y/n)',
        default: false,
      },
    ]);

    if (addMore) {
      let walletNumber = 2;
      const initialWalletCount = config.wallets.length;

      while (true) {
        const { privateKey } = await inquirer.prompt<{ privateKey: string }>([
          {
            type: 'input',
            name: 'privateKey',
            message: `Input your main wallet ${walletNumber} private key (without 0x, press Enter to finish):`,
            validate: (input: string) => {
              if (input === '') return true;
              return input.length >= 64 ? true : 'Please enter a valid private key';
            },
          },
        ]);

        if (privateKey === '') break;

        const { authToken } = await inquirer.prompt<{ authToken: string }>([
          {
            type: 'input',
            name: 'authToken',
            message: `Input your bearer token for wallet ${walletNumber}:`,
            validate: (input: string) => (input ? true : 'Bearer token cannot be empty'),
          },
        ]);

        try {
          const wallet = new ethers.Wallet(privateKey, provider);
          config.wallets.push({
            address: wallet.address,
            privateKey: `0x${privateKey.replace(/^0x/, '')}`,
            authToken,
          });
          console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet ${walletNumber} added: ${wallet.address}`));
          walletNumber++;
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Invalid private key for wallet ${walletNumber}: ${error.message}`));
        }
      }

      if (config.wallets.length > initialWalletCount) {
        console.log(
          chalk.green(
            `${getEmoji('floppy_disk')} Adding ${config.wallets.length - initialWalletCount} wallet(s) to ${CONFIG_PATH} successfully`
          )
        );
        saveConfig();
        console.clear();
        console.log(chalk.cyan(`${getEmoji('rocket')} Started the scripts...`));
      }
    }
  }
}

// API request helper
async function makeApiRequest<T>(
  method: string,
  url: string,
  authToken: string,
  data: any = {},
  retries: number = 3
): Promise<ApiResponse<T> | null> {
  let attempt: number = 0;

  while (attempt < retries) {
    try {
      const axiosConfig = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json, text/plain, */*',
          origin: 'https://testnet.pharosnetwork.xyz',
          referer: 'https://testnet.pharosnetwork.xyz/',
          'user-agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
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

      if (statusCode === 429) {
        const delay: number = Math.min(5000 * Math.pow(2, attempt), 30000);
        console.log(chalk.yellow(`${getEmoji('hourglass')} Rate-limited. Retrying in ${delay / 1000} seconds...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (attempt >= retries) {
        console.error(chalk.red(`API Request failed after ${retries} attempts: ${errorMsg}`));
        return null;
      }

      const delay: number = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return null;
}

// New verifyTask function
async function verifyTask(walletAddress: string, txHash: string, taskId: number, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/task/verify?address=${walletAddress}&task_id=${taskId}&tx_hash=${txHash}`;
    const response: ApiResponse<{ msg: string }> | null = await makeApiRequest('POST', url, authToken);
    if (response && response.code === 0) {
      console.log(chalk.green(`${getEmoji('white_check_mark')} Task ${taskId} verified for ${walletAddress}: ${response.msg || 'Success'}`));
      return true;
    } else {
      console.error(chalk.red(`${getEmoji('x')} Task ${taskId} verification failed for ${walletAddress}: ${response?.msg || 'Unknown error'}`));
      return false;
    }
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Task ${taskId} verification error for ${walletAddress}: ${error.message}`));
    return false;
  }
}

// API Functions
async function dailySignIn(walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/in?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> | null = await makeApiRequest('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('calendar')} Sign-In for ${walletAddress}: ${response?.msg || 'Success'}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Sign-In Error for ${walletAddress}: ${error.message}`));
    return false;
  }
}

interface SignInStatus {
  status: string;
}

async function checkSignInStatus(walletAddress: string, authToken: string): Promise<SignInStatus | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/status?address=${walletAddress}`;
    const response: ApiResponse<SignInStatus> | null = await makeApiRequest('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('mag')} Sign-In Status for ${walletAddress}: ${response?.data.status || 'Unknown'}`));
    return response?.data || null;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Sign-In Status Error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

interface UserProfile {
  UserName: string;
  TotalPoints: string;
  InviteCode: string;
}

async function getUserProfile(walletAddress: string, authToken: string): Promise<UserProfile | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/user/profile?address=${walletAddress}`;
    const response: ApiResponse<{ user_info: UserProfile }> | null = await makeApiRequest('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('bust_in_silhouette')} User Profile for ${walletAddress}:`));
    console.log(chalk.blue(`  UserName: ${response?.data.user_info.UserName || 'N/A'}`));
    console.log(chalk.blue(`  TotalPoints: ${response?.data.user_info.TotalPoints || '0'}`));
    console.log(chalk.blue(`  InviteCode: ${response?.data.user_info.InviteCode || 'N/A'}`));
    return response?.data.user_info || null;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} User Profile Error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

async function claimDailyFaucet(walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/faucet/daily?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> | null = await makeApiRequest('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('moneybag')} Daily PHRS Faucet for ${walletAddress}: ${response?.msg || 'Success'}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Daily PHRS Faucet Error for ${walletAddress}: ${error.message}`));
    return false;
  }
}

interface FaucetStatus {
  available_timestamp: number;
  is_able_to_faucet: boolean;
}

async function checkFaucetStatus(walletAddress: string, authToken: string): Promise<FaucetStatus | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/faucet/status?address=${walletAddress}`;
    const response: ApiResponse<FaucetStatus> | null = await makeApiRequest('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('hourglass')} PHRS Faucet Status for ${walletAddress}: ${JSON.stringify(response?.data || {})}`));
    return response?.data || null;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} PHRS Faucet Status Error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

async function claimTokenFaucet(tokenAddress: string, walletAddress: string): Promise<string | null | boolean> {
  const url: string = 'https://testnet-router.zenithswap.xyz/api/v1/faucet';
  const payload = { tokenAddress, userAddress: walletAddress };

  const balanceInfo = await checkBalance(tokenAddress, walletAddress);
  const decimals: number =
    TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.decimals || 6;
  const requiredAmount = ethers.utils.parseUnits(MINIMUM_TOKEN_BALANCE, decimals);
  if (balanceInfo.raw.gte(requiredAmount)) {
    const tokenName: string = TOKENS[
      Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
    ].name;
    console.log(chalk.blue(`${getEmoji('bar_chart')} Sufficient balance for ${tokenName} in ${walletAddress}, skipping faucet`));
    return true;
  }

  const tokenName: string = TOKENS[
    Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
  ].name;
  let attempt: number = 0;
  const retries: number = 3;
  while (attempt < retries) {
    try {
      console.log(chalk.blue(`${getEmoji('coin')} Attempting to claim ${tokenName} faucet for ${walletAddress} (Attempt ${attempt + 1}/${retries})`));
      const response = await axios.post<{ status: number; message: string; data: { txHash: string } }>(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          accept: '*/*',
          'accept-encoding': 'gzip, deflate, br, zstd',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://testnet.zenithfinance.xyz',
          referer: 'https://testnet.zenithfinance.xyz/',
          'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'cross-site',
          'user-agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        },
      });

      if (response.data && response.data.status === 200 && response.data.data && response.data.data.txHash) {
        console.log(chalk.green(`${getEmoji('coin')} ${tokenName} Faucet Tx for ${walletAddress}: ${response.data.data.txHash}`));
        return response.data.data.txHash;
      } else {
        console.log(chalk.yellow(`${getEmoji('warning')} ${tokenName} Faucet for ${walletAddress}: No transaction hash in response`));
        attempt++;
        if (attempt >= retries) {
          console.error(chalk.red(`${getEmoji('x')} ${tokenName} Faucet failed for ${walletAddress} after ${retries} attempts`));
          return null;
        }
        const delay: number = Math.min(5000 * Math.pow(2, attempt), 30000);
        console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      attempt++;
      const errorMsg: string = error.response?.data?.message || error.message;
      const statusCode: number | undefined = error.response?.status;
      console.error(chalk.red(`${getEmoji('x')} ${tokenName} Faucet Error for ${walletAddress} (Attempt ${attempt}/${retries}): ${errorMsg}`));
      if (statusCode === 429) {
        const delay: number = Math.min(10000 * Math.pow(2, attempt), 60000);
        console.log(chalk.yellow(`${getEmoji('hourglass')} Rate-limited. Retrying in ${delay / 1000} seconds...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (attempt >= retries) {
        console.error(chalk.red(`${getEmoji('x')} ${tokenName} Faucet failed for ${walletAddress} after ${retries} attempts`));
        return null;
      }
      const delay: number = Math.min(5000 * Math.pow(2, attempt), 30000);
      console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
      await new Promise((resolve) => setTimeout(resolve, delay));
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

async function checkBalance(tokenAddress: string | null, walletAddress: string): Promise<BalanceInfo> {
  try {
    const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
    if (!wallet) throw new Error(`Wallet ${walletAddress} not found`);

    if (!tokenAddress) {
      const balance: ethers.BigNumber = await provider!.getBalance(walletAddress);
      const formattedBalance: string = ethers.utils.formatUnits(balance, PHRS_DECIMALS);
      console.log(chalk.blue(`${getEmoji('bar_chart')} PHRS Balance for ${walletAddress}: ${formattedBalance}`));
      return { raw: balance, formatted: formattedBalance, decimals: PHRS_DECIMALS };
    }

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const decimals: number =
      TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.decimals || 6;
    const balance: ethers.BigNumber = await tokenContract.balanceOf(walletAddress);
    const formattedBalance: string = ethers.utils.formatUnits(balance, decimals);

    const tokenName: string =
      TOKENS[Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.name ||
      'Unknown Token';
    console.log(chalk.blue(`${getEmoji('bar_chart')} ${tokenName} Balance for ${walletAddress}: ${formattedBalance}`));
    return { raw: balance, formatted: formattedBalance, decimals };
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance Check Error for ${walletAddress}: ${error.message}`));
    return { raw: ethers.BigNumber.from(0), formatted: '0', decimals: tokenAddress ? 6 : PHRS_DECIMALS };
  }
}

// Ensure PHRS balance
async function ensurePhrsBalance(walletAddress: string, authToken: string, minimumPhrs: string = MINIMUM_PHRS_BALANCE): Promise<boolean> {
  const balanceInfo = await checkBalance(null, walletAddress);
  const minimumBalance = ethers.utils.parseUnits(minimumPhrs, PHRS_DECIMALS);

  if (balanceInfo.raw.gte(minimumBalance)) {
    console.log(chalk.green(`${getEmoji('white_check_mark')} Sufficient PHRS balance for ${walletAddress}: ${balanceInfo.formatted} PHRS`));
    return true;
  }

  console.log(chalk.yellow(`${getEmoji('warning')} Insufficient PHRS balance for ${walletAddress}: ${balanceInfo.formatted} PHRS, attempting faucet claim...`));
  const faucetSuccess = await claimDailyFaucet(walletAddress, authToken);

  if (!faucetSuccess) {
    console.error(chalk.red(`${getEmoji('x')} PHRS Faucet claim failed for ${walletAddress}, skipping transactions`));
    return false;
  }

  const newBalanceInfo = await checkBalance(null, walletAddress);
  if (newBalanceInfo.raw.gte(minimumBalance)) {
    console.log(chalk.green(`${getEmoji('white_check_mark')} PHRS balance sufficient after faucet claim for ${walletAddress}: ${newBalanceInfo.formatted} PHRS`));
    return true;
  } else {
    console.error(
      chalk.red(
        `${getEmoji('x')} PHRS balance still insufficient after faucet claim for ${walletAddress}: ${newBalanceInfo.formatted} PHRS, skipping transactions`
      )
    );
    return false;
  }
}

// Check balance and approval
async function checkBalanceAndApproval(tokenAddress: string, amount: number, decimals: number, spender: string, walletAddress: string): Promise<boolean> {
  try {
    const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
    if (!wallet) throw new Error(`Wallet ${walletAddress} not found`);
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const balance: ethers.BigNumber = await tokenContract.balanceOf(walletAddress);
    const required = ethers.utils.parseUnits(amount.toString(), decimals);

    if (balance.lt(required)) {
      const tokenName: string = TOKENS[
        Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
      ].name;
      console.error(chalk.red(`${getEmoji('warning')} Insufficient ${tokenName} balance in ${walletAddress}: ${ethers.utils.formatUnits(balance, decimals)} < ${amount}`));
      return false;
    }

    const allowance: ethers.BigNumber = await tokenContract.allowance(walletAddress, spender);
    const tokenName: string = TOKENS[
      Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!
    ].name;
    console.log(chalk.blue(`${getEmoji('mag')} Current ${tokenName} allowance for ${walletAddress}: ${ethers.utils.formatUnits(allowance, decimals)}`));
    if (allowance.lt(required)) {
      console.log(chalk.blue(`${getEmoji('key')} Approving ${amount} ${tokenName} for ${spender} from ${walletAddress}...`));
      const estimatedGas: ethers.BigNumber = await tokenContract.estimateGas.approve(spender, ethers.constants.MaxUint256);
      const feeData = await provider!.getFeeData();
      const approveTx = await tokenContract.approve(spender, ethers.constants.MaxUint256, {
        gasLimit: Math.ceil(Number(estimatedGas) * 1.2),
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
      });
      const receipt: ethers.providers.TransactionReceipt = await approveTx.wait();
      console.log(chalk.green(`${getEmoji('checkered_flag')} Approval Tx for ${walletAddress}: ${receipt.transactionHash} (Gas Used: ${receipt.gasUsed})`));
    } else {
      console.log(chalk.blue(`${getEmoji('white_check_mark')} Sufficient ${tokenName} allowance for ${walletAddress}, skipping approval`));
    }

    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance/approval check failed for ${walletAddress}: ${error.message}`));
    return false;
  }
}

// Generate multicall data
function getMulticallData(tokenIn: string, tokenOut: string, amount: number, decimals: number, walletAddress: string): string[] {
  try {
    const scaledAmount = ethers.utils.parseUnits(amount.toString(), decimals);
    const data = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
      [tokenIn, tokenOut, 500, walletAddress, scaledAmount, 0, 0]
    );
    return [ethers.utils.hexConcat(['0x04e45aaf', data])];
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Failed to generate multicall data: ${error.message}`));
    return [];
  }
}

// Modified swapTokens with verifyTask
async function swapTokens(tokenIn: string, tokenOut: string, amount: number, times: number, walletAddress: string, authToken: string): Promise<number> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return 0;
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken))) {
    console.error(chalk.red(`${getEmoji('x')} Skipping swaps for ${walletAddress} due to insufficient PHRS`));
    return 0;
  }

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
        console.log(chalk.cyan(`${getEmoji('arrows_counterclockwise')} Swap ${i + 1}/${times} for ${walletAddress}: ${pair.from} -> ${pair.to} (${amount} ${pair.from}) (Attempt ${attempt + 1}/${maxAttempts})`));

        if (!(await checkBalanceAndApproval(tokenIn, amount, decimals, ROUTER_ADDRESS, walletAddress))) {
          console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed for ${walletAddress}: Insufficient balance or approval`));
          break;
        }

        const multicallData: string[] = getMulticallData(tokenIn, tokenOut, amount, decimals, walletAddress);
        console.log(chalk.blue(`${getEmoji('mag')} Multicall Data for ${walletAddress}: ${JSON.stringify(multicallData)}`));
        if (!multicallData || multicallData.length === 0 || multicallData.some((data) => !data || data === '0x')) {
          console.error(chalk.red(`${getEmoji('x')} Invalid or empty multicall data for ${pair.from} -> ${pair.to} for ${walletAddress}`));
          break;
        }

        const deadline: number = Math.floor(Date.now() / 1000) + 600;
        let estimatedGas: ethers.BigNumber;
        try {
          await routerContract.callStatic.multicall(deadline, multicallData, {
            from: walletAddress,
          });
          estimatedGas = await routerContract.estimateGas.multicall(deadline, multicallData, {
            from: walletAddress,
          });
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Gas estimation or simulation failed for swap ${i + 1} for ${walletAddress}: ${error.message}`));
          break;
        }

        const feeData = await provider!.getFeeData();
        const tx = await routerContract.multicall(deadline, multicallData, {
          gasLimit: Math.ceil(Number(estimatedGas) * 1.5),
          maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('5', 'gwei'),
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        });

        console.log(chalk.yellow(`${getEmoji('hourglass')} Swap ${i + 1} pending for ${walletAddress}: ${tx.hash}`));

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction timed out')), 60000)
        );
        const receipt: ethers.providers.TransactionReceipt = await Promise.race([tx.wait(), timeoutPromise]);

        if (receipt.status === 0) {
          throw new Error(`Transaction reverted: ${tx.hash}`);
        }
        console.log(chalk.green(`${getEmoji('rocket')} Swap ${i + 1} Tx for ${walletAddress}: ${receipt.transactionHash} (Gas Used: ${receipt.gasUsed})`));
        console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

        // Verify the swap task
        const verified = await verifyTask(walletAddress, receipt.transactionHash, 104, authToken); // task_id=104 for swaps
        if (verified) {
          successCount++;
        }

        if (i < times - 1) {
          const delay: number = Math.floor(Math.random() * 2000) + 1000;
          console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delay / 1000} seconds before next swap for ${walletAddress}...`));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        break;
      } catch (error: any) {
        attempt++;
        console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} Error for ${walletAddress} (Attempt ${attempt}/${maxAttempts}): ${error.message}`));
        if (error.transaction) {
          console.log(chalk.red(`${getEmoji('x')} Transaction details: ${JSON.stringify(error.transaction)}`));
        }
        if (error.receipt) {
          console.log(chalk.red(`${getEmoji('x')} Receipt: ${JSON.stringify(error.receipt)}`));
        }
        if (error.code === 'SERVER_ERROR' && error.status === 500) {
          console.error(chalk.yellow(`${getEmoji('warning')} RPC server error (500). Skipping this swap attempt for ${walletAddress}.`));
          break;
        }
        if (attempt >= maxAttempts) {
          console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed for ${walletAddress} after ${maxAttempts} attempts`));
          break;
        }
        const delay: number = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  console.log(chalk.green(`${getEmoji('chart_with_upwards_trend')} Swap Summary for ${walletAddress}: ${successCount}/${times} successful swaps`));
  return successCount;
}

// Modified sendToFriends with verifyTask
async function sendToFriends(amount: number, times: number, friends: string[], walletAddress: string, authToken: string): Promise<number> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return 0;
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken))) {
    console.error(chalk.red(`${getEmoji('x')} Skipping sends for ${walletAddress} due to insufficient PHRS`));
    return 0;
  }

  const amountWei = ethers.utils.parseUnits(amount.toString(), PHRS_DECIMALS);
  let successCount: number = 0;

  let recipients: string[] = friends.length > 0 ? friends : config.wallets.map((w) => w.address.toString());
  if (recipients.length === 0) {
    console.error(chalk.red(`${getEmoji('warning')} No recipients provided for ${walletAddress}`));
    return successCount;
  }

  let recipient: string;
  if (friends.length === 0) {
    const senderIndex = config.wallets.findIndex((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
    if (senderIndex === -1) {
      console.error(chalk.red(`${getEmoji('x')} Sender wallet not found in config`));
      return successCount;
    }
    const recipientIndex = (senderIndex + 1) % config.wallets.length;
    recipient = config.wallets[recipientIndex].address;
  } else {
    recipient = recipients[0];
  }

  for (let i = 0; i < times; i++) {
    if (friends.length > 0) {
      const recipientIndex: number = i % recipients.length;
      recipient = recipients[recipientIndex];
    }

    try {
      console.log(chalk.cyan(`${getEmoji('gift')} Sending ${amount} PHRS from ${walletAddress} to ${recipient} (${i + 1}/${times})...`));

      const balance: ethers.BigNumber = await provider!.getBalance(walletAddress);
      if (balance.lt(amountWei)) {
        console.error(
          chalk.red(
            `${getEmoji('warning')} Insufficient PHRS balance in ${walletAddress} for transfer to ${recipient}. Have ${ethers.utils.formatUnits(
              balance,
              PHRS_DECIMALS
            )}, need ${amount}`
          )
        );
        continue;
      }

      const feeData = await provider!.getFeeData();
      const tx = await wallet.sendTransaction({
        to: recipient,
        value: amountWei,
        gasLimit: 21000,
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
      });

      console.log(chalk.yellow(`${getEmoji('hourglass')} Transfer pending from ${walletAddress}: ${tx.hash}`));
      const receipt: ethers.providers.TransactionReceipt = await tx.wait();
      console.log(chalk.green(`${getEmoji('tada')} Send Tx from ${walletAddress}: ${receipt.transactionHash} (Gas Used: ${receipt.gasUsed})`));
      console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

      // Verify the transfer task
      const verified = await verifyTask(walletAddress, receipt.transactionHash, 103, authToken); // task_id=103 for transfers
      if (verified) {
        successCount++;
      }

      if (i < times - 1) {
        const delay: number = Math.floor(Math.random() * 3000) + 2000;
        console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delay / 1000} seconds before next transfer from ${walletAddress}...`));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Send from ${walletAddress} to ${recipient} Error: ${error.message}`));
    }
  }

  console.log(chalk.green(`${getEmoji('gift')} Send Summary for ${walletAddress}: ${successCount}/${times} successful transfers`));
  return successCount;
}

// Modified runDailyTasks
async function runDailyTasks(featureNumber: number, params: SwapParams, wallet: WalletConfig): Promise<FaucetStatus | null> {
  console.log(chalk.blue(`${getEmoji('rocket')} Running daily tasks for Feature ${featureNumber} (Wallet: ${wallet.address})...`));

  const faucetStatus = await checkFaucetStatus(wallet.address, wallet.authToken);
  if (faucetStatus && !faucetStatus.is_able_to_faucet) {
    console.log(chalk.yellow(`${getEmoji('hourglass')} Faucet on cooldown for ${wallet.address} until ${new Date(faucetStatus.available_timestamp * 1000).toUTCString()}`));
  } else {
    await claimDailyFaucet(wallet.address, wallet.authToken);
  }

  if ((featureNumber === 1 || featureNumber === 2 || featureNumber === 4) && params.tokenIn) {
    const usdcFaucetResult = await claimTokenFaucet(TOKENS.USDC.address, wallet.address);
    if (usdcFaucetResult === true || typeof usdcFaucetResult === 'string') {
      console.log(chalk.green(`${getEmoji('coin')} USDC faucet claimed or sufficient for ${wallet.address}`));
    } else {
      console.log(chalk.yellow(`${getEmoji('warning')} USDC faucet failed for ${wallet.address}, proceeding with existing balance`));
    }
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay between faucet calls
    const usdtFaucetResult = await claimTokenFaucet(TOKENS.USDT.address, wallet.address);
    if (usdtFaucetResult === true || typeof usdtFaucetResult === 'string') {
      console.log(chalk.green(`${getEmoji('coin')} USDT faucet claimed or sufficient for ${wallet.address}`));
    } else {
      console.log(chalk.yellow(`${getEmoji('warning')} USDT faucet failed for ${wallet.address}, proceeding with existing balance`));
    }
  }

  await dailySignIn(wallet.address, wallet.authToken);
  await checkSignInStatus(wallet.address, wallet.authToken);
  await getUserProfile(wallet.address, wallet.authToken);

  if ((featureNumber === 1 || featureNumber === 2 || featureNumber === 4) && params.tokenIn && params.tokenOut && params.swapAmount && params.swapTimes) {
    await swapTokens(params.tokenIn, params.tokenOut, params.swapAmount, params.swapTimes, wallet.address, wallet.authToken);
  }

  if ((featureNumber === 1 || featureNumber === 4) && params.sendAmount && params.sendTimes && params.friends) {
    await sendToFriends(params.sendAmount, params.sendTimes, params.friends, wallet.address, wallet.authToken);
  }

  console.log(chalk.green(`${getEmoji('tada')} Daily tasks for Feature ${featureNumber} completed for ${wallet.address}!`));
  return faucetStatus;
}

// Schedule tasks
async function scheduleAndLogTasks(featureNumber: number, params: SwapParams = {}): Promise<void> {
  console.log(chalk.blue(`${getEmoji('calendar')} Executing immediate tasks for Feature ${featureNumber}...`));
  let nextRunTime: number = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  for (const wallet of config.wallets) {
    const faucetStatus: FaucetStatus | null = await runDailyTasks(featureNumber, params, wallet);
    if (faucetStatus && faucetStatus.available_timestamp < nextRunTime) {
      nextRunTime = faucetStatus.available_timestamp;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Delay between wallets
  }

  while (true) {
    const currentTime: number = Math.floor(Date.now() / 1000);
    if (currentTime < nextRunTime) {
      console.log(chalk.blue(`${getEmoji('clock3')} Next run scheduled for ${new Date(nextRunTime * 1000).toUTCString()}`));
      await new Promise((resolve) => setTimeout(resolve, (nextRunTime - currentTime) * 1000));
    }

    console.log(chalk.blue(`${getEmoji('calendar')} Running scheduled daily tasks for Feature ${featureNumber}...`));
    nextRunTime = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    for (const wallet of config.wallets) {
      const faucetStatus = await runDailyTasks(featureNumber, params, wallet);
      if (faucetStatus && faucetStatus.available_timestamp < nextRunTime) {
        nextRunTime = faucetStatus.available_timestamp;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Configuration Menu
async function configMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('gear')} ========================================================`));
  console.log(chalk.cyan(`${getEmoji('gear')} Configuration Settings`));
  console.log(chalk.cyan(`${getEmoji('gear')} ==============================================`));

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an option:',
      choices: ['Manage Main Wallets', 'Update RPC URL', 'Manage Friend Addresses', 'Back to Main Menu'],
    },
  ]);

  switch (action) {
    case 'Manage Main Wallets':
      await manageWalletsMenu();
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

// Manage wallets menu
async function manageWalletsMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('key')} ==============================================`));
  console.log(chalk.cyan(`${getEmoji('key')} Main Wallets Management`));
  console.log(chalk.cyan(`${getEmoji('key')} ==============================================`));

  if (config.wallets && config.wallets.length > 0) {
    console.log(chalk.blue(`Current main wallets (${config.wallets.length}):`));
    config.wallets.forEach((wallet: WalletConfig, i: number) => {
      console.log(chalk.blue(`${i + 1}. ${wallet.address} (Bearer: ${wallet.authToken.slice(0, 10)}...${wallet.authToken.slice(-10)})`));
    });
  } else {
    console.log(chalk.yellow(`${getEmoji('warning')} No main wallets configured`));
  }

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an option:',
      choices: ['Add Main Wallet', 'Remove Main Wallet', 'Clear All Wallets', 'Back to Config Menu'],
    },
  ]);

  switch (action) {
    case 'Add Main Wallet':
      let walletNumber = config.wallets.length + 1;
      while (true) {
        const { privateKey } = await inquirer.prompt<{ privateKey: string }>([
          {
            type: 'input',
            name: 'privateKey',
            message: `Input your main wallet ${walletNumber} private key (without 0x, press Enter to finish):`,
            validate: (input: string) => {
              if (input === '') return true;
              return input.length >= 64 ? true : 'Please enter a valid private key';
            },
          },
        ]);

        if (privateKey === '') break;

        const { authToken } = await inquirer.prompt<{ authToken: string }>([
          {
            type: 'input',
            name: 'authToken',
            message: `Input your bearer token for wallet ${walletNumber}:`,
            validate: (input: string) => (input ? true : 'Bearer token cannot be empty'),
          },
        ]);

        try {
          const wallet = new ethers.Wallet(privateKey, provider);
          config.wallets.push({
            address: wallet.address,
            privateKey: `0x${privateKey.replace(/^0x/, '')}`,
            authToken,
          });
          console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet ${walletNumber} added: ${wallet.address}`));
          walletNumber++;
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Invalid private key for wallet ${walletNumber}: ${error.message}`));
        }
      }
      saveConfig();
      await setupWallets();
      break;

    case 'Remove Main Wallet':
      if (!config.wallets || config.wallets.length === 0) {
        console.log(chalk.yellow(`${getEmoji('warning')} No main wallets to remove`));
        break;
      }

      const { indexToRemove } = await inquirer.prompt<{ indexToRemove: number }>([
        {
          type: 'list',
          name: 'indexToRemove',
          message: 'Select wallet to remove:',
          choices: config.wallets.map((wallet: WalletConfig, i: number) => ({
            name: `${i + 1}. ${wallet.address}`,
            value: i,
          })),
        },
      ]);

      config.wallets.splice(indexToRemove, 1);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet removed!`));
      await setupWallets();
      break;

    case 'Clear All Wallets':
      const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure you want to remove all main wallets?',
          default: false,
        },
      ]);

      if (confirm) {
        config.wallets = [];
        saveConfig();
        console.log(chalk.green(`${getEmoji('white_check_mark')} All main wallets removed`));
        await setupWallets();
      }
      break;
  }

  if (action !== 'Back to Config Menu') {
    await manageWalletsMenu();
  }
}

// Manage friends menu
async function manageFriendsMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ================================================`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} Friend Addresses Management`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ======================================`));

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
            const addrs: string[] = input.split(',').map((addr: string) => addr.trim());
            return addrs.every((addr) => ethers.utils.isAddress(addr)) ? true : 'One or more addresses are invalid';
          },
        },
      ]);

      config.friendAddresses = [...new Set([...(config.friendAddresses || []), ...addresses.split(',').map((addr: string) => addr.trim())])];
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
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));
  console.log(chalk.green(` * ${getEmoji('robot')} Pharos Automatic Bot ${getEmoji('sparkles')} *`));
  console.log(chalk.green(` *                                                        *`));
  console.log(chalk.green(` * ${getEmoji('one')} [1] Swap, Check In, and Send PHRS to Friends/Wallets *`));
  console.log(chalk.green(` * ${getEmoji('two')} [2] Swap and Check In (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('three')} [3] Check In Only (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('four')} [4] Swap, Check In, and Send PHRS to Friends/Wallets (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('wrench')} [5] Configuration *`));
  console.log(chalk.green(` * ${getEmoji('x')} [6] Exit *`));
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));

  const { feature } = await inquirer.prompt<{ feature: string }>([
    {
      type: 'list',
      name: 'feature',
      message: 'Select a feature to run:',
      choices: [
        '1 - Swap, Check In, and Send PHRS to Friends/Wallets',
        '2 - Swap and Check In (All Wallets)',
        '3 - Check In Only (All Wallets)',
        '4 - Swap, Check In, and Send PHRS to Friends/Wallets (All Wallets)',
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

    params.tokenIn = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDC.address : TOKENS.USDT.address;
    params.tokenOut = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDT.address : TOKENS.USDC.address;
    params.swapAmount = swapAmount;
    params.swapTimes = swapTimes;
  }

  if (featureNumber === 1 || featureNumber === 4) {
    const { sendAmount, sendTimes, useFriends } = await inquirer.prompt<{
      sendAmount: number;
      sendTimes: number;
      useFriends: boolean;
    }>([
      {
        type: 'list',
        name: 'sendAmount',
        message: 'Select amount to send (PHRS):',
        choices: [
          { name: '0.001 PHRS', value: 0.001 },
          { name: '0.05 PHRS', value: 0.05 },
          { name: '0.1 PHRS', value: 0.1 },
          { name: '0.2 PHRS', value: 0.2 },
        ],
        default: 0.1,
      },
      {
        type: 'number',
        name: 'sendTimes',
        message: 'Enter number of sends (iterations):',
        default: 10,
        validate: (input: number) => (input >= 1 ? true : 'Number of sends must be at least 1'),
      },
      {
        type: 'confirm',
        name: 'useFriends',
        message: 'Send to friend addresses instead of cycling through main wallets?',
        default: config.friendAddresses.length > 0,
      },
    ]);

    params.sendAmount = sendAmount;
    params.sendTimes = sendTimes;
    params.friends = useFriends ? config.friendAddresses : [];
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

  await promptForAdditionalWallets();

  if (!(await setupWallets())) {
    console.log(chalk.yellow(`${getEmoji('warning')} Please configure at least one valid main wallet`));
    await configMenu();
    if (!(await setupWallets())) {
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
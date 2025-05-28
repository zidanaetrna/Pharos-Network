// index.ts
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

// Configuration interface
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
  addLpTimes?: number;
}

// Configuration file handling
const CONFIG_PATH: string = path.join(__dirname, 'config.json');
const TOKEN_CACHE_PATH: string = path.join(__dirname, 'tokens_cache.json');

let config: Config = {
  wallets: [],
  rpcUrl: process.env.RPC_URL || 'https://testnet.dplabs-internal.com',
  friendAddresses: process.env.FRIEND_ADDRESSES ? process.env.FRIEND_ADDRESSES.split(',') : [],
};

// Load config if exists
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
  WPHRS: {
    address: '0x76aaaDA469D23216bE5f7C596fA25F282Ff9b364',
    name: 'WPHRS',
    decimals: 18,
  },
};

const ROUTER_ADDRESS: string = '0x1a4de519154ae51200b0ad7c90f7fac75547888a';
const POSITION_MANAGER_ADDRESS: string = '0xF8a1D4FF0f9b9Af7CE58E1fc1833688F3BFd6115';
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

// Router ABI (multicall)
const ROUTER_ABI: string[] = [
  'function multicall(uint256 deadline, bytes[] data) public returns (bytes[])',
];

// Liquidity Pool Contract ABI
const ADD_LP_CONTRACT_ABI: string[] = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) public payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
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
interface ApiResponse<T = any> {
  data: T;
  msg?: string;
  code?: number;
}

async function makeApiRequest<T>(method: 'GET' | 'POST', url: string, authToken: string, data: any = {}, retries: number = 3): Promise<ApiResponse<T>> {
  let attempt = 0;

  while (attempt < retries) {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Origin': 'https://testnet.pharosnetwork.xyz',
        'Referer': 'https://testnet.pharosnetwork.xyz/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Authorization': `Bearer ${authToken}`,
      };

      // Only include Content-Type for POST requests with a body
      if (method === 'POST' && Object.keys(data).length > 0) {
        headers['Content-Type'] = 'application/json';
      }

      const axiosConfig = {
        method,
        url,
        headers,
        data: method === 'POST' && Object.keys(data).length > 0 ? data : undefined,
        timeout: 10000, // 10-second timeout
      };

      const response = await axios(axiosConfig);
      if (!response.data || typeof response.data !== 'object') {
        throw new Error('Invalid API response format');
      }
      return response.data as ApiResponse<T>;
    } catch (error: any) {
      attempt++;
      const statusCode = error.response?.status || 'unknown';
      const errorMsg = error.response?.data?.msg || error.message || 'Unknown error';

      console.error(
        chalk.yellow(`${getEmoji('warning')} Attempt ${attempt}/${retries} - Error in ${method} ${url}: ${statusCode} ${errorMsg}`)
      );

      if (attempt >= retries) {
        throw new Error(`API request failed after ${retries} attempts: ${errorMsg}`);
      }

      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delay / 1000} seconds...`));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('API request failed');
}

// API Functions
async function dailySignIn(walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/in?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('calendar')} Sign-In for ${walletAddress}: ${response.msg}`));
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
    const response: ApiResponse<SignInStatus> = await makeApiRequest('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('mag')} Sign-In Status for ${walletAddress}: ${response.data.status}`));
    return response.data;
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
    const response: ApiResponse<{ user_info: UserProfile }> = await makeApiRequest('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('bust_in_silhouette')} User Profile for ${walletAddress}:`));
    console.log(chalk.blue(`  UserName: ${response.data.user_info.UserName || 'N/A'}`));
    console.log(chalk.blue(`  TotalPoints: ${response.data.user_info.TotalPoints || '0'}`));
    console.log(chalk.blue(`  InviteCode: ${response.data.user_info.InviteCode || 'N/A'}`));
    return response.data.user_info;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} User Profile Error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

async function claimDailyFaucet(walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/faucet/daily?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('moneybag')} Daily PHRS Faucet for ${walletAddress}: ${response.msg}`));
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
    const response: ApiResponse<FaucetStatus> = await makeApiRequest('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('hourglass')} PHRS Faucet Status for ${walletAddress}: ${JSON.stringify(response.data)}`));
    return response.data;
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
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
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
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (error: any) {
      attempt++;
      const errorMsg: string = error.response?.data?.message || error.message;
      console.error(chalk.red(`${getEmoji('x')} ${tokenName} Faucet Error for ${walletAddress} (Attempt ${attempt}/${retries}): ${errorMsg}`));
      if (attempt >= retries) {
        console.error(chalk.red(`${getEmoji('x')} ${tokenName} Faucet failed for ${walletAddress} after ${retries} attempts`));
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
      await approveTx.wait();
      console.log(chalk.green(`${getEmoji('checkered_flag')} Approval Tx for ${walletAddress}: ${approveTx.hash}`));
    } else {
      console.log(chalk.blue(`${getEmoji('white_check_mark')} Sufficient ${tokenName} allowance for ${walletAddress}, skipping approval`));
    }

    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance/approval check failed for ${walletAddress}: ${error.message}`));
    return false;
  }
}

async function verifyTask(walletAddress: string, authToken: string, taskId: string, txHash: string): Promise<boolean> {
  // Validate inputs
  if (!walletAddress || !ethers.utils.isAddress(walletAddress)) {
    console.error(chalk.red(`${getEmoji('x')} Invalid wallet address: ${walletAddress}`));
    return false;
  }
  if (!taskId) {
    console.error(chalk.red(`${getEmoji('x')} Invalid task ID: ${taskId}`));
    return false;
  }
  if (!txHash || !txHash.startsWith('0x')) {
    console.error(chalk.red(`${getEmoji('x')} Invalid transaction hash: ${txHash}`));
    return false;
  }

  // Ensure checksummed address
  const checksummedAddress = ethers.utils.getAddress(walletAddress);
  const url = `https://api.pharosnetwork.xyz/task/verify?address=${checksummedAddress}&task_id=${taskId}&tx_hash=${txHash}`;
  
  console.log(chalk.blue(`${getEmoji('mag')} Verifying task ${taskId} for ${checksummedAddress} with txHash: ${txHash}`));

  let attempt = 0;
  const maxAttempts = 10;

  while (attempt < maxAttempts) {
    try {
      const response = await makeApiRequest('GET', url, authToken, {});
      if (response.code === 0) {
        console.log(chalk.green(`${getEmoji('white_check_mark')} Task verification successful for ${checksummedAddress}, TaskID: ${taskId}`));
        return true;
      } else {
        throw new Error(`code: ${response.code}, msg: ${response.msg}`);
      }
    } catch (error: any) {
      attempt++;
      console.error(chalk.yellow(`${getEmoji('hourglass')} Verification attempt ${attempt}/${maxAttempts} for ${checksummedAddress}, code: ${error.code || 'unknown'}, msg: ${error.message}, retrying...`));
      if (attempt >= maxAttempts) {
        console.error(chalk.red(`${getEmoji('x')} Task verification failed for ${checksummedAddress}, TaskID: ${taskId} after ${maxAttempts} attempts`));
        return false;
      }
      const delayTime = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise((resolve) => setTimeout(resolve, delayTime));
    }
  }
  return false;
}

// Add liquidity
async function addLiquidity(walletAddress: string, authToken: string, times: number): Promise<number> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return 0;
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken))) {
    console.error(chalk.red(`${getEmoji('x')} Skipping liquidity addition for ${walletAddress} due to insufficient PHRS`));
    return 0;
  }

  const lpContract = new ethers.Contract(POSITION_MANAGER_ADDRESS, ADD_LP_CONTRACT_ABI, wallet);
  let successCount = 0;

  const token0 = TOKENS.WPHRS.address;
  const token1 = TOKENS.USDC.address;
  const amount0 = 0.001; // WPHRS amount
  const amount1 = 0.15; // USDC amount
  const decimals0 = TOKENS.WPHRS.decimals;
  const decimals1 = TOKENS.USDC.decimals;

  for (let i = 0; i < times; i++) {
    try {
      console.log(chalk.cyan(`${getEmoji('droplet')} Adding liquidity ${i + 1}/${times} for ${walletAddress}: ${amount0} WPHRS / ${amount1} USDC`));

      if (!(await checkBalanceAndApproval(token0, amount0, decimals0, POSITION_MANAGER_ADDRESS, walletAddress))) {
        console.error(chalk.red(`${getEmoji('x')} Insufficient WPHRS balance or approval for ${walletAddress}`));
        continue;
      }
      if (!(await checkBalanceAndApproval(token1, amount1, decimals1, POSITION_MANAGER_ADDRESS, walletAddress))) {
        console.error(chalk.red(`${getEmoji('x')} Insufficient USDC balance or approval for ${walletAddress}`));
        continue;
      }

      const mintParams = {
        token0,
        token1,
        fee: 500,
        tickLower: -887220,
        tickUpper: 887220,
        amount0Desired: ethers.utils.parseUnits(amount0.toString(), decimals0),
        amount1Desired: ethers.utils.parseUnits(amount1.toString(), decimals1),
        amount0Min: 0,
        amount1Min: 0,
        recipient: walletAddress,
        deadline: Math.floor(Date.now() / 1000) + 300,
      };

      const feeData = await provider!.getFeeData();
      const estimatedGas = await lpContract.estimateGas.mint(mintParams);
      const tx = await lpContract.mint(mintParams, {
        gasLimit: Math.ceil(Number(estimatedGas) * 1.5),
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
      });

      console.log(chalk.yellow(`${getEmoji('hourglass')} Liquidity addition pending for ${walletAddress}: ${tx.hash}`));
      const receipt = await tx.wait();
      console.log(chalk.green(`${getEmoji('droplet')} Liquidity Tx for ${walletAddress}: ${receipt.transactionHash}`));
      console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));
      successCount++;

      if (i < times - 1) {
        const delayTime = Math.floor(Math.random() * 3000) + 2000;
        console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delayTime / 1000} seconds before next liquidity addition for ${walletAddress}`));
        await new Promise((resolve) => setTimeout(resolve, delayTime));
      }
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Liquidity addition ${i + 1} failed for ${walletAddress}: ${error.message}`));
    }
  }

  console.log(chalk.green(`${getEmoji('chart_with_upwards_trend')} Liquidity Summary for ${walletAddress}: ${successCount}/${times} successful additions`));
  return successCount;
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

async function swapTokens(tokenIn: string, tokenOut: string, amount: number, times: number, walletAddress: string, authToken: string): Promise<{ successCount: number, txHashes: string[] }> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return { successCount: 0, txHashes: [] };
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken))) {
    console.error(chalk.red(`${getEmoji('x')} Skipping swaps for ${walletAddress} due to insufficient PHRS`));
    return { successCount: 0, txHashes: [] };
  }

  const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  let successCount: number = 0;
  const txHashes: string[] = [];

  if (!(await validateTokens(tokenIn, tokenOut))) {
    console.error(chalk.red(`${getEmoji('warning')} Token validation failed`));
    return { successCount: 0, txHashes: [] };
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
        console.log(
          chalk.cyan(`${getEmoji('arrows_counterclockwise')} Swap ${i + 1}/${times} for ${walletAddress}: ${pair.from} -> ${pair.to} (${amount} ${pair.from}) (Attempt ${attempt + 1}/${maxAttempts})`)
        );

        const balanceApprovalSuccess = await checkBalanceAndApproval(tokenIn, amount, decimals, ROUTER_ADDRESS, walletAddress);
        if (!balanceApprovalSuccess) {
          console.error(chalk.red(`${getEmoji('warning')} Swap ${i + 1} failed for ${walletAddress}: Insufficient balance or approval after retries`));
          break;
        }

        const multicallData: string[] = getMulticallData(tokenIn, tokenOut, amount, decimals, walletAddress);
        console.log(chalk.blue(`${getEmoji('mag')} Multicall Data for ${walletAddress}: ${JSON.stringify(multicallData)}`));
        if (!multicallData || multicallData.length === 0 || multicallData.some((data) => !data || data === '0x')) {
          console.error(chalk.red(`${getEmoji('warning')} Invalid or empty multicall data for ${pair.from} -> ${pair.to} for ${walletAddress}`));
          break;
        }

        const deadline: number = Math.floor(Date.now() / 1000) + 600;
        const nonce = await provider!.getTransactionCount(walletAddress, 'pending');
        console.log(chalk.blue(`${getEmoji('mag')} Using nonce ${nonce} for swap ${i + 1} for ${walletAddress}`));

        let estimatedGas;
        try {
          await routerContract.callStatic.multicall(deadline, multicallData, { from: walletAddress, nonce });
          estimatedGas = await routerContract.estimateGas.multicall(deadline, multicallData, { from: walletAddress, nonce });
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Gas estimation failed for swap ${i + 1} for ${walletAddress}: ${error.message}`));
          attempt++;
          if (attempt >= maxAttempts) {
            console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed for ${walletAddress} after ${maxAttempts} attempts`));
            break;
          }
          const delayTime: number = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delayTime / 1000} seconds...`));
          await new Promise((resolve) => setTimeout(resolve, delayTime));
          continue;
        }

        const feeData = await provider!.getFeeData();
        const tx = await routerContract.multicall(deadline, multicallData, {
          gasLimit: Math.ceil(Number(estimatedGas) * 1.5),
          maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('5', 'gwei'),
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
          nonce,
        });

        console.log(chalk.yellow(`${getEmoji('hourglass')} Swap ${i + 1} pending for ${walletAddress}: ${tx.hash}`));
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction timed out')), 60000));
        const receipt = await Promise.race([tx.wait(), timeoutPromise]);

        if (receipt.status === 0) {
          throw new Error(`Transaction reverted: ${tx.hash}`);
        }
        console.log(chalk.green(`${getEmoji('rocket')} Swap ${i + 1} Tx for ${walletAddress}: ${receipt.transactionHash}`));
        console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));
        successCount++;
        txHashes.push(receipt.transactionHash); // Store transaction hash

        if (i < times - 1) {
          const delayTime: number = Math.floor(Math.random() * 2000) + 1000;
          console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delayTime / 1000} seconds before next swap for ${walletAddress}...`));
          await new Promise((resolve) => setTimeout(resolve, delayTime));
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
        if (error.message.includes('TX_REPLAY_ATTACK') || (error.error && error.error.code === -32600 && error.error.message.includes('TX_REPLAY_ATTACK'))) {
          console.error(chalk.yellow(`${getEmoji('warning')} Replay attack detected. Waiting for pending transactions to clear...`));
          await new Promise((resolve) => setTimeout(resolve, 10000));
          continue;
        }
        if (error.code === 'SERVER_ERROR' && error.status === 500) {
          console.error(chalk.yellow(`${getEmoji('warning')} RPC server error (500). Retrying...`));
          if (attempt >= maxAttempts) {
            console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed for ${walletAddress} after ${maxAttempts} attempts`));
            break;
          }
          const delayTime: number = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delayTime / 1000} seconds...`));
          await new Promise((resolve) => setTimeout(resolve, delayTime));
          continue;
        }
        if (attempt >= maxAttempts) {
          console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed for ${walletAddress} after ${maxAttempts} attempts`));
          break;
        }
        const delayTime: number = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(chalk.yellow(`${getEmoji('hourglass')} Retrying in ${delayTime / 1000} seconds...`));
        await new Promise((resolve) => setTimeout(resolve, delayTime));
      }
    }
  }
  console.log(chalk.green(`${getEmoji('chart_with_upwards_trend')} Swap Summary for ${walletAddress}: ${successCount}/${times} successful swaps`));
  return { successCount, txHashes };
}

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

  const amountWei = ethers.utils.parseEther(amount.toString());
  let successCount: number = 0;

  let recipients: string[] = friends.length > 0 ? friends : config.wallets.map((w) => w.address);
  if (recipients.length === 0) {
    console.error(chalk.red(`${getEmoji('x')} No recipients configured for ${walletAddress}`));
    return 0;
  }

  let recipient: string;
  if (friends.length === 0) {
    const senderIndex = wallets.findIndex((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
    if (senderIndex === -1) {
      console.error(chalk.red(`${getEmoji('x')} Sender wallet not found in config`));
      return 0;
    }
    const recipientIndex = (senderIndex + 1) % recipients.length;
    recipient = recipients[recipientIndex];
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
      const receipt = await tx.wait();
      console.log(chalk.green(`${getEmoji('tada')} Send Tx from ${walletAddress}: ${receipt.transactionHash}`));
      console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

      console.log(chalk.blue(`${getEmoji('hourglass')} Verifying transfer task for ${walletAddress}...`));
      await verifyTask(walletAddress, authToken, '103', receipt.transactionHash);

      successCount++;

      if (i < times - 1) {
        const delayTime: number = Math.floor(Math.random() * 3000) + 2000;
        console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delayTime / 1000} seconds before next transfer from ${walletAddress}...`));
        await new Promise((resolve) => setTimeout(resolve, delayTime));
      }
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Send from ${walletAddress} to ${recipient} Error: ${error.message}`));
    }
  }

  console.log(chalk.green(`${getEmoji('gift')} Send Summary for ${walletAddress}: ${successCount}/${times} successful transfers`));
  return successCount;
}

// Run daily tasks for a specific wallet
async function runDailyTasks(featureNumber: number, params: SwapParams, wallet: WalletConfig): Promise<FaucetStatus | null> {
  console.log(chalk.blue(`${getEmoji('rocket')} Running daily tasks for Feature ${featureNumber} (Wallet: ${wallet.address})...`));

  // Perform common tasks: faucet claim, sign-in, profile check
  await claimDailyFaucet(wallet.address, wallet.authToken);
  const faucetStatus = await checkFaucetStatus(wallet.address, wallet.authToken);
  await dailySignIn(wallet.address, wallet.authToken);
  await checkSignInStatus(wallet.address, wallet.authToken);
  await getUserProfile(wallet.address, wallet.authToken);

  // Claim token faucets if needed
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4 || featureNumber === 5) {
    if (params.tokenIn) {
      await claimTokenFaucet(params.tokenIn, wallet.address);
    }
    if (featureNumber === 5) {
      await claimTokenFaucet(TOKENS.WPHRS.address, wallet.address);
    }
  }

  // Feature-specific tasks
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4 || featureNumber === 5) {
    // Perform swaps
    if (params.tokenIn && params.tokenOut && params.swapAmount && params.swapTimes) {
      const swapResult = await swapTokens(
        params.tokenIn,
        params.tokenOut,
        params.swapAmount,
        params.swapTimes,
        wallet.address,
        wallet.authToken
      );
      if (swapResult.successCount > 0) {
        console.log(chalk.green(`${getEmoji('white_check_mark')} Completed ${swapResult.successCount}/${params.swapTimes} swaps for ${wallet.address}`));
        
        // Verify swap task for Feature 4
        if (featureNumber === 4 && swapResult.txHashes.length > 0) {
          console.log(chalk.cyan(`${getEmoji('hourglass')} Verifying swap task for ${wallet.address}...`));
          const swapTxHash = swapResult.txHashes[0]; // Use the first successful swap's txHash
          const swapVerificationResult = await verifyTask(wallet.address, wallet.authToken, '101', swapTxHash);
          if (swapVerificationResult) {
            console.log(chalk.green(`${getEmoji('white_check_mark')} Swap task verified successfully for ${wallet.address}`));
          } else {
            console.error(chalk.red(`${getEmoji('x')} Swap task verification failed for ${wallet.address}`));
          }
        }
      } else {
        console.error(chalk.red(`${getEmoji('x')} No successful swaps for ${wallet.address}`));
      }
    }
  }

  if (featureNumber === 1 || featureNumber === 4 || featureNumber === 5) {
    // Perform sends to friends/wallets (includes send task verification)
    if (params.sendAmount && params.sendTimes && params.friends) {
      const sendResult = await sendToFriends(
        params.sendAmount,
        params.sendTimes,
        params.friends,
        wallet.address,
        wallet.authToken
      );
      if (sendResult > 0) {
        console.log(chalk.green(`${getEmoji('white_check_mark')} Completed ${sendResult}/${params.sendTimes} sends for ${wallet.address}`));
      } else {
        console.error(chalk.red(`${getEmoji('x')} No successful sends for ${wallet.address}`));
      }
    }
  }

  if (featureNumber === 5) {
    // Add liquidity
    if (params.addLpTimes) {
      const lpResult = await addLiquidity(wallet.address, wallet.authToken, params.addLpTimes);
      if (lpResult > 0) {
        console.log(chalk.green(`${getEmoji('white_check_mark')} Completed ${lpResult}/${params.addLpTimes} liquidity additions for ${wallet.address}`));
      } else {
        console.error(chalk.red(`${getEmoji('x')} No successful liquidity additions for ${wallet.address}`));
      }
    }
  }

  console.log(chalk.green(`${getEmoji('tada')} Daily tasks for Feature ${featureNumber} completed for ${wallet.address}!`));
  return faucetStatus;
}

// Schedule tasks for all wallets
async function scheduleAndLogTasks(featureNumber: number, params: SwapParams = {}): Promise<void> {
  console.log(chalk.blue(`${getEmoji('calendar')} Executing immediate tasks for Feature ${featureNumber}...`));
  let nextRunTime: number = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  for (const wallet of config.wallets) {
    const faucetStatus: FaucetStatus | null = await runDailyTasks(featureNumber, params, wallet);
    if (faucetStatus && faucetStatus.available_timestamp < nextRunTime) {
      nextRunTime = faucetStatus.available_timestamp;
    }
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
    }
  }
}

// Configuration Menu
async function configMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('gear')} ==============================================`));
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
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ==============================================`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} Friend Addresses Management`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ==============================================`));

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
          validate: (input: string) => ethers.utils.isAddress(input) ? true : 'Please enter a valid Ethereum address',
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
          choices: config.friendAddresses.map((addr: string, i: number) => ({
            name: `${i + 1}. ${addr}`,
            value: i,
          })),
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
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));
  console.log(chalk.green(` * ${getEmoji('robot')} Pharos Automatic Bot ${getEmoji('sparkles')} *`));
  console.log(chalk.green(` *                                                        *`));
  console.log(chalk.green(` * ${getEmoji('one')} [1] Swap, Check In, and Send PHRS to Friends/Wallets *`));
  console.log(chalk.green(` * ${getEmoji('two')} [2] Swap and Check In (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('three')} [3] Check In Only (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('four')} [4] Swap, Check In, and Send PHRS to Friends/Wallets (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('five')} [5] Swap, Check In, Send PHRS, and Add Liquidity (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('wrench')} [6] Configuration *`));
  console.log(chalk.green(` * ${getEmoji('x')} [7] Exit *`));
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
        '5 - Swap, Check In, Send PHRS, and Add Liquidity (All Wallets)',
        '6 - Configuration',
        '7 - Exit',
      ],
    },
  ]);

  const featureNumber: number = parseInt(feature.split(' - ')[0]);

  if (featureNumber === 6) {
    await configMenu();
    await mainMenu();
    return;
  }

  if (featureNumber === 7) {
    console.log(chalk.yellow(`${getEmoji('wave')} Exiting Pharos Bot...`));
    process.exit(0);
  }

  let params: SwapParams = {};
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4 || featureNumber === 5) {
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

  if (featureNumber === 1 || featureNumber === 4 || featureNumber === 5) {
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

  if (featureNumber === 5) {
    const { addLpTimes } = await inquirer.prompt<{
      addLpTimes: number;
    }>([
      {
        type: 'number',
        name: 'addLpTimes',
        message: 'Enter number of liquidity additions:',
        default: 1,
        validate: (input: number) => (input >= 1 ? true : 'Number of additions must be at least 1'),
      },
    ]);

    params.addLpTimes = addLpTimes;
  }

  await scheduleAndLogTasks(featureNumber, params);
}

// Initialize and start
async function start(): Promise<void> {
  console.log(chalk.cyan(`${getEmoji('rocket')} Starting Pharos Automatic Bot...`));

  if (!(await initProvider())) {
    console.error(chalk.red(`${getEmoji('x')} Failed to initialize provider. Exiting...`));
    process.exit(1);
  }

  if (!(await setupWallets())) {
    console.log(chalk.yellow(`${getEmoji('warning')} No valid wallets configured. Please add wallets.`));
    await configMenu();
    if (!(await setupWallets())) {
      console.error(chalk.red(`${getEmoji('x')} No valid wallets configured after setup. Exiting...`));
      process.exit(1);
    }
  }

  await promptForAdditionalWallets();
  await mainMenu();
}

start().catch((error) => {
  console.error(chalk.red(`${getEmoji('x')} Fatal Error: ${error.message}`));
  process.exit(1);
});
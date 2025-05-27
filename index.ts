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
  addLiquidity?: boolean;
  wrapAmount?: number;
  unwrapAmount?: number;
}

// Configuration file handling
const CONFIG_PATH: string = path.join(__dirname, 'config.json');
const TOKEN_CACHE_PATH: string = path.join(__dirname, 'tokens_cache.json');

let config: Config = {
  wallets: [],
  rpcUrl: process.env.RPC_URL || 'https://testnet.dplabs-internal.com',
  friendAddresses: process.env.FRIEND_ADDRESSES ? process.env.FRIEND_ADDRESSES.split(',') : [],
};

// Load and migrate config if exists
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const rawConfig: any = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Migrate old config format to new format
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
    // Validate wallets
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

// Contract addresses and constants
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
    address: '0x76aaaDA469D2a316eB5f7C596F282A1F282A9b364',
    name: 'WPHRS',
    decimals: 18,
  },
};

const ROUTER_ADDRESS: string = '0x1a4de519154ae51200b0ad7c90f7fac75547888a';
const FAUCET_ADDRESS: string = '0x11de0e754f1df7c7b0d559721b334809a9c0dfb7';
const POSITION_MANAGER_ADDRESS: string = '0xF8AaD4Da0f9b9Af7cE58E1fC1833688F3CFd611';
const PHRS_DECIMALS: number = 18;
const MINIMUM_PHRS_BALANCE: string = '0.01';
const MINIMUM_TOKEN_BALANCE: string = '0.1';

const TASK_IDS = {
  SWAP_USDC_TO_USDT: 'swap_usdc_to_usdt',
  SWAP_USDT_TO_USDC: 'swap_usdt_to_usdc',
  SWAP_WPHRS_TO_USDC: 'swap_wphrs_to_usdc',
  SWAP_WPHRS_TO_USDT: 'swap_wphrs_to_usdt',
  SWAP_USDC_TO_WPHRS: 'swap_usdc_to_wphrs',
  SWAP_USDT_TO_WPHRS: 'swap_usdt_to_wphrs',
  SEND_PHRS: '103',
  FAUCET_USDC: '1000',
  FAUCET_USDT: '2000',
  ADD_LIQUIDITY: 'add_lp',
  WRAP_PHRS: 'wrap_phrs',
  UNWRAP_WPHRS: 'unwrap_wphrs',
  SIGN_IN: 'sign_in',
};

// Initialize ethers
let provider: ethers.providers.JsonRpcProvider | undefined;
let wallets: ethers.Wallet[] = [];

// ABIs
const ERC20_ABI: string[] = [
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function deposit() public payable',
  'function withdraw(uint256 wad) public',
];

const ROUTER_ABI: string[] = [
  'function multicall(uint256 collectionAndSelfcalls, bytes[] data) public',
];

const FAUCET_ABI: any[] = [
  {
    inputs: [
      { internalType: 'address', name: '_asset', type: 'address' },
      { internalType: 'address', name: '_account', type: 'address' },
      { internalType: 'uint256', name: '_amount', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const POSITION_MANAGER_ABI: any[] = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'token0', type: 'address' },
          { internalType: 'address', name: 'token1', type: 'address' },
          { internalType: 'uint24', name: 'fee', type: 'uint24' },
          { internalType: 'int24', name: 'tickLower', type: 'int24' },
          { internalType: 'int24', name: 'tickUpper', type: 'int24' },
          { internalType: 'uint256', name: 'amount0Desired', type: 'uint256' },
          { internalType: 'uint256', name: 'amount1Desired', type: 'uint256' },
          { internalType: 'uint256', name: 'amount0Min', type: 'uint256' },
          { internalType: 'uint256', name: 'amount1Min', type: 'uint256' },
          { internalType: 'address', name: 'recipient', type: 'address' },
          { internalType: 'uint256', name: 'deadline', type: 'uint256' },
        ],
        internalType: 'struct INonfungiblePositionManager.MintParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'mint',
    outputs: [
      { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
      { internalType: 'uint128', name: 'liquidity', type: 'uint128' },
      { internalType: 'uint256', name: 'amount0', type: 'uint256' },
      { internalType: 'uint256', name: 'amount1', type: 'uint256' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
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
}

async function makeApiRequest<T>(method: string, url: string, authToken: string, data: any = {}, retries: number = 3): Promise<ApiResponse<T>> {
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

// Verify on-chain task
async function verifyTask(walletAddress: string, authToken: string, taskId: string, txHash: string): Promise<boolean> {
  const url = `https://api.pharosnetwork.xyz/task/verify?address=${walletAddress}&taskId=${taskId}&txHash=${txHash}`;
  try {
    const response: ApiResponse<{ msg: string; code: number }> = await makeApiRequest('GET', url, authToken, {}, 5);
    if (response.data.code === 0 && response.data.msg === 'ok') {
      console.log(chalk.green(`${getEmoji('white_check_mark')} Task ${taskId} verified for ${walletAddress}: ${txHash}`));
      return true;
    }
    console.error(chalk.red(`${getEmoji('x')} Task ${taskId} verification failed for ${walletAddress}: ${response.data.msg}`));
    return false;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Task ${taskId} verification error for ${walletAddress}: ${error.message}`));
    return false;
  }
}

// API Functions
async function dailySignIn(walletAddress: string, authToken: string): Promise<boolean> {
  const url = `https://api.pharosnetwork.xyz/sign/in?address=${walletAddress}`;
  try {
    const response: ApiResponse<{ msg: string; code: number }> = await makeApiRequest('POST', url, authToken, {}, 10);
    if (response.data.code === 0 && response.data.msg === 'ok') {
      console.log(chalk.green(`${getEmoji('calendar')} Sign-in successful for ${walletAddress}`));
      await verifyTask(walletAddress, authToken, TASK_IDS.SIGN_IN, '0x0'); // No tx hash for API-based sign-in
      return true;
    } else if (response.data.msg === 'already signed in today') {
      console.log(chalk.yellow(`${getEmoji('warning')} Already signed in today for ${walletAddress}`));
      return true;
    }
    console.error(chalk.red(`${getEmoji('x')} Sign-in failed for ${walletAddress}: ${response.data.msg}`));
    return false;
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
  TotalPoints: number;
  InviteCode: string;
}

async function getUserProfile(walletAddress: string, authToken: string): Promise<UserProfile | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/user/profile?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string; data: { user_info: UserProfile } }> = await makeApiRequest('GET', url, authToken);
    if (response.data.msg === 'ok') {
      const profile = response.data.data.user_info;
      console.log(chalk.blue(`${getEmoji('bust_in_silhouette')} User Profile for ${walletAddress}:`));
      console.log(chalk.blue(`  UserName: ${profile.UserName || 'N/A'}`));
      console.log(chalk.blue(`  TotalPoints: ${profile.TotalPoints || 0}`));
      console.log(chalk.blue(`  InviteCode: ${profile.InviteCode || 'N/A'}`));
      return profile;
    }
    console.error(chalk.red(`${getEmoji('x')} Failed to fetch profile for ${walletAddress}`));
    return null;
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

// On-chain faucet mint
async function mintFaucet(tokenAddress: string, walletAddress: string, authToken: string): Promise<string | null> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return null;
  }

  const tokenName = TOKENS[Object.keys(TOKENS).find((k) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.name || 'Unknown';
  const faucetContract = new ethers.Contract(FAUCET_ADDRESS, FAUCET_ABI, wallet);
  const amount = ethers.utils.parseUnits('1000', 6); // 1000 USDC/USDT (6 decimals)

  const balanceInfo = await checkBalance(tokenAddress, walletAddress);
  const requiredAmount = ethers.utils.parseUnits(MINIMUM_TOKEN_BALANCE, 6);
  if (balanceInfo.raw.gte(requiredAmount)) {
    console.log(chalk.blue(`${getEmoji('bar_chart')} Sufficient ${tokenName} balance for ${walletAddress}, skipping faucet`));
    return null;
  }

  try {
    console.log(chalk.cyan(`${getEmoji('coin')} Minting 1000 ${tokenName} for ${walletAddress}`));
    const estimatedGas = await faucetContract.estimateGas.mint(tokenAddress, walletAddress, amount);
    const feeData = await provider!.getFeeData();
    const tx = await faucetContract.mint(tokenAddress, walletAddress, amount, {
      gasLimit: Math.ceil(Number(estimatedGas) * 1.2),
      maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
    });

    console.log(chalk.yellow(`${getEmoji('hourglass')} Mint pending for ${walletAddress}: ${tx.hash}`));
    const receipt = await tx.wait();
    console.log(chalk.green(`${getEmoji('rocket')} Mint Tx for ${walletAddress}: ${receipt.transactionHash}`));
    console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

    const taskId = tokenName === 'USDC' ? TASK_IDS.FAUCET_USDC : TASK_IDS.FAUCET_USDT;
    await verifyTask(walletAddress, authToken, taskId, receipt.transactionHash);

    return receipt.transactionHash;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Mint error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

// Add liquidity
async function addLiquidity(tokenAddress: string, walletAddress: string, authToken: string): Promise<string | null> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return null;
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken))) {
    console.error(chalk.red(`${getEmoji('x')} Insufficient PHRS balance for ${walletAddress}, skipping liquidity addition`));
    return null;
  }

  const tokenName = TOKENS[Object.keys(TOKENS).find((k) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.name || 'Unknown';
  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, wallet);

  const token0 = TOKENS.WPHRS.address.toLowerCase() < tokenAddress.toLowerCase() ? TOKENS.WPHRS.address : tokenAddress;
  const token1 = TOKENS.WPHRS.address.toLowerCase() < tokenAddress.toLowerCase() ? tokenAddress : TOKENS.WPHRS.address;
  const isToken0WPHRS = token0 === TOKENS.WPHRS.address;

  const amount0Desired = ethers.utils.parseUnits('0.1', isToken0WPHRS ? 18 : 6);
  const amount1Desired = ethers.utils.parseUnits('0.1', isToken0WPHRS ? 6 : 18);

  if (!(await checkBalanceAndApproval(token0, 0.1, isToken0WPHRS ? 18 : 6, POSITION_MANAGER_ADDRESS, walletAddress)) ||
      !(await checkBalanceAndApproval(token1, 0.1, isToken0WPHRS ? 6 : 18, POSITION_MANAGER_ADDRESS, walletAddress))) {
    console.error(chalk.red(`${getEmoji('x')} Insufficient balance or approval for liquidity addition`));
    return null;
  }

  const params = {
    token0,
    token1,
    fee: 500,
    tickLower: -887220,
    tickUpper: 887220,
    amount0Desired,
    amount1Desired,
    amount0Min: 0,
    amount1Min: 0,
    recipient: walletAddress,
    deadline: Math.floor(Date.now() / 1000) + 600,
  };

  try {
    console.log(chalk.cyan(`${getEmoji('droplet')} Adding liquidity for ${isToken0WPHRS ? 'WPHRS/' + tokenName : tokenName + '/WPHRS'} for ${walletAddress}`));
    const estimatedGas = await positionManager.estimateGas.mint(params, { value: isToken0WPHRS ? amount0Desired : amount1Desired });
    const feeData = await provider!.getFeeData();
    const tx = await positionManager.mint(params, {
      value: isToken0WPHRS ? amount0Desired : amount1Desired,
      gasLimit: Math.ceil(Number(estimatedGas) * 1.5),
      maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
    });

    console.log(chalk.yellow(`${getEmoji('hourglass')} Liquidity addition pending for ${walletAddress}: ${tx.hash}`));
    const receipt = await tx.wait();
    console.log(chalk.green(`${getEmoji('rocket')} Liquidity Tx for ${walletAddress}: ${receipt.transactionHash}`));
    console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

    await verifyTask(walletAddress, authToken, TASK_IDS.ADD_LIQUIDITY, receipt.transactionHash);
    return receipt.transactionHash;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Liquidity addition error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

// Wrap PHRS to WPHRS
async function wrapPhrs(amount: number, walletAddress: string, authToken: string): Promise<string | null> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return null;
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken, ethers.utils.formatUnits(amount)))) {
    console.error(chalk.red(`${getEmoji('invalid')} Insufficient PHRS balance for ${walletAddress}`));
    return null;
  }

  const wphrsContract = new ethers.Contract(TOKENS.WPHRS.address, ERC20_ABI, wallet);
  const amountWei = ethers.utils.parseEther(amount.toString());

  try {
    console.log(chalk.cyan(`${getEmoji('package')} Wrapping ${amount} PHRS to WPHRS for ${walletAddress}`));
    const estimatedGas = await wphrsContract.estimateGas.deposit({ value: amountWei });
    const feeData = await provider!.getFeeData();
    const tx = await wphrsContract.deposit({
      value: amountWei,
      gasLimit: Math.ceil(Number(estimatedGas) * 1.2),
      maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
    });

    console.log(chalk.yellow(`${getEmoji('hourglass')} Wrap pending for ${walletAddress}: ${tx.hash}`));
    const receipt = await tx.wait();
    console.log(chalk.green(`${getEmoji('rocket')} Wrap Tx for ${walletAddress}: ${receipt.transactionHash}`));
    console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

    await verifyTask(walletAddress, authToken, TASK_IDS.WRAP_PHRS, receipt.transactionHash);
    return receipt.transactionHash;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Wrap error for ${walletAddress}: ${error.message}`));
    return null;
  }
}

// Unwrap WPHRS to PHRS
async function unwrapPhrs(amount: number, walletAddress: string, authToken: string): Promise<string | null> {
  const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet ${walletAddress} not found`));
    return null;
  }

  if (!(await ensurePhrsBalance(walletAddress, authToken))) {
    console.error(chalk.red(`${getEmoji('x')} Insufficient PHRS balance for gas fees in ${walletAddress}`));
    return null;
  }

  const wphrsContract = new ethers.Contract(TOKENS.WPHRS.address, ERC20_ABI, wallet);
  const amountWei = ethers.utils.parseEther(amount.toString());

  if (!(await checkBalanceAndApproval(TOKENS.WPHRS.address, amount, 18, TOKENS.WPHRS.address, walletAddress))) {
    console.error(chalk.red(`${getEmoji('x')} Insufficient WPHRS balance or approval for ${walletAddress}`));
    return null;
  }

  try {
    console.log(chalk.cyan(`${getEmoji('package')} Unwrapping ${amount} WPHRS to PHRS for ${walletAddress}`));
    const estimatedGas = await wphrsContract.estimateGas.withdraw(amountWei);
    const feeData = await provider!.getFeeData();
    const tx = await wphrsContract.withdraw(amountWei, {
      gasLimit: Math.ceil(Number(estimatedGas) * 1.2),
      maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
    });

    console.log(chalk.yellow(`${getEmoji('hourglass')} Unwrap pending for ${walletAddress}: ${tx.hash}`));
    const receipt = await tx.wait();
    console.log(chalk.green(`${getEmoji('rocket')} Unwrap Tx for ${walletAddress}: ${receipt.transactionHash}`));
    console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

    await verifyTask(walletAddress, authToken, TASK_IDS.UNWRAP_WPHRS, receipt.transactionHash);
    return receipt.transactionHash;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Unwrap error for ${walletAddress}: ${error.message}`));
    return null;
  }
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
    const tokenKey = Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase());
    const decimals: number = tokenKey ? TOKENS[tokenKey].decimals : 6;
    const balance: ethers.BigNumber = await tokenContract.balanceOf(walletAddress);
    const formattedBalance: string = ethers.utils.formatUnits(balance, decimals);

    const tokenName: string = tokenKey ? TOKENS[tokenKey].name : 'Unknown Token';
    console.log(chalk.blue(`${getEmoji('bar_chart')} ${tokenName} Balance for ${walletAddress}: ${formattedBalance}`));
    return { raw: balance, formatted: formattedBalance, decimals };
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance Check Error for ${walletAddress}: ${error.message}`));
    return { raw: ethers.BigNumber.from(0), formatted: '0', decimals: tokenAddress ? 6 : PHRS_DECIMALS };
  }
}

// Ensure sufficient PHRS balance
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
      const tokenKey = Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase());
      const tokenName: string = tokenKey ? TOKENS[tokenKey].name : 'Unknown Token';
      console.error(chalk.red(`${getEmoji('x')} Insufficient ${tokenName} balance in ${walletAddress}: ${ethers.utils.formatUnits(balance, decimals)} < ${amount}`));
      return false;
    }

    const allowance: ethers.BigNumber = await tokenContract.allowance(walletAddress, spender);
    const tokenKey = Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase());
    const tokenName: string = tokenKey ? TOKENS[tokenKey].name : 'Unknown Token';
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

// Generate multicall data for swap
function getMulticallData(tokenIn: string, tokenOut: string, amount: number, decimals: number, walletAddress: string, fee: number = 500): string[] {
  try {
    // Validate token addresses
    if (!ethers.utils.isAddress(tokenIn) || !ethers.utils.isAddress(tokenOut)) {
      throw new Error(`Invalid token addresses: ${tokenIn}, ${tokenOut}`);
    }

    const scaledAmount = ethers.utils.parseUnits(amount.toString(), decimals);
    // Ensure token order (token0 < token1)
    const [token0, token1] = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
    const isToken0In = tokenIn.toLowerCase() === token0.toLowerCase();

    // Calculate deadline (10 minutes from now)
    const deadline = Math.floor(Date.now() / 1000) + 600;

    // Encode exactInputSingle parameters
    const params = {
      tokenIn,
      tokenOut,
      fee, // Pool fee tier (e.g., 500 for 0.05%)
      recipient: walletAddress,
      deadline,
      amountIn: scaledAmount,
      amountOutMinimum: 0, // Accept any output (adjust for production)
      sqrtPriceLimitX96: 0, // No price limit
    };

    const data = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint24', 'address', 'uint256', 'uint256', 'uint256', 'uint160'],
      [
        params.tokenIn,
        params.tokenOut,
        params.fee,
        params.recipient,
        params.deadline,
        params.amountIn,
        params.amountOutMinimum,
        params.sqrtPriceLimitX96,
      ]
    );

    // Uniswap V3-style exactInputSingle function selector
    return [ethers.utils.hexConcat(['0x414bf389', data])];
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Failed to generate multicall data: ${error.message}`));
    return [];
  }
}

// Perform token swaps
async function swapTokens(
  tokenIn: string,
  tokenOut: string,
  amount: number,
  times: number,
  walletAddress: string,
  authToken: string
): Promise<number> {
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

  const tokenInKey = Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenIn.toLowerCase());
  const tokenOutKey = Object.keys(TOKENS).find((k: string) => TOKENS[k].address.toLowerCase() === tokenOut.toLowerCase());
  const pair = {
    from: tokenInKey ? TOKENS[tokenInKey].name : 'Unknown',
    to: tokenOutKey ? TOKENS[tokenOutKey].name : 'Unknown',
  };

  const decimals: number = tokenInKey ? TOKENS[tokenInKey].decimals : 6;

  // Try multiple fee tiers if one fails
  const feeTiers = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

  for (let i = 0; i < times; i++) {
    let attempt: number = 0;
    const maxAttempts: number = 3;

    while (attempt < maxAttempts) {
      try {
        console.log(
          chalk.cyan(
            `${getEmoji('arrows_counterclockwise')} Swap ${i + 1}/${times} for ${walletAddress}: ${pair.from} -> ${pair.to} (${amount} ${pair.from}) (Attempt ${attempt + 1}/${maxAttempts})`
          )
        );

        if (!(await checkBalanceAndApproval(tokenIn, amount, decimals, ROUTER_ADDRESS, walletAddress))) {
          console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} failed for ${walletAddress}: Insufficient balance or approval`));
          break;
        }

        let multicallData: string[] = [];
        let feeUsed: number = 0;

        // Calculate deadline for this attempt
        const deadline: number = Math.floor(Date.now() / 1000) + 600;

        // Try each fee tier
        for (const fee of feeTiers) {
          multicallData = getMulticallData(tokenIn, tokenOut, amount, decimals, walletAddress, fee);
          console.log(chalk.blue(`${getEmoji('mag')} Multicall Data for ${walletAddress} (Fee ${fee}): ${JSON.stringify(multicallData)}`));

          if (!multicallData || multicallData.length === 0 || multicallData.some((data) => !data || data === '0x')) {
            console.error(chalk.red(`${getEmoji('x')} Invalid or empty multicall data for ${pair.from} -> ${pair.to} (Fee ${fee})`));
            continue;
          }

          // Simulate the transaction
          try {
            await routerContract.callStatic.multicall(deadline, multicallData, { from: walletAddress });
            feeUsed = fee;
            break; // Success, use this fee tier
          } catch (simulationError: any) {
            console.warn(chalk.yellow(`${getEmoji('warning')} Simulation failed for fee ${fee}: ${simulationError.message}`));
            if (fee === feeTiers[feeTiers.length - 1]) {
              throw new Error(`All fee tiers failed: ${simulationError.message}`);
            }
          }
        }

        if (multicallData.length === 0 || !feeUsed) {
          console.error(chalk.red(`${getEmoji('x')} No valid fee tier found for ${pair.from} -> ${pair.to}`));
          break;
        }

        // Estimate gas
        let estimatedGas: ethers.BigNumber;
        try {
          estimatedGas = await routerContract.estimateGas.multicall(deadline, multicallData, { from: walletAddress });
        } catch (gasError: any) {
          console.error(chalk.red(`${getEmoji('x')} Gas estimation failed for swap ${i + 1}: ${gasError.message}`));
          throw gasError;
        }

        const feeData = await provider!.getFeeData();
        const gasLimit = estimatedGas.mul(120).div(100); // 1.2x buffer
        const maxFeePerGas = feeData.maxFeePerGas || ethers.utils.parseUnits('5', 'gwei');
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei');

        const tx = await routerContract.multicall(deadline, multicallData, {
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });

        console.log(chalk.yellow(`${getEmoji('hourglass')} Swap ${i + 1} pending for ${walletAddress}: ${tx.hash}`));

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction timed out')), 60000));
        const receipt = await Promise.race([tx.wait(), timeoutPromise]);

        if (receipt.status === 0) {
          throw new Error(`Transaction reverted: ${tx.hash}`);
        }

        console.log(chalk.green(`${getEmoji('rocket')} Swap ${i + 1} Tx for ${walletAddress}: ${receipt.transactionHash}`));
        console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

        const taskId =
          pair.from === 'USDC' && pair.to === 'USDT' ? TASK_IDS.SWAP_USDC_TO_USDT :
          pair.from === 'USDT' && pair.to === 'USDC' ? TASK_IDS.SWAP_USDT_TO_USDC :
          pair.from === 'WPHRS' && pair.to === 'USDC' ? TASK_IDS.SWAP_WPHRS_TO_USDC :
          pair.from === 'WPHRS' && pair.to === 'USDT' ? TASK_IDS.SWAP_WPHRS_TO_USDT :
          pair.from === 'USDC' && pair.to === 'WPHRS' ? TASK_IDS.SWAP_USDC_TO_WPHRS :
          TASK_IDS.SWAP_USDT_TO_WPHRS;
        await verifyTask(walletAddress, authToken, taskId, receipt.transactionHash);

        successCount++;
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
        if (error.code === 'CALL_EXCEPTION') {
          console.error(chalk.yellow(`${getEmoji('warning')} Contract call exception: ${JSON.stringify(error.data || {})}`));
        }
        if (error.code === 'SERVER_ERROR' && error.status === 500) {
          console.error(chalk.yellow(`${getEmoji('warning')} RPC server error (500). Skipping this swap attempt for ${walletAddress}`));
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
    console.error(chalk.red(`${getEmoji('warning')} No recipients provided for ${walletAddress}`));
    return successCount;
  }

  let recipient: string;
  if (friends.length === 0) {
    const senderIndex = config.wallets.findIndex((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
    if (senderIndex === -1) {
      console.error(chalk.red(`${getEmoji('x')} Sender wallet not found in configuration`));
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
      const receipt = await tx.wait();
      console.log(chalk.green(`${getEmoji('tada')} Send Tx completed from ${walletAddress}: ${receipt.transactionHash}`));
      console.log(chalk.blue(`${getEmoji('mag')} Explorer: https://testnet.pharosscan.xyz/testnet/tx/${receipt.transactionHash}`));

      await verifyTask(walletAddress, authToken, TASK_IDS.SEND_PHRS, receipt.transactionHash);
      successCount++;

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

// Run daily tasks for a specific wallet
async function runDailyTasks(featureNumber: number, params: SwapParams, wallet: WalletConfig): Promise<FaucetStatus | null> {
  console.log(chalk.blue(`${getEmoji('rocket')} Running daily tasks for Feature ${featureNumber} (Wallet: ${wallet.address})...`));

  // Always claim faucets and perform sign-in
  await claimDailyFaucet(wallet.address, wallet.authToken);
  await dailySignIn(wallet.address, wallet.authToken);
  await checkSignInStatus(wallet.address, wallet.authToken);
  await getUserProfile(wallet.address, wallet.authToken);
  await checkFaucetStatus(wallet.address, wallet.authToken);

  // Mint USDC/USDT faucets for swaps or liquidity
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4 || featureNumber === 5) {
    await mintFaucet(TOKENS.USDC.address, wallet.address, wallet.authToken);
    await mintFaucet(TOKENS.USDT.address, wallet.address, wallet.authToken);
  }

  // Wrap PHRS
  if (featureNumber === 5 && params.wrapAmount) {
    await wrapPhrs(params.wrapAmount, wallet.address, wallet.authToken);
  }

  // Unwrap WPHRS
  if (featureNumber === 5 && params.unwrapAmount) {
    await unwrapPhrs(params.unwrapAmount, wallet.address, wallet.authToken);
  }

  // Add liquidity
  if ((featureNumber === 4 || featureNumber === 5) && params.addLiquidity) {
    await addLiquidity(TOKENS.USDC.address, wallet.address, wallet.authToken);
    await addLiquidity(TOKENS.USDT.address, wallet.address, wallet.authToken);
  }

  // Handle swaps
  if ((featureNumber === 1 || featureNumber === 2 || featureNumber === 4 || featureNumber === 5) && params.tokenIn && params.tokenOut && params.swapAmount && params.swapTimes) {
    await swapTokens(params.tokenIn, params.tokenOut, params.swapAmount, params.swapTimes, wallet.address, wallet.authToken);
  }

  // Handle sends
  if ((featureNumber === 1 || featureNumber === 4 || featureNumber === 5) && params.sendAmount && params.sendTimes && params.friends) {
    await sendToFriends(params.sendAmount, params.sendTimes, params.friends, wallet.address, wallet.authToken);
  }

  console.log(chalk.green(`${getEmoji('tada')} Daily tasks completed for Feature ${featureNumber} for ${wallet.address}!`));
  return await checkFaucetStatus(wallet.address, wallet.authToken);
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

// Configuration menu
async function configMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('gear')} ==============================================`));
  console.log(chalk.cyan(`${getEmoji('gear')} Configuration Settings`));
  console.log(chalk.cyan(`${getEmoji('gear')} ==============================================`));

  const { action } = await inquirer.prompt<{ action: string }>({
    type: 'list',
    name: 'action',
    message: 'Select an option:',
    choices: ['Manage Main Wallets', 'Update RPC URL', 'Manage Friend Addresses', 'Back to Main Menu'],
  });

  switch (action) {
    case 'Manage Main Wallets':
      await manageWalletsMenu();
      break;

    case 'Update RPC URL':
      const { rpcUrl } = await inquirer.prompt<{ rpcUrl: string }>({
        type: 'input',
        name: 'rpcUrl',
        message: `${getEmoji('link')} Enter RPC URL`,
        default: config.rpcUrl,
      });
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
// Manage wallets
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

  const { action } = await inquirer.prompt<{ action: string }>({
    type: 'list',
    name: 'action',
    message: 'Select an option:',
    choices: ['Add Main Wallet', 'Remove Main Wallet', 'Clear All Wallets', 'Back to Config Menu'],
  });

  switch (action) {
    case 'Add Main Wallet':
      let walletNumber = config.wallets.length + 1;
      while (true) {
        const { privateKey } = await inquirer.prompt<{ privateKey: string }>({
          type: 'input',
          name: 'privateKey',
          message: `Input your main wallet ${walletNumber} private key (without 0x, press Enter to finish):`,
          validate: (input: string) => {
            if (input === '') return true;
            return input.length >= 64 ? true : 'Please enter a valid private key';
          },
        });

        if (privateKey === '') break;

        const { authToken } = await inquirer.prompt<{ authToken: string }>({
          type: 'input',
          name: 'authToken',
          message: `Input your bearer token for wallet ${walletNumber}:`,
          validate: (input: string) => (input ? true : 'Bearer token cannot be empty'),
        });

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

      const { indexToRemove } = await inquirer.prompt<{ indexToRemove: number }>({
        type: 'list',
        name: 'indexToRemove',
        message: 'Select wallet to remove:',
        choices: config.wallets.map((wallet: WalletConfig, i: number) => ({
          name: `${i + 1}. ${wallet.address}`,
          value: i,
        })),
      });

      config.wallets.splice(indexToRemove, 1);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet removed!`));
      await setupWallets();
      break;

    case 'Clear All Wallets':
      const { confirm } = await inquirer.prompt<{ confirm: boolean }>({
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to remove all main wallets?',
        default: false,
      });

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

// Manage friends
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

  const { action } = await inquirer.prompt<{ action: string }>({
    type: 'list',
    name: 'action',
    message: 'Select an option:',
    choices: ['Add Friend Address', 'Remove Friend Address', 'Clear All Friends', 'Import Multiple Addresses', 'Back to Config Menu'],
  });

  switch (action) {
    case 'Add Friend Address':
      const { address } = await inquirer.prompt<{ address: string }>({
        type: 'input',
        name: 'address',
        message: `${getEmoji('bust_in_silhouette')} Enter friend's address:`,
        validate: (input: string) => (ethers.utils.isAddress(input) ? true : 'Please enter a valid Ethereum address'),
      });
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

      const { indexToRemove } = await inquirer.prompt<{ indexToRemove: number }>({
        type: 'list',
        name: 'indexToRemove',
        message: 'Select friend to remove:',
        choices: config.friendAddresses.map((addr: string, i: number) => ({
          name: `${i + 1}. ${addr}`,
          value: i,
        })),
      });

      config.friendAddresses.splice(indexToRemove, 1);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friend removed!`));
      break;

    case 'Clear All Friends':
      const { confirm } = await inquirer.prompt<{ confirm: boolean }>({
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to remove all friends?',
        default: false,
      });

      if (confirm) {
        config.friendAddresses = [];
        saveConfig();
        console.log(chalk.green(`${getEmoji('white_check_mark')} All friends removed!`));
      }
      break;

    case 'Import Multiple Addresses':
      const { addresses } = await inquirer.prompt<{ addresses: string }>({
        type: 'input',
        name: 'addresses',
        message: `${getEmoji('page_with_curl')} Enter comma-separated addresses:`,
        validate: (input: string) => {
          const addrs: string[] = input.split(',').map((a: string) => a.trim());
          return addrs.every((addr) => ethers.utils.isAddress(addr)) ? true : 'One or more addresses are invalid';
        },
      });

      config.friendAddresses = [...new Set([...(config.friendAddresses || []), ...addresses.split(',').map((a: string) => a.trim())])];
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friends imported!`));
      break;
  }

  if (action !== 'Back to Config Menu') {
    await manageFriendsMenu();
  }
}

// Main menu
async function mainMenu(): Promise<void> {
  console.clear();
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));
  console.log(chalk.green(` * ${getEmoji('robot')} Pharos Automatic Bot ${getEmoji('sparkles')} *`));
  console.log(chalk.green(` *                                                        *`));
  console.log(chalk.green(` * ${getEmoji('one')} [1] Swap, Check In, and Send PHRS to Friends/Wallets *`));
  console.log(chalk.green(` * ${getEmoji('two')} [2] Swap and Check In (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('three')} [3] Check In Only (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('four')} [4] Swap, Check In, Send PHRS, and Add Liquidity (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('five')} [5] Full Tasks: Swap, Send, Add Liquidity, Wrap/Unwrap PHRS *`));
  console.log(chalk.green(` * ${getEmoji('wrench')} [6] Configuration *`));
  console.log(chalk.green(` * ${getEmoji('x')} [7] Exit *`));
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));

  const { feature } = await inquirer.prompt<{ feature: string }>({
    type: 'list',
    name: 'feature',
    message: 'Select a feature to run:',
    choices: [
      '1 - Swap, Check In, and Send PHRS to Friends/Wallets',
      '2 - Swap and Check In (All Wallets)',
      '3 - Check In Only (All Wallets)',
      '4 - Swap, Check In, Send PHRS, and Add Liquidity (All Wallets)',
      '5 - Full Tasks: Swap, Send, Add Liquidity, Wrap/Unwrap PHRS',
      '6 - Configuration',
      '7 - Exit',
    ],
  });

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
      swapDirection: 'USDC_TO_USDT' | 'USDT_TO_USDC' | 'WPHRS_TO_USDC' | 'WPHRS_TO_USDT' | 'USDC_TO_WPHRS' | 'USDT_TO_WPHRS';
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
          { name: 'WPHRS → USDC', value: 'WPHRS_TO_USDC' },
          { name: 'WPHRS → USDT', value: 'WPHRS_TO_USDT' },
          { name: 'USDC → WPHRS', value: 'USDC_TO_WPHRS' },
          { name: 'USDT → WPHRS', value: 'USDT_TO_WPHRS' },
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

    params.tokenIn = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDC.address :
                     swapDirection === 'USDT_TO_USDC' ? TOKENS.USDT.address :
                     swapDirection === 'WPHRS_TO_USDC' ? TOKENS.WPHRS.address :
                     swapDirection === 'WPHRS_TO_USDT' ? TOKENS.WPHRS.address :
                     swapDirection === 'USDC_TO_WPHRS' ? TOKENS.USDC.address :
                     TOKENS.USDT.address;
    params.tokenOut = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDT.address :
                      swapDirection === 'USDT_TO_USDC' ? TOKENS.USDC.address :
                      swapDirection === 'WPHRS_TO_USDC' ? TOKENS.USDC.address :
                      swapDirection === 'WPHRS_TO_USDT' ? TOKENS.USDT.address :
                      swapDirection === 'USDC_TO_WPHRS' ? TOKENS.WPHRS.address :
                      TOKENS.WPHRS.address;
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

  if (featureNumber === 4 || featureNumber === 5) {
    params.addLiquidity = true;
  }

  if (featureNumber === 5) {
    const { wrapAmount, unwrapAmount } = await inquirer.prompt<{
      wrapAmount: number;
      unwrapAmount: number;
    }>([
      {
        type: 'number',
        name: 'wrapAmount',
        message: 'Enter amount of PHRS to wrap to WPHRS:',
        default: 0.1,
        validate: (input: number) => (input > 0 ? true : 'Amount must be positive'),
      },
      {
        type: 'number',
        name: 'unwrapAmount',
        message: 'Enter amount of WPHRS to unwrap to PHRS:',
        default: 0.1,
        validate: (input: number) => (input > 0 ? true : 'Amount must be positive'),
      },
    ]);

    params.wrapAmount = wrapAmount;
    params.unwrapAmount = unwrapAmount;
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
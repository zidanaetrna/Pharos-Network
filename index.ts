import * as dotenv from 'dotenv';
import axios, { AxiosResponse } from 'axios';
import { ethers, BigNumber } from 'ethers';
import inquirer from 'inquirer';
import { get as getEmoji } from 'node-emoji';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

dotenv.config();

console.log(chalk.cyan('Pharos Bot: Initializing...'));

// Configuration Interfaces
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
  liquidityPercentage?: number;
}

// Constants
const CONFIG_PATH: string = path.join(__dirname, 'config.json');
const TOKEN_CACHE_PATH: string = path.join(__dirname, 'tokens_cache.json');
const TOKENS: Tokens = {
  PHRS: { address: ethers.constants.AddressZero, name: 'PHRS', decimals: 18 },
  WPHRS: { address: '0xA1b4d3F3A49f4514CCEe434Cfc66837A1fFC', name: 'WPHRS', decimals: 18 }, // Update with actual address
  USDC: { address: '0xAD902CF99C2dE2f1Ba5ec4D642Lc7E49cae9EE37', name: 'USDC', decimals: 6 },
  USDT: { address: '0xEd59De2D7ad9C043442e381231eE3646FC3C2939', name: 'USDT', decimals: 6 },
};

const CONTRACTS = {
  ROUTER: '0x1a4de519154ae51200b0ad7c90f7fac75547888a',
  WPHRS: '0xA1b4d3F3A49f4514CCEe434Cfc66837A1fFC', // Update with actual address
  POSITION_MANAGER: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', // Update with actual address
  FAUCET: '0xFaucetAddress', // Update with actual address
};

const MINIMUM_PHRS_BALANCE: string = '0.01';
const MINIMUM_TOKEN_BALANCE: string = '0.1';
const PHRS_DECIMALS: number = 18;

// Contract ABIs
const ERC20_ABI: string[] = [
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

const WPHRS_ABI: string[] = [
  'function deposit() public payable',
  'function withdraw(uint256 wad) public',
];

const POSITION_MANAGER_ABI: string[] = [
  'function mint(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) public returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

const ROUTER_ABI: string[] = [
  'function multicall(uint256 deadline, bytes[] calldata data) external returns (bytes[] memory results)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)',
];

// Global Variables
let config: Config = {
  wallets: [],
  rpcUrl: process.env.RPC_URL || 'https://testnet.dplabs-internal.com',
  friendAddresses: process.env.FRIEND_ADDRESSES ? process.env.FRIEND_ADDRESSES.split(',') : [],
};
let provider: ethers.providers.JsonRpcProvider | undefined;
let wallets: ethers.Wallet[] = [];

// Load Config
function loadConfig(): void {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const rawConfig: any = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (rawConfig.walletAddress && rawConfig.privateKey && rawConfig.authToken) {
        config.wallets = [{
          address: rawConfig.walletAddress,
          privateKey: rawConfig.privateKey,
          authToken: rawConfig.authToken,
        }];
        config.rpcUrl = rawConfig.rpcUrl || config.rpcUrl;
        config.friendAddresses = rawConfig.friendAddresses || [];
        console.log(chalk.yellow(`${getEmoji('warning')} Migrated old config format`));
      } else {
        config = { ...config, ...rawConfig };
      }
      config.wallets = config.wallets.filter(w => w.address && w.privateKey && w.authToken && ethers.utils.isAddress(w.address));
      if (config.wallets.length === 0) {
        console.log(chalk.yellow(`${getEmoji('warning')} No valid wallets in config`));
      }
    }
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Config load error: ${error.message}`));
  }
}

// Save Config
function saveConfig(): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(chalk.green(`${getEmoji('floppy_disk')} Config saved`));
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Config save error: ${error.message}`));
  }
}

// Initialize Provider
async function initProvider(): Promise<boolean> {
  let attempts = 3;
  while (attempts > 0) {
    try {
      provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
      const network = await provider.getNetwork();
      console.log(chalk.green(`${getEmoji('link')} Connected to ${network.name} (Chain ID: ${network.chainId})`));
      return true;
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} RPC error: ${error.message}`));
      attempts--;
      if (attempts === 0) {
        const { newRpc } = await inquirer.prompt<{ newRpc: string }>([{
          type: 'input',
          name: 'newRpc',
          message: 'Enter valid RPC URL:',
          default: config.rpcUrl,
        }]);
        config.rpcUrl = newRpc;
        saveConfig();
        attempts = 3;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return false;
}

// Setup Wallets
async function setupWallets(): Promise<boolean> {
  wallets = [];
  let allValid = true;
  for (const walletConfig of config.wallets) {
    try {
      const privateKey = walletConfig.privateKey.replace(/^0x/, '');
      const wallet = new ethers.Wallet(privateKey, provider);
      if (wallet.address.toLowerCase() !== walletConfig.address.toLowerCase()) {
        console.error(chalk.red(`${getEmoji('x')} Address mismatch for ${walletConfig.address}`));
        allValid = false;
        continue;
      }
      walletConfig.privateKey = `0x${privateKey}`;
      wallets.push(wallet);
      console.log(chalk.cyan(`${getEmoji('key')} Wallet: ${walletConfig.address}`));
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Wallet setup error for ${walletConfig.address}: ${error.message}`));
      allValid = false;
    }
  }
  if (allValid && wallets.length > 0) {
    saveConfig();
    return true;
  }
  return false;
}

// Prompt Additional Wallets
async function promptForAdditionalWallets(): Promise<void> {
  if (config.wallets.length === 1 && config.wallets[0].privateKey && config.wallets[0].authToken) {
    const answers: { addMore: boolean } = await inquirer.prompt<{
      addMore: boolean;
    }>([
      {
        type: 'confirm',
        name: 'addMore',
        message: 'One wallet detected. Add another?',
        default: false,
      },
    ]);
    if (answers.addMore) {
      let walletNumber: number = 2;
      while (true) {
        const keyPrompt: { privateKey: string } = await inquirer.prompt<{
          privateKey: string;
        }>([
          {
            type: 'input',
            name: 'privateKey',
            message: `Enter wallet ${walletNumber} private key (without 0x, Enter to finish):`,
            validate: (input: string): boolean | string =>
              input === '' || (input.length >= 64 && /^[0-9a-fA-F]+$/.test(input))
                ? true
                : 'Invalid private key',
          },
        ]);
        if (keyPrompt.privateKey === '') break;
        const tokenPrompt: { authToken: string } = await inquirer.prompt<{
          authToken: string;
        }>([
          {
            type: 'input',
            name: 'authToken',
            message: `Enter bearer token for wallet ${walletNumber}:`,
            validate: (input: string): boolean | string => (input ? true : 'Token required'),
          },
        ]);
        try {
          const wallet: ethers.Wallet = new ethers.Wallet(keyPrompt.privateKey, provider);
          config.wallets.push({
            address: wallet.address,
            privateKey: `0x${keyPrompt.privateKey.replace(/^0x/, '')}`,
            authToken: tokenPrompt.authToken,
          });
          console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet ${walletNumber} added: ${wallet.address}`));
          walletNumber++;
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Invalid private key: ${error.message}`));
        }
      }
      saveConfig();
    }
  }
}

// API Request Helper
interface ApiResponse<T = any> {
  data: T;
  msg?: string;
  code?: number;
}

async function makeApiRequest<T>(
  method: string,
  url: string,
  authToken: string,
  data: any = {},
  retries: number = 3
): Promise<ApiResponse<T>> {
  let attempt: number = 0;
  while (attempt < retries) {
    try {
      const response: AxiosResponse<ApiResponse<T>> = await axios({
        method,
        url,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
          origin: 'https://testnet.pharosnetwork.xyz',
          referer: 'https://testnet.pharosnetwork.xyz/',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
        data: method.toUpperCase() === 'POST' ? data : undefined,
      });
      if (!response.data || typeof response.data !== 'object') {
        throw new Error('Invalid API response');
      }
      return response.data;
    } catch (error: any) {
      attempt++;
      const errorMsg: string = error.response?.data?.msg || error.message;
      console.error(
        chalk.yellow(`${getEmoji('warning')} API ${method} ${url} attempt ${attempt}/${retries}: ${errorMsg}`)
      );
      if (attempt >= retries) {
        throw new Error(`API failed after ${retries} attempts: ${errorMsg}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error('API request failed');
}

// API Functions
async function dailySignIn(walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/in?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest<{ msg: string }>('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('calendar')} Sign-In ${walletAddress}: ${response.msg}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Sign-In error ${walletAddress}: ${error.message}`));
    return false;
  }
}

async function checkSignInStatus(walletAddress: string, authToken: string): Promise<string | null> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/sign/status?address=${walletAddress}`;
    const response: ApiResponse<{ status: string }> = await makeApiRequest<{ status: string }>('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('mag')} Sign-In Status ${walletAddress}: ${response.data.status}`));
    return response.data.status;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Sign-In Status error ${walletAddress}: ${error.message}`));
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
    const response: ApiResponse<{ user_info: UserProfile }> = await makeApiRequest<{
      user_info: UserProfile;
    }>('GET', url, authToken);
    console.log(
      chalk.blue(
        `${getEmoji('bust_in_silhouette')} Profile ${walletAddress}: ${response.data.user_info.UserName}, ${
          response.data.user_info.TotalPoints
        } points`
      )
    );
    return response.data.user_info;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Profile error ${walletAddress}: ${error.message}`));
    return null;
  }
}

async function claimDailyFaucet(walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/faucet/daily?address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest<{ msg: string }>('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('moneybag')} Faucet ${walletAddress}: ${response.msg}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Faucet error ${walletAddress}: ${error.message}`));
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
    const response: ApiResponse<FaucetStatus> = await makeApiRequest<FaucetStatus>('GET', url, authToken);
    console.log(chalk.blue(`${getEmoji('hourglass')} Faucet Status ${walletAddress}: ${JSON.stringify(response.data)}`));
    return response.data;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Faucet Status error ${walletAddress}: ${error.message}`));
    return null;
  }
}

async function claimTokenFaucet(tokenAddress: string, walletAddress: string): Promise<string | null> {
  const url: string = 'https://testnet-router.zenithswap.xyz/api/v1/faucet';
  const payload: { tokenAddress: string; userAddress: string } = { tokenAddress, userAddress: walletAddress };
  const tokenName: string =
    TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.name ||
    'Token';
  let attempt: number = 0;
  while (attempt < 3) {
    try {
      const response: AxiosResponse<{
        status: number;
        message: string;
        data: { txHash: string };
      }> = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          accept: '*/*',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
      });
      if (response.data.status === 200 && response.data.data?.txHash) {
        console.log(
          chalk.green(`${getEmoji('coin')} ${tokenName} Faucet ${walletAddress}: ${response.data.data.txHash}`)
        );
        return response.data.data.txHash;
      }
      throw new Error('No transaction hash');
    } catch (error: any) {
      attempt++;
      console.error(
        chalk.red(`${getEmoji('x')} ${tokenName} Faucet error ${walletAddress} (Attempt ${attempt}/3): ${error.message}`)
      );
      if (attempt >= 3) return null;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  return null;
}

// Balance and Approval
interface BalanceInfo {
  raw: BigNumber;
  formatted: string;
  decimals: number;
}

async function checkBalance(tokenAddress: string | null, walletAddress: string): Promise<BalanceInfo> {
  try {
    const wallet: ethers.Wallet | undefined = wallets.find(
      w => w.address.toLowerCase() === walletAddress.toLowerCase()
    );
    if (!wallet) throw new Error('Wallet not found');
    if (!tokenAddress) {
      const balance: BigNumber = await provider!.getBalance(walletAddress);
      const formatted: string = ethers.utils.formatUnits(balance, PHRS_DECIMALS);
      console.log(chalk.blue(`${getEmoji('bar_chart')} PHRS Balance ${walletAddress}: ${formatted}`));
      return { raw: balance, formatted, decimals: PHRS_DECIMALS };
    }
    const tokenContract: ethers.Contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const decimals: number =
      TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.decimals ||
      6;
    const balance: BigNumber = await tokenContract.balanceOf(walletAddress);
    const formatted: string = ethers.utils.formatUnits(balance, decimals);
    const tokenName: string =
      TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!]?.name ||
      'Token';
    console.log(chalk.blue(`${getEmoji('bar_chart')} ${tokenName} Balance ${walletAddress}: ${formatted}`));
    return { raw: balance, formatted, decimals };
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Balance error ${walletAddress}: ${error.message}`));
    return { raw: BigNumber.from(0), formatted: '0', decimals: tokenAddress ? 6 : PHRS_DECIMALS };
  }
}

async function ensurePhrsBalance(walletAddress: string, authToken: string): Promise<boolean> {
  const balanceInfo: BalanceInfo = await checkBalance(null, walletAddress);
  const minimum: BigNumber = ethers.utils.parseUnits(MINIMUM_PHRS_BALANCE, PHRS_DECIMALS);
  if (balanceInfo.raw.gte(minimum)) {
    console.log(chalk.green(`${getEmoji('white_check_mark')} Sufficient PHRS ${walletAddress}: ${balanceInfo.formatted}`));
    return true;
  }
  console.log(
    chalk.yellow(
      `${getEmoji('warning')} Insufficient PHRS ${walletAddress}: ${balanceInfo.formatted}, claiming faucet...`
    )
  );
  if (await claimDailyFaucet(walletAddress, authToken)) {
    const newBalance: BalanceInfo = await checkBalance(null, walletAddress);
    if (newBalance.raw.gte(minimum)) {
      console.log(chalk.green(`${getEmoji('white_check_mark')} PHRS sufficient post-faucet: ${newBalance.formatted}`));
      return true;
    }
  }
  console.error(chalk.red(`${getEmoji('x')} PHRS insufficient ${walletAddress}`));
  return false;
}

async function checkBalanceAndApproval(
  tokenAddress: string,
  amount: number,
  decimals: number,
  spender: string,
  walletAddress: string
): Promise<boolean> {
  try {
    const wallet: ethers.Wallet | undefined = wallets.find(
      w => w.address.toLowerCase() === walletAddress.toLowerCase()
    );
    if (!wallet) throw new Error('Wallet not found');
    const tokenContract: ethers.Contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const balance: BigNumber = await tokenContract.balanceOf(walletAddress);
    const required: BigNumber = ethers.utils.parseUnits(amount.toString(), decimals);
    const tokenName: string =
      TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenAddress.toLowerCase())!].name;
    if (balance.lt(required)) {
      console.error(
        chalk.red(
          `${getEmoji('warning')} Insufficient ${tokenName} ${walletAddress}: ${ethers.utils.formatUnits(
            balance,
            decimals
          )}`
        )
      );
      return false;
    }
    const allowance: BigNumber = await tokenContract.allowance(walletAddress, spender);
    console.log(
      chalk.blue(`${getEmoji('mag')} ${tokenName} allowance ${walletAddress}: ${ethers.utils.formatUnits(allowance, decimals)}`)
    );
    if (allowance.lt(required)) {
      console.log(chalk.blue(`${getEmoji('key')} Approving ${tokenName} for ${spender}...`));
      const gas: BigNumber = await tokenContract.estimateGas.approve(spender, ethers.constants.MaxUint256);
      const feeData: ethers.providers.FeeData = await provider!.getFeeData();
      const tx: ethers.ContractTransaction = await tokenContract.approve(spender, ethers.constants.MaxUint256, {
        gasLimit: Math.ceil(Number(gas) * 1.2),
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
      });
      await tx.wait();
      console.log(chalk.green(`${getEmoji('checkered_flag')} Approval ${tx.hash}`));
    }
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Approval error ${walletAddress}: ${error.message}`));
    return false;
  }
}

// Wrap/Unwrap PHRS
async function wrapPhrs(amount: number, walletAddress: string, authToken: string): Promise<boolean> {
  if (!(await ensurePhrsBalance(walletAddress, authToken))) return false;
  const wallet: ethers.Wallet | undefined = wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet not found: ${walletAddress}`));
    return false;
  }
  try {
    const contract: ethers.Contract = new ethers.Contract(CONTRACTS.WPHRS, WPHRS_ABI, wallet);
    const amountWei: BigNumber = ethers.utils.parseUnits(amount.toString(), PHRS_DECIMALS);
    const balance: BigNumber = await provider!.getBalance(walletAddress);
    if (balance.lt(amountWei)) {
      console.error(
        chalk.red(
          `${getEmoji('warning')} Insufficient PHRS for wrapping: ${ethers.utils.formatUnits(balance, PHRS_DECIMALS)}`
        )
      );
      return false;
    }
    const gas: BigNumber = await contract.estimateGas.deposit({ value: amountWei });
    const feeData: ethers.providers.FeeData = await provider!.getFeeData();
    const tx: ethers.ContractTransaction = await contract.deposit({
      value: amountWei,
      gasLimit: Math.ceil(Number(gas) * 1.2),
      maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
    });
    await tx.wait();
    console.log(chalk.green(`${getEmoji('package')} Wrapped ${amount} PHRS: ${tx.hash}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Wrap error ${walletAddress}: ${error.message}`));
    return false;
  }
}

async function unwrapPhrs(amount: number, walletAddress: string, authToken: string): Promise<boolean> {
  if (!(await ensurePhrsBalance(walletAddress, authToken))) return false;
  const wallet: ethers.Wallet | undefined = wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet not found: ${walletAddress}`));
    return false;
  }
  try {
    const contract: ethers.Contract = new ethers.Contract(CONTRACTS.WPHRS, WPHRS_ABI, wallet);
    const amountWei: BigNumber = ethers.utils.parseUnits(amount.toString(), PHRS_DECIMALS);
    if (!(await checkBalanceAndApproval(CONTRACTS.WPHRS, amount, PHRS_DECIMALS, CONTRACTS.WPHRS, walletAddress)))
      return false;
    const gas: BigNumber = await contract.estimateGas.withdraw(amountWei);
    const feeData: ethers.providers.FeeData = await provider!.getFeeData();
    const tx: ethers.ContractTransaction = await contract.withdraw(amountWei, {
      gasLimit: Math.ceil(Number(gas) * 1.2),
      maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
    });
    await tx.wait();
    console.log(chalk.green(`${getEmoji('package')} Unwrapped ${amount} WPHRS: ${tx.hash}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Unwrap error ${walletAddress}: ${error.message}`));
    return false;
  }
}

// Add Liquidity
async function addLiquidity(
  tokenA: string,
  tokenB: string,
  percentage: number,
  walletAddress: string,
  authToken: string
): Promise<boolean> {
  if (!(await ensurePhrsBalance(walletAddress, authToken))) return false;
  const wallet: ethers.Wallet | undefined = wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet not found: ${walletAddress}`));
    return false;
  }
  try {
    const [token0, token1]: [string, string] =
      tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    const decimals0: number =
      TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === token0.toLowerCase())!].decimals;
    const decimals1: number =
      TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === token1.toLowerCase())!].decimals;
    const balance0: BalanceInfo = await checkBalance(token0, walletAddress);
    const balance1: BalanceInfo = await checkBalance(token1, walletAddress);
    const amount0: BigNumber = ethers.utils.parseUnits(
      (Number(balance0.formatted) * percentage).toFixed(decimals0),
      decimals0
    );
    const amount1: BigNumber = ethers.utils.parseUnits(
      (Number(balance1.formatted) * percentage).toFixed(decimals1),
      decimals1
    );
    if (
      !(await checkBalanceAndApproval(token0, Number(balance0.formatted) * percentage, decimals0, CONTRACTS.POSITION_MANAGER, walletAddress)) ||
      !(await checkBalanceAndApproval(token1, Number(balance1.formatted) * percentage, decimals1, CONTRACTS.POSITION_MANAGER, walletAddress))
    ) {
      console.error(chalk.red(`${getEmoji('x')} Insufficient balance or approval for liquidity`));
      return false;
    }
    const contract: ethers.Contract = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, wallet);
    const fee: number = 500; // Adjust based on pool requirements
    const tickLower: number = -887220; // Wide range, adjust if needed
    const tickUpper: number = 887220;
    const deadline: number = Math.floor(Date.now() / 1000) + 600;
    const gas: BigNumber = await contract.estimateGas.mint(
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      amount0,
      amount1,
      0,
      0,
      walletAddress,
      deadline
    );
    const feeData: ethers.providers.FeeData = await provider!.getFeeData();
    const tx: ethers.ContractTransaction = await contract.mint(
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      amount0,
      amount1,
      0,
      0,
      walletAddress,
      deadline,
      {
        gasLimit: Math.ceil(Number(gas) * 1.2),
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
      }
    );
    await tx.wait();
    console.log(chalk.green(`${getEmoji('chart')} Added liquidity: ${tx.hash}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Liquidity error ${walletAddress}: ${error.message}`));
    return false;
  }
}

// Swap Tokens
async function swapTokens(
  tokenIn: string,
  tokenOut: string,
  amount: number,
  times: number,
  walletAddress: string,
  authToken: string
): Promise<number> {
  if (!(await ensurePhrsBalance(walletAddress, authToken))) return 0;
  const wallet: ethers.Wallet | undefined = wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet not found: ${walletAddress}`));
    return 0;
  }
  const decimals: number =
    TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenIn.toLowerCase())!].decimals;
  const tokenNameIn: string =
    TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenIn.toLowerCase())!].name;
  const tokenNameOut: string =
    TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenOut.toLowerCase())!].name;
  const router: ethers.Contract = new ethers.Contract(CONTRACTS.ROUTER, ROUTER_ABI, wallet);
  let successCount: number = 0;

  for (let i: number = 0; i < times; i++) {
    let attempt: number = 0;
    while (attempt < 3) {
      try {
        console.log(
          chalk.cyan(
            `${getEmoji('arrows_counterclockwise')} Swap ${i + 1}/${times} ${walletAddress}: ${tokenNameIn} -> ${tokenNameOut} (${amount}) (Attempt ${attempt + 1}/3)`
          )
        );
        if (!(await checkBalanceAndApproval(tokenIn, amount, decimals, CONTRACTS.ROUTER, walletAddress))) {
          console.error(chalk.red(`${getEmoji('x')} Insufficient balance or approval`));
          break;
        }
        const amountIn: BigNumber = ethers.utils.parseUnits(amount.toString(), decimals);
        const deadline: number = Math.floor(Date.now() / 1000) + 600;
        const fees: number[] = [500, 3000, 10000];
        let tx: ethers.ContractTransaction | undefined;
        for (const fee of fees) {
          try {
            const params: {
              tokenIn: string;
              tokenOut: string;
              fee: number;
              recipient: string;
              deadline: number;
              amountIn: BigNumber;
              amountOutMinimum: number;
              sqrtPriceLimitX96: number;
            } = {
              tokenIn,
              tokenOut,
              fee,
              recipient: walletAddress,
              deadline,
              amountIn,
              amountOutMinimum: 0,
              sqrtPriceLimitX96: 0,
            };
            await router.callStatic.exactInputSingle(params, { from: walletAddress });
            const gas: BigNumber = await router.estimateGas.exactInputSingle(params);
            const feeData: ethers.providers.FeeData = await provider!.getFeeData();
            tx = await router.exactInputSingle(params, {
              gasLimit: Math.ceil(Number(gas) * 1.5),
              maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
            });
            console.log(chalk.blue(`${getEmoji('mag')} Swap using fee tier ${fee}`));
            break;
          } catch (error: any) {
            console.warn(chalk.yellow(`${getEmoji('warning')} Simulation failed for fee ${fee}: ${error.message}`));
            if (fee === fees[fees.length - 1]) throw new Error('All fee tiers failed');
          }
        }
        if (!tx) throw new Error('No valid fee tier');
        const receipt: ethers.ContractReceipt = await tx.wait();
        console.log(chalk.green(`${getEmoji('rocket')} Swap ${i + 1}: ${receipt.transactionHash}`));
        successCount++;
        if (i < times - 1) {
          const delay: number = Math.random() * 2000 + 1000;
          console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delay / 1000} seconds...`));
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        break;
      } catch (error: any) {
        attempt++;
        console.error(chalk.red(`${getEmoji('x')} Swap ${i + 1} error (Attempt ${attempt}/3): ${error.message}`));
        if (attempt >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  console.log(chalk.green(`${getEmoji('chart')} Swap Summary ${walletAddress}: ${successCount}/${times}`));
  return successCount;
}

// Send PHRS
async function sendToFriends(
  amount: number,
  times: number,
  friends: string[],
  walletAddress: string,
  authToken: string
): Promise<number> {
  if (!(await ensurePhrsBalance(walletAddress, authToken))) return 0;
  const wallet: ethers.Wallet | undefined = wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  if (!wallet) {
    console.error(chalk.red(`${getEmoji('x')} Wallet not found: ${walletAddress}`));
    return 0;
  }
  const amountWei: BigNumber = ethers.utils.parseUnits(amount.toString(), PHRS_DECIMALS);
  let successCount: number = 0;
  const recipients: string[] = friends.length
    ? friends
    : config.wallets.map(w => w.address).filter(a => a.toLowerCase() !== walletAddress.toLowerCase());
  if (!recipients.length) {
    console.error(chalk.red(`${getEmoji('warning')} No recipients available`));
    return 0;
  }

  for (let i: number = 0; i < times; i++) {
    const recipient: string = recipients[i % recipients.length];
    try {
      console.log(chalk.cyan(`${getEmoji('gift')} Sending ${amount} PHRS to ${recipient} (${i + 1}/${times})`));
      if (!ethers.utils.isAddress(recipient)) {
        console.error(chalk.red(`${getEmoji('x')} Invalid recipient address: ${recipient}`));
        continue;
      }
      const balance: BigNumber = await provider!.getBalance(walletAddress);
      if (balance.lt(amountWei)) {
        console.error(
          chalk.red(`${getEmoji('warning')} Insufficient PHRS: ${ethers.utils.formatUnits(balance, PHRS_DECIMALS)}`)
        );
        continue;
      }
      const feeData: ethers.providers.FeeData = await provider!.getFeeData();
      const tx: ethers.ContractTransaction = await wallet.sendTransaction({
        to: recipient,
        value: amountWei,
        gasLimit: 21000,
        maxFeePerGas: feeData.maxFeePerGas || ethers.utils.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('1', 'gwei'),
      });
      await tx.wait();
      console.log(chalk.green(`${getEmoji('tada')} Send: ${tx.hash}`));
      successCount++;
      if (i < times - 1) {
        const delay: number = Math.random() * 3000 + 2000;
        console.log(chalk.blue(`${getEmoji('hourglass')} Waiting ${delay / 1000} seconds...`));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      console.error(chalk.red(`${getEmoji('x')} Send error to ${recipient}: ${error.message}`));
    }
  }
  console.log(chalk.green(`${getEmoji('gift')} Send Summary ${walletAddress}: ${successCount}/${times}`));
  return successCount;
}

// Task Verification
async function verifyTask(taskId: string, walletAddress: string, authToken: string): Promise<boolean> {
  try {
    const url: string = `https://api.pharosnetwork.xyz/task/verify?taskId=${taskId}&address=${walletAddress}`;
    const response: ApiResponse<{ msg: string }> = await makeApiRequest<{ msg: string }>('POST', url, authToken);
    console.log(chalk.green(`${getEmoji('white_check_mark')} Task ${taskId} verified ${walletAddress}: ${response.msg}`));
    return true;
  } catch (error: any) {
    console.error(chalk.red(`${getEmoji('x')} Task verification error ${walletAddress}: ${error.message}`));
    return false;
  }
}

// Daily Tasks
async function runDailyTasks(
  featureNumber: number,
  params: SwapParams,
  wallet: WalletConfig
): Promise<FaucetStatus | null> {
  console.log(chalk.blue(`${getEmoji('rocket')} Daily tasks for Feature ${featureNumber} (${wallet.address})`));

  // Faucet Claims
  await claimDailyFaucet(wallet.address, wallet.authToken);
  const faucetStatus: FaucetStatus | null = await checkFaucetStatus(wallet.address, wallet.authToken);
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4) {
    await claimTokenFaucet(TOKENS.USDC.address, wallet.address);
    await claimTokenFaucet(TOKENS.USDT.address, wallet.address);
  }

  // Sign-In and Profile
  await dailySignIn(wallet.address, wallet.authToken);
  await checkSignInStatus(wallet.address, wallet.authToken);
  await getUserProfile(wallet.address, wallet.authToken);

  // Feature-Specific Tasks
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4) {
    if (params.tokenIn && params.tokenOut && params.swapAmount && params.swapTimes) {
      await swapTokens(
        params.tokenIn,
        params.tokenOut,
        params.swapAmount,
        params.swapTimes,
        wallet.address,
        wallet.authToken
      );
      await verifyTask('swap_task', wallet.address, wallet.authToken); // Example task ID
    }
    if ((featureNumber === 1 || featureNumber === 4) && params.liquidityPercentage) {
      await addLiquidity(
        TOKENS.USDC.address,
        TOKENS.USDT.address,
        params.liquidityPercentage,
        wallet.address,
        wallet.authToken
      );
      await verifyTask('liquidity_task', wallet.address, wallet.authToken); // Example task ID
    }
    await wrapPhrs(0.1, wallet.address, wallet.authToken); // Fixed amount for consistency
    await verifyTask('wrap_task', wallet.address, wallet.authToken); // Example task ID
    await unwrapPhrs(0.1, wallet.address, wallet.authToken);
    await verifyTask('unwrap_task', wallet.address, wallet.authToken); // Example task ID
  }
  if (featureNumber === 1 || featureNumber === 4) {
    if (params.sendAmount && params.sendTimes && params.friends) {
      await sendToFriends(params.sendAmount, params.sendTimes, params.friends, wallet.address, wallet.authToken);
      await verifyTask('send_task', wallet.address, wallet.authToken); // Example task ID
    }
  }

  console.log(chalk.green(`${getEmoji('tada')} Tasks completed for ${wallet.address}`));
  return faucetStatus;
}

// Schedule Tasks
async function scheduleAndLogTasks(featureNumber: number, params: SwapParams): Promise<void> {
  console.log(chalk.blue(`${getEmoji('calendar')} Starting tasks for Feature ${featureNumber}`));
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
      console.log(chalk.blue(`${getEmoji('clock3')} Next run: ${new Date(nextRunTime * 1000).toUTCString()}`));
      await new Promise(resolve => setTimeout(resolve, (nextRunTime - currentTime) * 1000));
    }
    console.log(chalk.blue(`${getEmoji('calendar')} Running scheduled tasks for Feature ${featureNumber}`));
    nextRunTime = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    for (const wallet of config.wallets) {
      const faucetStatus: FaucetStatus | null = await runDailyTasks(featureNumber, params, wallet);
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

  const answers: { action: string } = await inquirer.prompt<{
    action: string;
  }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select option:',
      choices: ['Manage Wallets', 'Update RPC URL', 'Manage Friends', 'Back to Main Menu'],
    },
  ]);

  switch (answers.action) {
    case 'Manage Wallets':
      await manageWalletsMenu();
      break;
    case 'Update RPC URL':
      const rpcPrompt: { rpcUrl: string } = await inquirer.prompt<{
        rpcUrl: string;
      }>([
        {
          type: 'input',
          name: 'rpcUrl',
          message: `${getEmoji('link')} Enter RPC URL:`,
          default: config.rpcUrl,
        },
      ]);
      config.rpcUrl = rpcPrompt.rpcUrl;
      saveConfig();
      await initProvider();
      break;
    case 'Manage Friends':
      await manageFriendsMenu();
      break;
  }

  if (answers.action !== 'Back to Main Menu') await configMenu();
}

// Manage Wallets Menu
async function manageWalletsMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('key')} ==============================================`));
  console.log(chalk.cyan(`${getEmoji('key')} Main Wallets Management`));
  console.log(chalk.cyan(`${getEmoji('key')} ==============================================`));

  if (config.wallets.length) {
    console.log(chalk.blue(`Current wallets (${config.wallets.length}):`));
    config.wallets.forEach((wallet, i) => {
      console.log(
        chalk.blue(
          `${i + 1}. ${wallet.address} (Bearer: ${wallet.authToken.slice(0, 10)}...${wallet.authToken.slice(-10)})`
        )
      );
    });
  } else {
    console.log(chalk.yellow(`${getEmoji('warning')} No wallets configured`));
  }

  const answers: { action: string } = await inquirer.prompt<{
    action: string;
  }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select option:',
      choices: ['Add Wallet', 'Remove Wallet', 'Clear All Wallets', 'Back to Config Menu'],
    },
  ]);

  switch (answers.action) {
    case 'Add Wallet':
      let walletNumber: number = config.wallets.length + 1;
      while (true) {
        const keyPrompt: { privateKey: string } = await inquirer.prompt<{
          privateKey: string;
        }>([
          {
            type: 'input',
            name: 'privateKey',
            message: `Enter wallet ${walletNumber} private key (without 0x, Enter to finish):`,
            validate: (input: string): boolean | string =>
              input === '' || (input.length >= 64 && /^[0-9a-fA-F]+$/.test(input))
                ? true
                : 'Invalid private key',
          },
        ]);
        if (keyPrompt.privateKey === '') break;
        const tokenPrompt: { authToken: string } = await inquirer.prompt<{
          authToken: string;
        }>([
          {
            type: 'input',
            name: 'authToken',
            message: `Enter bearer token for wallet ${walletNumber}:`,
            validate: (input: string): boolean | string => (input ? true : 'Token required'),
          },
        ]);
        try {
          const wallet: ethers.Wallet = new ethers.Wallet(keyPrompt.privateKey, provider);
          config.wallets.push({
            address: wallet.address,
            privateKey: `0x${keyPrompt.privateKey.replace(/^0x/, '')}`,
            authToken: tokenPrompt.authToken,
          });
          console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet ${walletNumber} added: ${wallet.address}`));
          walletNumber++;
        } catch (error: any) {
          console.error(chalk.red(`${getEmoji('x')} Invalid private key: ${error.message}`));
        }
      }
      saveConfig();
      await setupWallets();
      break;
    case 'Remove Wallet':
      if (!config.wallets.length) {
        console.log(chalk.yellow(`${getEmoji('warning')} No wallets to remove`));
        break;
      }
      const removePrompt: { indexToRemove: number } = await inquirer.prompt<{
        indexToRemove: number;
      }>([
        {
          type: 'list',
          name: 'indexToRemove',
          message: 'Select wallet to remove:',
          choices: config.wallets.map((w, i) => ({ name: `${i + 1}. ${w.address}`, value: i })),
        },
      ]);
      config.wallets.splice(removePrompt.indexToRemove, 1);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Wallet removed`));
      await setupWallets();
      break;
    case 'Clear All Wallets':
      const clearPrompt: { confirm: boolean } = await inquirer.prompt<{
        confirm: boolean;
      }>([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Remove all wallets?',
          default: false,
        },
      ]);
      if (clearPrompt.confirm) {
        config.wallets = [];
        saveConfig();
        console.log(chalk.green(`${getEmoji('white_check_mark')} All wallets removed`));
        await setupWallets();
      }
      break;
  }

  if (answers.action !== 'Back to Config Menu') await manageWalletsMenu();
}

// Manage Friends Menu
async function manageFriendsMenu(): Promise<void> {
  console.clear();
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ==============================================`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} Friend Addresses Management`));
  console.log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ==============================================`));

  if (config.friendAddresses.length) {
    console.log(chalk.blue(`Current friends (${config.friendAddresses.length}):`));
    config.friendAddresses.forEach((addr, i) => console.log(chalk.blue(`${i + 1}. ${addr}`)));
  } else {
    console.log(chalk.yellow(`${getEmoji('warning')} No friends configured`));
  }

  const answers: { action: string } = await inquirer.prompt<{
    action: string;
  }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select option:',
      choices: ['Add Friend', 'Remove Friend', 'Clear All Friends', 'Import Multiple', 'Back to Config Menu'],
    },
  ]);

  switch (answers.action) {
    case 'Add Friend':
      const addPrompt: { address: string } = await inquirer.prompt<{
        address: string;
      }>([
        {
          type: 'input',
          name: 'address',
          message: `${getEmoji('bust_in_silhouette')} Enter friend address:`,
          validate: (input: string): boolean | string =>
            ethers.utils.isAddress(input) ? true : 'Invalid address',
        },
      ]);
      config.friendAddresses.push(addPrompt.address);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friend added`));
      break;
    case 'Remove Friend':
      if (!config.friendAddresses.length) {
        console.log(chalk.yellow(`${getEmoji('warning')} No friends to remove`));
        break;
      }
      const removePrompt: { indexToRemove: number } = await inquirer.prompt<{
        indexToRemove: number;
      }>([
        {
          type: 'list',
          name: 'indexToRemove',
          message: 'Select friend to remove:',
          choices: config.friendAddresses.map((addr, i) => ({ name: `${i + 1}. ${addr}`, value: i })),
        },
      ]);
      config.friendAddresses.splice(removePrompt.indexToRemove, 1);
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friend removed`));
      break;
    case 'Clear All Friends':
      const clearPrompt: { confirm: boolean } = await inquirer.prompt<{
        confirm: boolean;
      }>([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Remove all friends?',
          default: false,
        },
      ]);
      if (clearPrompt.confirm) {
        config.friendAddresses = [];
        saveConfig();
        console.log(chalk.green(`${getEmoji('white_check_mark')} All friends removed`));
      }
      break;
    case 'Import Multiple':
      const importPrompt: { addresses: string } = await inquirer.prompt<{
        addresses: string;
      }>([
        {
          type: 'input',
          name: 'addresses',
          message: `${getEmoji('page_with_curl')} Enter comma-separated addresses:`,
          validate: (input: string): boolean | string =>
            input
              .split(',')
              .map(a => a.trim())
              .every(addr => ethers.utils.isAddress(addr))
              ? true
              : 'Invalid address',
        },
      ]);
      config.friendAddresses = [
        ...new Set([...config.friendAddresses, ...importPrompt.addresses.split(',').map(a => a.trim())]),
      ];
      saveConfig();
      console.log(chalk.green(`${getEmoji('white_check_mark')} Friends imported successfully`));
      break;
  }

  if (answers.action !== 'Back to Config Menu') await manageFriendsMenu();
}

// Main Menu
async function mainMenu(): Promise<void> {
  console.clear();
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));
  console.log(chalk.green(` * ${getEmoji('robot')} Pharos Automated Bot ${getEmoji('sparkles')} *`));
  console.log(chalk.green(` * ${getEmoji('one')} [1] Swap, Check In, Send PHRS, Liquidity, Wrap *`));
  console.log(chalk.green(` * ${getEmoji('two')} [2] Swap, Tokens Check In & Wrap (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('three')} [3] Check In Only (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('four')} [4] All Features (All Wallets) *`));
  console.log(chalk.green(` * ${getEmoji('wrench')} [5] Configuration *`));
  console.log(chalk.green(` * ${getEmoji('x')} [6] Exit *`));
  console.log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));

  const answers: { feature: string } = await inquirer.prompt<{
    feature: string;
  }>([
    {
      type: 'list',
      name: 'feature',
      message: 'Select feature:',
      choices: [
        '1 - Swap, Check In, Send PHRS, Liquidity, Wrap',
        '2 - Swap, Tokens Check In & Wrap',
        '3 - Check In Only (All Wallets)',
        '4 - All Features (All Wallets)',
        '5 - Config',
        '6 - Exit',
      ],
    },
  ]);

  const featureNumber: number = parseInt(answers.feature);

  if (featureNumber === 5) {
    await configMenu();
    return await mainMenu();
  }
  if (featureNumber === 6) {
    console.log(chalk.yellow(`${getEmoji('wave')} Exiting...`));
    process.exit(0);
  }

  let params: SwapParams = {};
  if (featureNumber === 1 || featureNumber === 2 || featureNumber === 4) {
    const swapPrompt: {
      swapDirection: 'USDC_TO_USDT' | 'USDT_TO_USDC';
      swapAmount: string;
      swapTimes: number;
      liquidityPercentage: string;
    } = await inquirer.prompt<{
      swapDirection: 'USDC_TO_USDT' | 'USDT_TO_USDC';
      swapAmount: string;
      swapTimes: number;
      liquidityPercentage: string;
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
        type: 'input',
        name: 'swapAmount',
        message: 'Enter swap amount:',
        default: '0.1',
        validate: (input: string): boolean | string => {
          const num = parseFloat(input);
          return num > 0 && !isNaN(num) ? true : 'Amount must be a positive number';
        },
      },
      {
        type: 'number',
        name: 'swapTimes',
        message: 'Enter number of swaps:',
        default: 1,
        validate: (input: number): boolean | string => (input >= 1 ? true : 'At least 1 swap'),
      },
      {
        type: 'input',
        name: 'liquidityPercentage',
        message: 'Enter liquidity percentage (0-1):',
        default: '0.5',
        validate: (input: string): boolean | string => {
          const num = parseFloat(input);
          return num > 0 && num <= 1 && !isNaN(num) ? true : 'Must be between 0 and 1';
        },
        when: () => featureNumber === 1 || featureNumber === 4,
      },
    ]);
    params.tokenIn = swapPrompt.swapDirection === 'USDC_TO_USDT' ? TOKENS.USDC.address : TOKENS.USDT.address;
    params.tokenOut = swapPrompt.swapDirection === 'USDC_TO_USDT' ? TOKENS.USDT.address : TOKENS.USDC.address;
    params.swapAmount = parseFloat(swapPrompt.swapAmount);
    params.swapTimes = swapPrompt.swapTimes;
    params.liquidityPercentage = parseFloat(swapPrompt.liquidityPercentage || '0');
  }

  if (featureNumber === 1 || featureNumber === 4) {
    const sendPrompt: {
      sendAmount: number;
      sendTimes: number;
      useFriends: boolean;
    } = await inquirer.prompt<{
      sendAmount: number;
      sendTimes: number;
      useFriends: boolean;
    }>([
      {
        type: 'list',
        name: 'sendAmount',
        message: 'Select PHRS to send:',
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
        message: 'Enter number of sends:',
        default: 10,
        validate: (input: number): boolean | string => (input >= 1 ? true : 'At least 1 send'),
      },
      {
        type: 'confirm',
        name: 'useFriends',
        message: 'Send to friends instead of wallets?',
        default: config.friendAddresses.length > 0,
      },
    ]);
    params.sendAmount = sendPrompt.sendAmount;
    params.sendTimes = sendPrompt.sendTimes;
    params.friends = sendPrompt.useFriends ? config.friendAddresses : [];
  }

  await scheduleAndLogTasks(featureNumber, params);
}

// Start
async function start(): Promise<void> {
  console.log(chalk.cyan(`${getEmoji('rocket')} Initializing Pharos Bot...`));
  loadConfig();
  if (!(await initProvider())) {
    console.error(chalk.red(`${getEmoji('x')} Provider initialization failed`));
    process.exit(1);
  }
  await promptForAdditionalWallets();
  if (!(await setupWallets())) {
    console.log(chalk.yellow(`${getEmoji('warning')} Configure at least one wallet`));
    await configMenu();
    if (!(await setupWallets())) {
      console.error(chalk.red(`${getEmoji('x')} Wallet setup failed`));
      process.exit(1);
    }
  }
  await mainMenu();
}

start().catch(error => {
  console.error(chalk.red(`${getEmoji('x')} Fatal error: ${error.message}`));
  process.exit(1);
});
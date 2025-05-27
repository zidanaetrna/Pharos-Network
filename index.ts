import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';
import inquirer from 'inquirer';
import { get as getEmoji } from 'node-emoji';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { format } from 'date-fns';
import { id } from 'date-fns/locale';

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
  liquidityCount?: number;
  mintFaucet?: boolean;
  wrapOption?: number;
  wrapAmount?: number;
}

// Configuration file handling
const CONFIG_PATH: string = path.join(__dirname, 'config.json');

let config: Config = {
  wallets: [],
  rpcUrl: process.env.RPC_URL || 'https://testnet.dplabs-internal.com',
  friendAddresses: process.env.FRIEND_ADDRESSES ? process.env.FRIEND_ADDRESSES.split(',') : [],
};

// Load config
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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

// Contract addresses (from Python code)
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

const CONTRACTS = {
  FAUCET_ROUTER: '0x11de0e754f1df7c7b0d559721b334809a9c0dfb7',
  SWAP_ROUTER: '0x1A4DE519154Ae51200b0Ad7c90F7faC75547888a',
  POSITION_MANAGER: '0xF8a1D4FF0f9b9Af7CE58E1fc1833688F3BFd6115',
};

const BASE_API = 'https://api.pharosnetwork.xyz';
const REF_CODE = 'NygTwB7HsTJ50B3H';
const PHRS_DECIMALS: number = 18;

// Initialize ethers
let provider: ethers.providers.JsonRpcProvider | undefined;
let wallets: ethers.Wallet[] = [];

// ABIs (from Python code)
const ERC20_ABI: string[] = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function deposit() payable',
  'function withdraw(uint256 wad)',
];

const FAUCET_ABI: string[] = [
  'function mint(address _asset, address _account, uint256 _amount) nonpayable',
];

const SWAP_ABI: string[] = [
  'function multicall(uint256 deadline, bytes[] data) nonpayable',
];

const POSITION_MANAGER_ABI: string[] = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

// Logging helper
function log(message: string): void {
  const timestamp = format(new Date(), 'MM/dd/yyyy HH:mm:ss', { locale: id });
  console.log(
    `${chalk.cyan(`[${timestamp} WIB]`)}${chalk.white(' | ')}${message}`
  );
}

// Define interface for login response
interface LoginResponse {
  jwt: string;
}

// Define interface for Run All Features prompt answers
interface RunAllFeaturesAnswers {
  mintFaucet: boolean;
  sendTimes: number;
  sendAmount: number;
  wrapOption: number;
  wrapAmount?: number;
  liquidityCount: number;
  swapDirection: 'USDC_TO_USDT' | 'USDT_TO_USDC';
  swapAmount: number;
  swapTimes: number;
}



// API request helper (updated for better type safety)
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
  retries: number = 5
): Promise<ApiResponse<T> | null> {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    Origin: 'https://testnet.pharosnetwork.xyz',
    Referer: 'https://testnet.pharosnetwork.xyz/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await axios({
        method,
        url,
        headers,
        data: method === 'POST' ? data : undefined,
        timeout: 120000,
      });
      return response.data as ApiResponse<T>;
    } catch (error: any) {
      const statusCode = error.response?.status;
      const errorMsg = error.response?.data?.msg || error.message;
      log(
        `${chalk.yellow(`Attempt ${attempt + 1}/${retries} - ${method} ${url}: ${statusCode || ''} ${errorMsg}`)}`
      );
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  return null;
}

// Initialize provider
async function initProvider(): Promise<boolean> {
  log(chalk.blue(`Attempting to connect to RPC: ${config.rpcUrl}`));
  let attempts = 3;
  while (attempts > 0) {
    try {
      provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
      const network = await provider.getNetwork();
      log(chalk.green(`${getEmoji('link')} Connected to network: ${network.name} (Chain ID: ${network.chainId})`));
      return true;
    } catch (error: any) {
      log(chalk.red(`${getEmoji('x')} RPC Connection Error: ${error.message}`));
      attempts--;
      if (attempts === 0) {
        log(chalk.yellow(`${getEmoji('warning')} Max retry attempts reached.`));
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
      log(chalk.red(`${getEmoji('x')} Invalid configuration for wallet: ${walletConfig.address}`));
      allValid = false;
      continue;
    }

    try {
      const privateKey = walletConfig.privateKey.replace(/^0x/, '0x');
      const wallet = new ethers.Wallet(privateKey, provider);
      if (wallet.address.toLowerCase() !== walletConfig.address.toLowerCase()) {
        log(chalk.red(`${getEmoji('x')} Address mismatch for wallet: ${walletConfig.address}`));
        allValid = false;
        continue;
      }
      wallets.push(wallet);
      log(chalk.cyan(`${getEmoji('key')} Wallet Address: ${walletConfig.address}`));
    } catch (error: any) {
      log(chalk.red(`${getEmoji('x')} Wallet Setup Error for ${walletConfig.address}: ${error.message}`));
      allValid = false;
    }
  }

  if (allValid && config.wallets.length > 0) {
    saveConfig();
    return true;
  }
  return false;
}

// On-chain functions
async function getTokenBalance(wallet: ethers.Wallet, contractAddress: string): Promise<number | null> {
  try {
    if (contractAddress === 'PHRS') {
      const balance = await wallet.getBalance();
      return parseFloat(ethers.utils.formatUnits(balance, PHRS_DECIMALS));
    }
    const contract = new ethers.Contract(contractAddress, ERC20_ABI, wallet);
    const balance = await contract.balanceOf(wallet.address);
    const decimals = await contract.decimals();
    return parseFloat(ethers.utils.formatUnits(balance, decimals));
  } catch (error: any) {
    log(chalk.red(`Balance Check Error: ${error.message}`));
    return null;
  }
}

async function approveToken(wallet: ethers.Wallet, spender: string, contractAddress: string, amount: ethers.BigNumber): Promise<boolean> {
  try {
    const contract = new ethers.Contract(contractAddress, ERC20_ABI, wallet);
    const allowance = await contract.allowance(wallet.address, spender);
    if (allowance.gte(amount)) {
      return true;
    }

    const tx = await contract.approve(spender, ethers.constants.MaxUint256, {
      gasLimit: 100000,
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    await tx.wait();
    log(chalk.green(`Approved ${contractAddress} for ${spender}`));
    return true;
  } catch (error: any) {
    log(chalk.red(`Approve Error: ${error.message}`));
    return false;
  }
}

async function mintFaucet(wallet: ethers.Wallet, assetAddress: string, tokenName: string): Promise<boolean> {
  try {
    const contract = new ethers.Contract(CONTRACTS.FAUCET_ROUTER, FAUCET_ABI, wallet);
    const amount = ethers.utils.parseUnits('1000', 6); // 1000 USDC/USDT
    const gasLimit = await contract.estimateGas.mint(assetAddress, wallet.address, amount);
    const tx = await contract.mint(assetAddress, wallet.address, amount, {
      gasLimit: gasLimit.mul(12).div(10),
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    log(
      chalk.green(
        `${getEmoji('white_check_mark')} Mint 1000 ${tokenName} Faucet Success - Tx: https://testnet.pharosscan.xyz/tx/${tx.hash}`
      )
    );
    return true;
  } catch (error: any) {
    log(chalk.red(`Mint ${tokenName} Faucet Error: ${error.message}`));
    return false;
  }
}

async function performTransfer(wallet: ethers.Wallet, authToken: string, receiver: string, amount: number): Promise<boolean> {
  try {
    const balance = await getTokenBalance(wallet, 'PHRS');
    if (!balance || balance < amount) {
      log(chalk.yellow(`Insufficient PHRS balance: ${balance || 0}`));
      return false;
    }

    const tx = await wallet.sendTransaction({
      to: receiver,
      value: ethers.utils.parseEther(amount.toString()),
      gasLimit: 21000,
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    log(
      chalk.green(
        `${getEmoji('white_check_mark')} Transfer ${amount} PHRS Success - Tx: https://testnet.pharosscan.xyz/tx/${tx.hash}`
      )
    );

    const verify = await makeApiRequest('POST', `${BASE_API}/task/verify?address=${wallet.address}&task_id=103&tx_hash=${tx.hash}`, authToken);
    if (verify && verify.code === 0) {
      log(chalk.green(`Transfer Verification Success`));
    } else {
      log(chalk.red(`Transfer Verification Failed`));
    }
    return true;
  } catch (error: any) {
    log(chalk.red(`Transfer Error: ${error.message}`));
    return false;
  }
}

async function performWrapped(wallet: ethers.Wallet, amount: number): Promise<boolean> {
  try {
    const balance = await getTokenBalance(wallet, 'PHRS');
    if (!balance || balance < amount) {
      log(chalk.yellow(`Insufficient PHRS balance: ${balance || 0}`));
      return false;
    }

    const contract = new ethers.Contract(TOKENS.WPHRS.address, ERC20_ABI, wallet);
    const gasLimit = await contract.estimateGas.deposit({ value: ethers.utils.parseEther(amount.toString()) });
    const tx = await contract.deposit({
      value: ethers.utils.parseEther(amount.toString()),
      gasLimit: gasLimit.mul(12).div(10),
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    log(
      chalk.green(
        `${getEmoji('white_check_mark')} Wrapped ${amount} PHRS to WPHRS Success - Tx: https://testnet.pharosscan.xyz/tx/${tx.hash}`
      )
    );
    return true;
  } catch (error: any) {
    log(chalk.red(`Wrap Error: ${error.message}`));
    return false;
  }
}

async function performUnwrapped(wallet: ethers.Wallet, amount: number): Promise<boolean> {
  try {
    const balance = await getTokenBalance(wallet, TOKENS.WPHRS.address);
    if (!balance || balance < amount) {
      log(chalk.yellow(`Insufficient WPHRS balance: ${balance || 0}`));
      return false;
    }

    const contract = new ethers.Contract(TOKENS.WPHRS.address, ERC20_ABI, wallet);
    const amountWei = ethers.utils.parseEther(amount.toString());
    const gasLimit = await contract.estimateGas.withdraw(amountWei);
    const tx = await contract.withdraw(amountWei, {
      gasLimit: gasLimit.mul(12).div(10),
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    log(
      chalk.green(
        `${getEmoji('white_check_mark')} Unwrapped ${amount} WPHRS to PHRS Success - Tx: https://testnet.pharosscan.xyz/tx/${tx.hash}`
      )
    );
    return true;
  } catch (error: any) {
    log(chalk.red(`Unwrap Error: ${error.message}`));
    return false;
  }
}

async function performSwap(wallet: ethers.Wallet, fromToken: string, toToken: string, amount: number): Promise<boolean> {
  try {
    const fromContract = TOKENS[fromToken].address;
    const decimals = TOKENS[fromToken].decimals;
    const balance = await getTokenBalance(wallet, fromContract);
    if (!balance || balance < amount) {
      log(chalk.yellow(`Insufficient ${fromToken} balance: ${balance || 0}`));
      return false;
    }

    const amountWei = ethers.utils.parseUnits(amount.toString(), decimals);
    if (!(await approveToken(wallet, CONTRACTS.SWAP_ROUTER, fromContract, amountWei))) {
      return false;
    }

    const contract = new ethers.Contract(CONTRACTS.SWAP_ROUTER, SWAP_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const encodedData = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint24', 'address', 'uint256', 'uint256', 'uint256'],
      [fromContract, TOKENS[toToken].address, 500, wallet.address, amountWei, 0, 0]
    );
    const multicallData = [ethers.utils.concat(['0x04e45aaf', encodedData])];
    const gasLimit = await contract.estimateGas.multicall(deadline, multicallData);
    const tx = await contract.multicall(deadline, multicallData, {
      gasLimit: gasLimit.mul(12).div(10),
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    log(
      chalk.green(
        `${getEmoji('white_check_mark')} Swap ${amount} ${fromToken} to ${toToken} Success - Tx: https://testnet.pharosscan.xyz/tx/${tx.hash}`
      )
    );
    return true;
  } catch (error: any) {
    log(chalk.red(`Swap Error: ${error.message}`));
    return false;
  }
}

async function addLiquidity(wallet: ethers.Wallet, amount1: number, amount2: number): Promise<boolean> {
  try {
    const token1 = TOKENS.WPHRS;
    const token2 = TOKENS.USDC;
    const balance1 = await getTokenBalance(wallet, token1.address);
    const balance2 = await getTokenBalance(wallet, token2.address);
    if (!balance1 || balance1 < amount1) {
      log(chalk.yellow(`Insufficient ${token1.name} balance: ${balance1 || 0}`));
      return false;
    }
    if (!balance2 || balance2 < amount2) {
      log(chalk.yellow(`Insufficient ${token2.name} balance: ${balance2 || 0}`));
      return false;
    }

    if (!(await approveToken(wallet, CONTRACTS.POSITION_MANAGER, token1.address, ethers.utils.parseUnits(amount1.toString(), token1.decimals)))) {
      return false;
    }
    if (!(await approveToken(wallet, CONTRACTS.POSITION_MANAGER, token2.address, ethers.utils.parseUnits(amount2.toString(), token2.decimals)))) {
      return false;
    }

    const contract = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, wallet);
    const params = {
      token0: token1.address,
      token1: token2.address,
      fee: 500,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: ethers.utils.parseUnits(amount1.toString(), token1.decimals),
      amount1Desired: ethers.utils.parseUnits(amount2.toString(), token2.decimals),
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
    };
    const gasLimit = await contract.estimateGas.mint(params);
    const tx = await contract.mint(params, {
      gasLimit: gasLimit.mul(12).div(10),
      maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
      maxFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    log(
      chalk.green(
        `${getEmoji('white_check_mark')} Add LP ${amount1} ${token1.name}/${amount2} ${token2.name} Success - Tx: https://testnet.pharosscan.xyz/tx/${tx.hash}`
      )
    );
    return true;
  } catch (error: any) {
    log(chalk.red(`Add Liquidity Error: ${error.message}`));
    return false;
  }
}

async function userLogin(wallet: ethers.Wallet): Promise<string | null> {
  try {
    const message = 'pharos';
    const signature = await wallet.signMessage(message);
    const url = `${BASE_API}/user/login?address=${wallet.address}&signature=${signature}&invite_code=${REF_CODE}`;
    const response = await makeApiRequest<LoginResponse>('POST', url, 'null');
    if (response && response.data && response.data.jwt) {
      return response.data.jwt;
    }
    return null;
  } catch (error: any) {
    log(chalk.red(`Login Error: ${error.message}`));
    return null;
  }
}

async function userProfile(wallet: ethers.Wallet, authToken: string): Promise<number | null> {
  try {
    const response = await makeApiRequest<{ user_info: { TotalPoints: number } }>(
      'GET',
      `${BASE_API}/user/profile?address=${wallet.address}`,
      authToken
    );
    if (response && response.msg === 'ok') {
      return response.data.user_info.TotalPoints;
    }
    return null;
  } catch (error: any) {
    log(chalk.red(`Profile Error: ${error.message}`));
    return null;
  }
}

async function dailySignIn(wallet: ethers.Wallet, authToken: string): Promise<boolean> {
  try {
    const response = await makeApiRequest(
      'POST',
      `${BASE_API}/sign/in?address=${wallet.address}`,
      authToken
    );
    if (response && response.msg === 'ok') {
      log(chalk.green(`${getEmoji('calendar')} Sign-In Success`));
      return true;
    } else if (response && response.msg === 'already signed in today') {
      log(chalk.yellow(`${getEmoji('calendar')} Already Signed In Today`));
      return true;
    }
    log(chalk.red(`${getEmoji('x')} Sign-In Failed`));
    return false;
  } catch (error: any) {
    log(chalk.red(`${getEmoji('x')} Sign-In Error: ${error.message}`));
    return false;
  }
}

async function phrsFaucetStatus(wallet: ethers.Wallet, authToken: string): Promise<{ isAble: boolean; availableTimestamp?: number } | null> {
  try {
    const response = await makeApiRequest<{ is_able_to_faucet: boolean; avaliable_timestamp?: number }>(
      'GET',
      `${BASE_API}/faucet/status?address=${wallet.address}`,
      authToken
    );
    if (response && response.msg === 'ok') {
      return {
        isAble: response.data.is_able_to_faucet,
        availableTimestamp: response.data.avaliable_timestamp,
      };
    }
    return null;
  } catch (error: any) {
    log(chalk.red(`Faucet Status Error: ${error.message}`));
    return null;
  }
}

async function claimFaucet(wallet: ethers.Wallet, authToken: string): Promise<boolean> {
  try {
    const response = await makeApiRequest(
      'POST',
      `${BASE_API}/faucet/daily?address=${wallet.address}`,
      authToken
    );
    if (response && response.msg === 'ok') {
      log(chalk.green(`${getEmoji('white_check_mark')} PHRS Faucet Claimed: 0.2 PHRS`));
      return true;
    } else if (response && response.msg === 'user has not bound X account') {
      log(chalk.red(`PHRS Faucet: Not Eligible - Bind X Account`));
    } else {
      log(chalk.red(`PHRS Faucet: Claim Failed`));
    }
    return false;
  } catch (error: any) {
    log(chalk.red(`PHRS Faucet Error: ${error.message}`));
    return false;
  }
}

// Configuration Menu
async function configMenu(): Promise<void> {
  console.clear();
  log(chalk.cyan(`${getEmoji('gear')} ==============================================`));
  log(chalk.cyan(`${getEmoji('gear')} Configuration Settings`));
  log(chalk.cyan(`${getEmoji('gear')} ==============================================`));

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
          validate: (input: string) => (input.startsWith('http') ? true : 'Must be a valid URL'),
        },
      ]);
      config.rpcUrl = rpcUrl;
      saveConfig();
      if (!(await initProvider())) {
        log(chalk.red(`${getEmoji('x')} Failed to connect to new RPC URL`));
      }
      break;

    case 'Manage Friend Addresses':
      await manageFriendsMenu();
      break;

    case 'Back to Main Menu':
      return;
  }

  await configMenu();
}

async function manageWalletsMenu(): Promise<void> {
  console.clear();
  log(chalk.cyan(`${getEmoji('key')} ==============================================`));
  log(chalk.cyan(`${getEmoji('key')} Main Wallets Management`));
  log(chalk.cyan(`${getEmoji('key')} ==============================================`));

  if (config.wallets.length > 0) {
    log(chalk.blue(`Current main wallets (${config.wallets.length}):`));
    config.wallets.forEach((wallet: WalletConfig, i: number) => {
      log(chalk.blue(`${i + 1}. ${wallet.address} (Bearer: ${wallet.authToken.slice(0, 10)}...${wallet.authToken.slice(-10)})`));
    });
  } else {
    log(chalk.yellow(`${getEmoji('warning')} No main wallets configured`));
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
            message: `Input main wallet ${walletNumber} private key (with or without 0x, press Enter to finish):`,
            validate: (input: string) => {
              if (input === '') return true;
              const cleanKey = input.replace(/^0x/, '');
              if (cleanKey.length === 64 && /^[0-9a-fA-F]+$/.test(cleanKey)) return true;
              return 'Please enter a valid private key';
            },
          },
        ]);

        if (privateKey === '') break;

        const { authToken } = await inquirer.prompt<{ authToken: string }>([
          {
            type: 'input',
            name: 'authToken',
            message: `Input bearer token for wallet ${walletNumber}:`,
            validate: (input: string) => (input ? true : 'Bearer token cannot be empty'),
          },
        ]);

        try {
          const cleanKey = privateKey.replace(/^0x/, '');
          const wallet = new ethers.Wallet(cleanKey, provider);
          config.wallets.push({
            address: wallet.address,
            privateKey: `0x${cleanKey}`,
            authToken,
          });
          log(chalk.green(`${getEmoji('white_check_mark')} Wallet ${walletNumber} added: ${wallet.address}`));
          walletNumber++;
        } catch (error: any) {
          log(chalk.red(`${getEmoji('x')} Invalid private key for wallet ${walletNumber}: ${error.message}`));
        }
      }
      saveConfig();
      await setupWallets();
      break;

    case 'Remove Main Wallet':
      if (!config.wallets.length) {
        log(chalk.yellow(`${getEmoji('warning')} No main wallets to remove`));
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
      log(chalk.green(`${getEmoji('white_check_mark')} Wallet removed`));
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
        log(chalk.green(`${getEmoji('white_check_mark')} All main wallets removed`));
        await setupWallets();
      }
      break;
  }

  if (action !== 'Back to Config Menu') {
    await manageWalletsMenu();
  }
}

async function manageFriendsMenu(): Promise<void> {
  console.clear();
  log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ==============================================`));
  log(chalk.cyan(`${getEmoji('busts_in_silhouette')} Friend Addresses Management`));
  log(chalk.cyan(`${getEmoji('busts_in_silhouette')} ==============================================`));

  if (config.friendAddresses.length > 0) {
    log(chalk.blue(`Current friends (${config.friendAddresses.length}):`));
    config.friendAddresses.forEach((addr: string, i: number) => {
      log(chalk.blue(`${i + 1}. ${addr}`));
    });
  } else {
    log(chalk.yellow(`${getEmoji('warning')} No friend addresses configured`));
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
      config.friendAddresses.push(address);
      saveConfig();
      log(chalk.green(`${getEmoji('white_check_mark')} Friend added`));
      break;

    case 'Remove Friend Address':
      if (!config.friendAddresses.length) {
        log(chalk.yellow(`${getEmoji('warning')} No friends to remove`));
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
      log(chalk.green(`${getEmoji('white_check_mark')} Friend removed`));
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
        log(chalk.green(`${getEmoji('white_check_mark')} All friends removed`));
      }
      break;

    case 'Import Multiple Addresses':
      const { addresses } = await inquirer.prompt<{ addresses: string }>([
        {
          type: 'input',
          name: 'addresses',
          message: `${getEmoji('page_with_curl')} Enter comma-separated addresses:`,
          validate: (input: string) => {
            const addrs = input.split(',').map((addr: string) => addr.trim());
            return addrs.every((addr) => ethers.utils.isAddress(addr)) ? true : 'One or more addresses are invalid';
          },
        },
      ]);

      config.friendAddresses = [...new Set([...config.friendAddresses, ...addresses.split(',').map((addr: string) => addr.trim())])];
      saveConfig();
      log(chalk.green(`${getEmoji('white_check_mark')} Friends imported`));
      break;
  }

  if (action !== 'Back to Config Menu') {
    await manageFriendsMenu();
  }
}

async function mainMenu(): Promise<void> {
  console.clear();
  log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));
  log(chalk.green(` * ${getEmoji('robot')} Pharos Automated Bot ${getEmoji('sparkles')} *`));
  log(chalk.green(` * 1️⃣ [1] Check-In & Mint Faucet *`));
  log(chalk.green(` * 2️⃣ [2] Send To Friends *`));
  log(chalk.green(` * 3️⃣ [3] Wrapped/Unwrapped *`));
  log(chalk.green(` * 4️⃣ [4] Add Liquidity Pool *`));
  log(chalk.green(` * 5️⃣ [5] Swap USDT/USDC *`));
  log(chalk.green(` * 6️⃣ [6] Run All Features *`));
  log(chalk.green(` * 🔧 [7] Configuration *`));
  log(chalk.green(` * ❌ [8] Exit *`));
  log(chalk.green(`${getEmoji('star')} ${'*'.repeat(50)}`));

  const { feature } = await inquirer.prompt<{ feature: string }>([
    {
      type: 'list',
      name: 'feature',
      message: 'Select feature:',
      choices: [
        '1 - Check-In & Mint Faucet',
        '2 - Send To Friends',
        '3 - Wrapped/Unwrapped',
        '4 - Add Liquidity Pool',
        '5 - Swap USDT/USDC',
        '6 - Run All Features',
        '7 - Configuration',
        '8 - Exit',
      ],
    },
  ]);

  const featureNumber = parseInt(feature.split(' - ')[0]);

  if (featureNumber === 7) {
    await configMenu();
    return await mainMenu();
  }

  if (featureNumber === 8) {
    log(chalk.yellow(`${getEmoji('wave')} Exiting Pharos Bot...`));
    process.exit(0);
  }

  let params: SwapParams = {};

  if (featureNumber === 1) {
    const { mintFaucet } = await inquirer.prompt<{ mintFaucet: boolean }>([
      {
        type: 'confirm',
        name: 'mintFaucet',
        message: 'Mint USDC & USDT Faucet?',
        default: true,
      },
    ]);
    params.mintFaucet = mintFaucet;
  }

  if (featureNumber === 2) {
    const { sendTimes, sendAmount } = await inquirer.prompt<{
      sendTimes: number;
      sendAmount: number;
    }>([
      {
        type: 'number',
        name: 'sendTimes',
        message: 'How many times to transfer?',
        default: 1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
      {
        type: 'number',
        name: 'sendAmount',
        message: 'Amount per transfer (PHRS)?',
        default: 0.001,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
    ]);
    params.sendTimes = sendTimes;
    params.sendAmount = sendAmount;
  }

  if (featureNumber === 3) {
    const { wrapOption, wrapAmount } = await inquirer.prompt<{
      wrapOption: number;
      wrapAmount: number;
    }>([
      {
        type: 'list',
        name: 'wrapOption',
        message: 'Select option:',
        choices: [
          { name: 'Wrap PHRS to WPHRS', value: 1 },
          { name: 'Unwrap WPHRS to PHRS', value: 2 },
        ],
      },
      {
        type: 'number',
        name: 'wrapAmount',
        message: 'Amount to wrap/unwrap?',
        default: 0.001,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
    ]);
    params.wrapOption = wrapOption;
    params.wrapAmount = wrapAmount;
  }

  if (featureNumber === 4) {
    const { liquidityCount } = await inquirer.prompt<{ liquidityCount: number }>([
      {
        type: 'number',
        name: 'liquidityCount',
        message: 'How many times to add liquidity?',
        default: 1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
    ]);
    params.liquidityCount = liquidityCount;
  }

  if (featureNumber === 5) {
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
        message: 'Swap amount?',
        default: 0.1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
      {
        type: 'number',
        name: 'swapTimes',
        message: 'Number of swaps?',
        default: 1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
    ]);
    params.tokenIn = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDC.address : TOKENS.USDT.address;
    params.tokenOut = swapDirection === 'USDC_TO_USDT' ? TOKENS.USDT.address : TOKENS.USDC.address;
    params.swapAmount = swapAmount;
    params.swapTimes = swapTimes;
  }

  if (featureNumber === 6) {
    const answers = await inquirer.prompt<RunAllFeaturesAnswers>([
      {
        type: 'confirm',
        name: 'mintFaucet',
        message: 'Mint USDC & USDT Faucet?',
        default: true,
      },
      {
        type: 'number',
        name: 'sendTimes',
        message: 'How many times to transfer?',
        default: 1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
      {
        type: 'number',
        name: 'sendAmount',
        message: 'Amount per transfer (PHRS)?',
        default: 0.001,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
      {
        type: 'list',
        name: 'wrapOption',
        message: 'Wrap/Unwrap option:',
        choices: [
          { name: 'Wrap PHRS to WPHRS', value: 1 },
          { name: 'Unwrap WPHRS to PHRS', value: 2 },
          { name: 'Skip', value: 3 },
        ],
        default: 3,
      },
      {
        type: 'number',
        name: 'wrapAmount',
        message: 'Amount to wrap/unwrap?',
        default: 0.001,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
        when: (answers: RunAllFeaturesAnswers) => answers.wrapOption !== 3,
      },
      {
        type: 'number',
        name: 'liquidityCount',
        message: 'How many times to add liquidity?',
        default: 1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
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
        message: 'Swap amount?',
        default: 0.1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
      {
        type: 'number',
        name: 'swapTimes',
        message: 'Number of swaps?',
        default: 1,
        validate: (input: number) => (input > 0 ? true : 'Must be positive'),
      },
    ]);

    params.mintFaucet = answers.mintFaucet;
    params.sendTimes = answers.sendTimes;
    params.sendAmount = answers.sendAmount;
    params.wrapOption = answers.wrapOption;
    params.wrapAmount = answers.wrapAmount;
    params.liquidityCount = answers.liquidityCount;
    params.tokenIn = answers.swapDirection === 'USDC_TO_USDT' ? TOKENS.USDC.address : TOKENS.USDT.address;
    params.tokenOut = answers.swapDirection === 'USDC_TO_USDT' ? TOKENS.USDT.address : TOKENS.USDC.address;
    params.swapAmount = answers.swapAmount;
    params.swapTimes = answers.swapTimes;
  }

  await processTasks(featureNumber, params);
}

async function processTasks(featureNumber: number, params: SwapParams): Promise<void> {
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const walletConfig = config.wallets[i];
    log(chalk.cyan(`========== [${wallet.address.slice(0, 6)}...${wallet.address.slice(-6)}] ==========`));

    const token = await userLogin(wallet);
    if (!token) {
      log(chalk.red(`Login Failed`));
      continue;
    }
    log(chalk.green(`Login Success`));

    if (featureNumber === 1 || featureNumber === 6) {
      log(chalk.blue(`Option: Check-In & Mint Faucet`));
      const points = await userProfile(wallet, token);
      log(chalk.white(`Balance: ${points || 'N/A'} PTS`));

      await dailySignIn(wallet, token);

      log(chalk.cyan(`Faucets:`));
      const faucetStatus = await phrsFaucetStatus(wallet, token);
      if (faucetStatus) {
        if (faucetStatus.isAble) {
          await claimFaucet(wallet, token);
        } else if (faucetStatus.availableTimestamp) {
          const availableTime = format(new Date(faucetStatus.availableTimestamp * 1000), 'MM/dd/yyyy HH:mm:ss', { locale: id });
          log(chalk.yellow(`PHRS Faucet: Already Claimed - Available at ${availableTime}`));
        }
      } else {
        log(chalk.red(`PHRS Faucet: Status Check Failed`));
      }

      if (params.mintFaucet) {
        for (const tokenName of ['USDC', 'USDT']) {
          log(chalk.cyan(`  ● ${tokenName}:`));
          await mintFaucet(wallet, TOKENS[tokenName].address, tokenName);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5000 + 5000));
        }
      } else {
        log(chalk.yellow(`  ● USDC/USDT: Skipped`));
      }
    }

    if (featureNumber === 2 || featureNumber === 6) {
      log(chalk.blue(`Option: Send To Friends`));
      const sendTimes = params.sendTimes || 1;
      const sendAmount = params.sendAmount || 0.001;
      for (let j = 0; j < sendTimes; j++) {
        log(chalk.green(`Tx - ${j + 1}`));
        const receiver = ethers.Wallet.createRandom().address;
        const balance = await getTokenBalance(wallet, 'PHRS');
        log(chalk.white(`Balance: ${balance || 0} PHRS`));
        log(chalk.white(`Amount: ${sendAmount} PHRS`));
        log(chalk.white(`Receiver: ${receiver}`));
        await performTransfer(wallet, walletConfig.authToken, receiver, sendAmount);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5000 + 5000));
      }
    }

    if (featureNumber === 3 || featureNumber === 6) {
      const wrapOption = params.wrapOption || 3;
      const wrapAmount = params.wrapAmount || 0.001;
      if (wrapOption === 1) {
        log(chalk.blue(`Option: Wrap PHRS to WPHRS`));
        const balance = await getTokenBalance(wallet, 'PHRS');
        log(chalk.white(`Balance: ${balance || 0} PHRS`));
        log(chalk.white(`Amount: ${wrapAmount} PHRS`));
        await performWrapped(wallet, wrapAmount);
      } else if (wrapOption === 2) {
        log(chalk.blue(`Option: Unwrap WPHRS to PHRS`));
        const balance = await getTokenBalance(wallet, TOKENS.WPHRS.address);
        log(chalk.white(`Balance: ${balance || 0} WPHRS`));
        log(chalk.white(`Amount: ${wrapAmount} WPHRS`));
        await performUnwrapped(wallet, wrapAmount);
      } else {
        log(chalk.yellow(`Wrap/Unwrap: Skipped`));
      }
    }

    if (featureNumber === 4 || featureNumber === 6) {
      log(chalk.blue(`Option: Add Liquidity Pool`));
      const liquidityCount = params.liquidityCount || 1;
      for (let j = 0; j < liquidityCount; j++) {
        log(chalk.green(`Add Liquidity ${j + 1}/${liquidityCount}`));
        log(chalk.green(`Type: WPHRS/USDC`));
        const amount1 = 0.001;
        const amount2 = 0.15;
        const balance1 = await getTokenBalance(wallet, TOKENS.WPHRS.address);
        const balance2 = await getTokenBalance(wallet, TOKENS.USDC.address);
        log(chalk.cyan(`Balance:`));
        log(chalk.white(`  > ${balance1 || 0} WPHRS`));
        log(chalk.white(`  > ${balance2 || 0} USDC`));
        log(chalk.cyan(`Amount:`));
        log(chalk.white(`  > ${amount1} WPHRS`));
        log(chalk.white(`  > ${amount2} USDC`));
        await addLiquidity(wallet, amount1, amount2);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5000 + 15000));
      }
    }

    if (featureNumber === 5 || featureNumber === 6) {
      log(chalk.blue(`Option: Swap USDT/USDC`));
      const swapTimes = params.swapTimes || 1;
      const swapAmount = params.swapAmount || 0.1;
      const fromToken = params.tokenIn === TOKENS.USDC.address ? 'USDC' : 'USDT';
      const toToken = params.tokenOut === TOKENS.USDT.address ? 'USDT' : 'USDC';
      for (let j = 0; j < swapTimes; j++) {
        log(chalk.green(`Swap ${j + 1}/${swapTimes}`));
        log(chalk.green(`Type: ${fromToken} → ${toToken}`));
        const balance = await getTokenBalance(wallet, TOKENS[fromToken].address);
        log(chalk.white(`Balance: ${balance || 0} ${fromToken}`));
        log(chalk.white(`Amount: ${swapAmount} ${fromToken}`));
        await performSwap(wallet, fromToken, toToken, swapAmount);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5000 + 15000));
      }
    }
  }
}

// Initialize and start
async function start(): Promise<void> {
  log(chalk.cyan(`${getEmoji('rocket')} Initializing Pharos Bot...`));
  if (!(await initProvider())) {
    console.error(chalk.red(`${getEmoji('x')} Failed to initialize provider. Exiting...`));
    process.exit(1);
  }

  if (!(await setupWallets())) {
    log(chalk.yellow(`${getEmoji('warning')} Please configure at least one valid wallet`));
    await configMenu();
    if (!(await setupWallets())) {
      log(chalk.red(`${getEmoji('x')} Wallet setup failed. Exiting...`));
      process.exit(1);
    }
  }

  await mainMenu();
}

start().catch((error: any) => {
  log(chalk.red(`Fatal Error: ${error.message}`));
  process.exit(1);
});
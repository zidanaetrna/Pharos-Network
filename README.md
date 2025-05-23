# Pharos Network Bot

A bot for automating tasks on the Pharos Network testnet.

## Features

- Daily check-in
- Token faucet claims
- Token swapping (USDC ↔ USDT)
- Sending tokens to friends
- Automated scheduling of daily tasks

## Prerequisites

- Node.js (v18 or higher)
- TypeScript
- Yarn or npm

## Installation

1. Clone the repository
    ```bash
    git clone https://github.com/zidanaetrna/Pharos-Network

    ```
2. Install dependencies:
   ```bash
   yarn install
   ```
   or
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   WALLET_ADDRESS=your_wallet_address
   PRIVATE_KEY=your_private_key
   AUTH_TOKEN=your_bearer_token
   RPC_URL=https://testnet.dplabs-internal.com
   FRIEND_ADDRESSES=comma_separated_friend_addresses
   ```

## Usage

1. Build and run the bot:
   ```bash
   yarn start
   ```
   or
   ```bash
   npm run start
   ```

2. Follow the interactive menu to select features and configure settings.

## Configuration

The bot provides an interactive configuration menu where you can:
- Update private key
- Update bearer token
- Update RPC URL
- Manage friend addresses

## Scripts

- `build`: Compile TypeScript to JavaScript
- `start`: Compile and run the bot

## Dependencies

- axios
- chalk
- dotenv
- ethers
- inquirer
- node-emoji

## License

MIT License

Copyright (c) 2025 zidanaetrna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

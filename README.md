# ethers-multiprovider

**Features:**

- Support for [ethers-multicall](https://github.com/cavanmflynn/ethers-multicall) features.
- Support for [ethers](https://github.com/ethers-io/ethers.js) select features.
- A single instance of MultiProvider can be shared across different parts of the project. It will handle all submitted calls in way that distributes the load among multiple providers and ensures successive calls to the same provider respects the delay period set (`callsDelay`).
- Multicalls submitted from different parts can get aggregated into a single call.

## Installation:

```bash
> yarn add ethers-multiprovider
```

## Usage:

- `Contract(address, abi)`: Create contract instance; calling contract.callFuncName will yield a call object.
- `multiProvider.all(calls)`: Execute all calls in a single request, re.
- `multiProvider.allSettled(calls)`:
- calls: List of helper call methods.
- `getEthBalance(address)`: Returns account ether balance.

- `multiProvider.stop()`: Gracefully closes any running provider connection (e.g, websocket connection).

Supported Provider methods:

- `getNetwork`
- `getBlockNumber`
- `getGasPrice`
- `getFeeData`
- `getBalance`
- `getTransactionCount`
- `getCode`
- `getStorageAt`
- `getBlock`
- `getBlockWithTransactions`
- `getTransaction`
- `getTransactionReceipt`
- `getLogs`
- `resolveName` (Some providers do not support ENS operations)
- `lookupAddress` (Some providers do not support ENS operations)
- `waitForTransaction`

## Example:

```TypeScript
import {MultiProvider, Contract} from 'ethers-multiprovider';
import erc20Abi from './erc20Abi.json';

const usdcAddr = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
const multiProviderConf = {
    multicallAddress: "0x813715eF627B01f4931d8C6F8D2459F26E19137E", // Optional: multicall address, Arbitrum's in this case
    callsDelay: 2000,  // Optional: time in ms between calls to the same provider
    batchSize: 20,  // Optional: how many contract calls in each multicall
}

const multiProvider = new MultiProvider(42161, multiProviderConf);
const contract = new Contract(usdcAddr, erc20Abi, multiProvider);

// Multi-call
const [totalSupply, decimals] = await multiProvider.all([
    contract.totalSupply(),
    contract.decimals(),
]);

// Ethers-call
const balanceOf = await contract.callStatic.balanceOf("0x0a59649758aa4d66e25f08dd01271e891fe52199");

// Provider-call
const currentBlock = await multiProvider.getBlocknumber();
```

## TODO

- Support for [Ethers Signer]()

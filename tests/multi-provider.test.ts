import { BigNumber, ethers } from 'ethers';
import { Contract, MultiProvider } from '../src/index';
import erc20Abi from './erc20.json';

const failAbi = [
  {
    constant: true,
    inputs: [],
    name: 'fail',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
];
const eth = {
  usdcAddr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  addresses: [
    '0x0a59649758aa4d66e25f08dd01271e891fe52199',
    '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503',
    '0xcffad3200574698b78f32232aa9d63eabd290703',
    '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf',
    '0x829BD824B016326A401d083B33D092293333A830',
  ],
  providerUrls: {
    rpcs: [
      'https://rpc.ankr.com/eth',
      'https://eth-rpc.gateway.pokt.network',
      'https://api.mycryptoapi.com/eth',
    ],
  },
};
const arb = {
  usdcAddr: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  addresses: [
    '0x3e908d75caf0afc15fdff1bc2af77ff38fc7b5d3',
    '0x50450351517117cb58189edba6bbad6284d45902',
    '0xba12222222228d8ba445958a75a0704d566bf2c8',
    '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf',
    '0x829BD824B016326A401d083B33D092293333A830',
  ],
  providerUrls: {
    rpcs: [
      'https://arb1.arbitrum.io/rpc' /* "https://rpc.ankr.com/arbitrum" */,
    ],
    wss: ['wss://arb1.arbitrum.io/ws'],
  },
};

describe('Testing ethers-calls-mgr', () => {
  let multiProvider: MultiProvider;
  beforeAll(async () => {
    const ethersProvidersWithConf = [];
    arb.providerUrls.rpcs.forEach((rpc) =>
      ethersProvidersWithConf.push({
        provider: new ethers.providers.JsonRpcProvider(rpc),
        conf: { batchSize: 20, callsDelay: 1 },
      }),
    );
    arb.providerUrls.wss.forEach((wss) =>
      ethersProvidersWithConf.push({
        provider: new ethers.providers.WebSocketProvider(wss),
      }),
    );
    multiProvider = new MultiProvider(
      42161,
      {
        multicallAddress: '0x813715eF627B01f4931d8C6F8D2459F26E19137E',
      },
      console.log,
    );
    await Promise.all(
      ethersProvidersWithConf.map((e) =>
        multiProvider.addProvider(e.provider, e.conf),
      ),
    );
  });
  afterAll(async () => {
    await multiProvider.stop();
  }, 3000);

  it('Handles multi-calls properly', async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, erc20Abi);
      const calls = arb.addresses.map((addr) => contract.balanceOf(addr));
      const mCalls = calls.flatMap((x) => Array(10).fill(x));
      const results = await multiProvider.all(mCalls);
      const filtered = results.filter((r) => BigNumber.isBigNumber(r));
      expect(filtered.length).toBe(mCalls.length);
    } catch (error) {
      err.push(error);
    }
    expect(err.length).toBe(0);
  }, 10000);

  it('Handles multi-calls with errors', async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, erc20Abi.concat(failAbi));
      const calls = arb.addresses.map((addr) => contract.balanceOf(addr));
      const mCalls = [contract.fail()].concat(
        calls.flatMap((x) => Array(10).fill(x)),
      );
      const results = await multiProvider.allSettled(mCalls);
      expect(results.filter((r) => r.status === 'rejected').length).toBe(1);
    } catch (error) {
      err.push(error);
    }
    expect(err.length).toBe(0);
  }, 20000);

  it('Handles queryFilter calls properly', async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, erc20Abi, multiProvider);
      const queryFilterCall = contract.queryFilter(
        contract.filters.Transfer(),
        12794665,
        12794865,
      );
      const result = await queryFilterCall;
      expect(result[0]?.length).toBe(58);
    } catch (error) {
      err.push(error);
    }
    expect(err.length).toBe(0);
  }, 10000);

  it('Catches problematic providers', async () => {
    // @TODO: add an async method to test supplied providers' connectivity
  });

  it('Handles provider calls properly', async () => {
    const test = {
      address: '0x3e908d75caf0afc15fdff1bc2af77ff38fc7b5d3',
      contract: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
      txnHash:
        '0x0ac2d751d900748f08d297195884684ddd67d941246dafef6db4fa9a7f5e4de9',
      blockNumber: 12748512,
      filter: {
        address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x0000000000000000000000003e908d75caf0afc15fdff1bc2af77ff38fc7b5d3',
          '0x000000000000000000000000f3f094484ec6901ffc9681bcb808b96bafd0b8a8',
        ],
        fromBlock: 12748512,
        toBlock: 12748512,
      },
    };
    const err = [];
    try {
      const [
        getNetwork,
        getBlockNumber,
        getGasPrice,
        getFeeData,
        getBalance,
        getTransactionCount,
        getCode,
        getStorageAt,
        getBlock,
        getBlockWithTransactions,
        getTransaction,
        getTransactionReceipt,
        getLogs,
        waitForTransaction,
      ] = await Promise.all([
        multiProvider.getNetwork(),
        multiProvider.getBlockNumber(),
        multiProvider.getGasPrice(),
        multiProvider.getFeeData(),
        multiProvider.getBalance(test.address),
        multiProvider.getTransactionCount(test.address),
        multiProvider.getCode(test.contract),
        multiProvider.getStorageAt(test.contract, 0),
        multiProvider.getBlock(12748512),
        multiProvider.getBlockWithTransactions(12748512),
        multiProvider.getTransaction(test.txnHash),
        multiProvider.getTransactionReceipt(test.txnHash),
        multiProvider.getLogs(test.filter),
        multiProvider.waitForTransaction(test.txnHash),
      ]);

      expect(getNetwork.name).toBe('arbitrum');
      expect(getBlockNumber).toBeGreaterThan(0);
      expect(getGasPrice).toBeInstanceOf(BigNumber);
      expect(getFeeData.gasPrice).toBeInstanceOf(BigNumber);
      expect(getBalance).toBeInstanceOf(BigNumber);
      expect(getTransactionCount).toBeGreaterThan(0);
      expect(getCode.length).toBeGreaterThan(0);
      expect(parseInt(getStorageAt, 16)).toBe(1);
      expect(getBlock.number).toBe(12748512);
      expect(getBlockWithTransactions.number).toBe(12748512);
      expect(getTransaction.hash).toBe(test.txnHash);
      expect(getTransactionReceipt.transactionHash).toBe(test.txnHash);
      expect(getLogs.length).toBe(1);
      expect(waitForTransaction.transactionHash).toBe(test.txnHash);
    } catch (error) {
      err.push(error);
    }
    expect(err.length).toBe(0);
  }, 20000);

  it('Handles callStatic calls properly', async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, erc20Abi, multiProvider);
      const proms = arb.addresses.map((addr) =>
        contract.callStatic.balanceOf(addr),
      );
      const resps = await Promise.all(proms);
      resps.forEach((r) => expect(r).toBeInstanceOf(BigNumber));
    } catch (error) {
      err.push(error);
    }
    expect(err.length).toBe(0);
  }, 15000);
});

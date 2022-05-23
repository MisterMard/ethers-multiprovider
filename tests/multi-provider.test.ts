import { BigNumber, ethers } from "ethers";
import { Contract, MultiProvider, EthersProviderWithConf } from "../src/index";
import jarAbi from "./jar.json";

const failAbi = [
  {
    constant: true,
    inputs: [],
    name: "fail",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];
const eth = {
  usdcAddr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  addresses: [
    "0x0a59649758aa4d66e25f08dd01271e891fe52199",
    "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503",
    "0xcffad3200574698b78f32232aa9d63eabd290703",
    "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
    "0x829BD824B016326A401d083B33D092293333A830",
  ],
  providerUrls: {
    rpcs: [
      "https://rpc.ankr.com/eth",
      "https://eth-rpc.gateway.pokt.network",
      "https://api.mycryptoapi.com/eth",
    ],
  },
};
const arb = {
  usdcAddr: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  addresses: [
    "0x3e908d75caf0afc15fdff1bc2af77ff38fc7b5d3",
    "0x50450351517117cb58189edba6bbad6284d45902",
    "0xba12222222228d8ba445958a75a0704d566bf2c8",
    "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
    "0x829BD824B016326A401d083B33D092293333A830",
  ],
  providerUrls: {
    rpcs: ["https://arb1.arbitrum.io/rpc", /* "https://rpc.ankr.com/arbitrum" */],
    wss: ["wss://arb1.arbitrum.io/ws"],
  },
};

describe("Testing ethers-calls-mgr", () => {
  let multiProvider: MultiProvider;
  beforeAll(async () => {
    const ethersProvidersWithConf: EthersProviderWithConf[] = [];
    arb.providerUrls.rpcs.forEach((rpc) =>
      ethersProvidersWithConf.push({
        provider: new ethers.providers.JsonRpcProvider(rpc),
        conf: {},
      }),
    );
    arb.providerUrls.wss.forEach((wss) =>
      ethersProvidersWithConf.push({
        provider: new ethers.providers.WebSocketProvider(wss),
        conf: {},
      }),
    );
    multiProvider = new MultiProvider(ethersProvidersWithConf, 42161);
  });
  afterAll(async () => {
    await multiProvider.stop();
    console.log("done");
  });

  it("Handles multi-calls properly", async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, jarAbi);
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

  it("Handles multi-calls with errors", async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, jarAbi.concat(failAbi));
      const calls = arb.addresses.map((addr) => contract.balanceOf(addr));
      const mCalls = [contract.fail()].concat(
        calls.flatMap((x) => Array(10).fill(x)),
      );
      const results = await multiProvider.allSettled(mCalls);

      expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    } catch (error) {
      err.push(error);
    }
    expect(err.length).toBe(0);
  }, 20000);

  it("Handles queryFilter calls properly", async () => {
    const err = [];
    try {
      const contract = new Contract(arb.usdcAddr, jarAbi, multiProvider);
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
  }, 10000);

  it("Catches problematic providers", async () => {
    // @TODO: add an async method to supplied providers' connectivity
  });
});

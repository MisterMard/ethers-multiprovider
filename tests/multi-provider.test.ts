import { BigNumber, ethers } from "ethers";
import { Contract, MultiProvider, EthersProviderWithConf } from "../src/index";
import c from "./constants.json";
import jarAbi from "./jar.json";

describe("Testing ethers-calls-mgr", () => {
  let multiProvider: MultiProvider;
  beforeAll(async () => {
    const ethersProvidersWithConf: EthersProviderWithConf[] = [];
    c.arb.providerUrls.rpcs.forEach((rpc) =>
      ethersProvidersWithConf.push({
        provider: new ethers.providers.JsonRpcProvider(rpc),
        conf: {},
      }),
    );
    c.arb.providerUrls.wss.forEach((wss) =>
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
      const contract = new Contract(c.arb.usdcAddr, jarAbi);
      const calls = c.arb.addresses.map((addr) => contract.balanceOf(addr));
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
      const contract = new Contract(c.arb.usdcAddr, jarAbi.concat(c.failAbi));
      const calls = c.arb.addresses.map((addr) => contract.balanceOf(addr));
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
      const contract = new Contract(c.arb.usdcAddr, jarAbi);
      const queryFilterCall = contract.queryFilter(
        contract.filters.Transfer(),
        12794665,
        12794865,
      );
      const result = multiProvider.all([queryFilterCall]);
      expect(result[0]?.length).toBe(58);
    } catch (error) {
      err.push(error);
    }
  }, 10000);

  it("Catches problematic providers", async () => {
    // @TODO: add an async method to supplied providers' connectivity
  });
});

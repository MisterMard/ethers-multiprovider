import { Provider as MulticallProvider } from "./provider";
import { ContractCall } from "ethers-multicall";
import { v4 as uuid } from "uuid";
import {
  ContractCallError,
  ResolvedCalls,
  MulticallProviderWithConf,
  ContractCallWithId,
  EthersCallWithId,
  Logger,
  EthersProviderWithConf,
  EthersCall,
  EthersCallError,
} from "./types";
import { getProviderConfig, timeout } from "./helpers";
import EventEmitter from "events";

export class MultiProvider {
  private _providers: MulticallProviderWithConf[];
  private _mpsInUse: MulticallProviderWithConf[]; // multiProviders in use
  private _emitter: EventEmitter;
  private pendingWithError: ContractCallWithId[][] = [];
  private pending: ContractCallWithId[] = [];
  private pendingEthers: EthersCallWithId[] = [];
  private resolvedCalls: ResolvedCalls = {};
  private rejectedMulticalls: { [id: string]: ContractCall } = {};
  private rejectedEthersCalls: { [id: string]: EthersCall } = {};
  private _logErrors: boolean;
  private _logger: Logger;

  constructor(
    providersWithConf: EthersProviderWithConf[],
    chainId: number,
    logger: Logger = console.log, //silentLogger,
  ) {
    this._logger = logger;
    this._providers = [];
    providersWithConf.forEach((providerWithConf) => {
      const multiProviderWithConf = {
        provider: new MulticallProvider(providerWithConf.provider, chainId),
        conf: getProviderConfig(providerWithConf.conf),
      };
      this._providers.push(multiProviderWithConf);
    });
    this._mpsInUse = [];
    this._emitter = new EventEmitter();
  }

  public async all /* <T extends any[] = any[]> */(
    calls: (ContractCall | EthersCall)[],
  ) {
    const ids = await this.queueCallsAndWaitResolve(calls);

    return Promise.all(ids.map((id) => this.getResponse(id)));
  }
  public async allSettled /* <T extends any[] = any[]> */(
    calls: ContractCall[],
  ) {
    const ids = await this.queueCallsAndWaitResolve(calls);

    return Promise.allSettled(ids.map((id) => this.getResponse(id)));
  }
  private getResponse(id: string): Promise<any> {
    if (this.rejectedMulticalls[id]) {
      const err = new ContractCallError();
      err.contractCall = this.rejectedMulticalls[id];
      return Promise.reject(err);
    }
    if (this.rejectedEthersCalls[id]) {
      const err = new EthersCallError();
      err.call = this.rejectedEthersCalls[id];
      return Promise.reject(err);
    }

    return this.resolvedCalls[id];
  }
  private async queueCallsAndWaitResolve(calls: (ContractCall | EthersCall)[]) {
    const ids: string[] = [];
    const promises = calls.map((call) => {
      const id = uuid();
      if (isEthersCall(call)) {
        this.pendingEthers.push({ id: id, call });
      } else {
        this.pending.push({ id: id, contractCall: call });
      }
      ids.push(id);
      return this.awaitEventOnce(id);
    });

    this.run();

    await Promise.all(promises);
    return ids;
  }

  private runPending() {
    return (
      this.pending.length && this._mpsInUse.length !== this._providers.length
    );
  }

  private runErrored() {
    return (
      this.pendingWithError.length &&
      this._mpsInUse.length !== this._providers.length
    );
  }
  private runEthers() {
    return (
      this.pendingEthers.length &&
      this._mpsInUse.length !== this._providers.length
    );
  }

  private run() {
    if (this.runErrored()) {
      this.resolveErroredCalls(this.pendingWithError.shift());
    } else if (this.runEthers()) {
      const provider = this.getRandomProvider();
      this.executeEthersWrapper(provider, this.pendingEthers.shift());
      this.run();
    } else if (this.runPending()) {
      const callbacksBatch: ContractCallWithId[] = [];
      const provider = this.getRandomProvider();
      while (
        callbacksBatch.length < provider.conf.batchSize &&
        this.pending.length
      ) {
        callbacksBatch.push(this.pending.shift());
      }

      this.executeWrapper(provider, callbacksBatch);
      this.run();
    }
  }

  private async executeEthersWrapper(
    provider: MulticallProviderWithConf,
    call: EthersCallWithId,
  ) {
    try {
      const res = await call.call.params.contract.executeEthersCall(
        call.call,
        provider.provider.ethersProvider,
      );
      this.resolvedCalls[call.id] = res;
    } catch (error) {
      this.rejectedEthersCalls[call.id] = call.call;
    } finally {
      this._emitter.emit(call.id);
      await this.freeProvider(provider);
    }
  }

  private async resolveErroredCalls(erroredCalls: ContractCallWithId[]) {
    const provider = this.getRandomProvider();

    // ensure the calls length < provider max batch size
    const callsForCurrentProvider: ContractCallWithId[] = [];
    while (
      callsForCurrentProvider.length <= provider.conf.batchSize &&
      erroredCalls.length
    ) {
      callsForCurrentProvider.push(erroredCalls.shift());
    }

    // put excess calls back to pending
    erroredCalls.length && this.pendingWithError.push(erroredCalls);

    this.executeWrapper(provider, callsForCurrentProvider);
  }

  private async executeWrapper(
    provider: MulticallProviderWithConf,
    contractCalls: ContractCallWithId[],
  ) {
    try {
      await this.execute(provider, contractCalls);
      contractCalls.forEach((c) => this._emitter.emit(c.id));
    } catch (error: any) {
      // CALL_EXCEPTION = a failed call in the batch or a dead provider
      if (error.code === "CALL_EXCEPTION") {
        if (contractCalls.length === 1) {
          this.rejectedMulticalls[contractCalls[0].id] =
            contractCalls[0].contractCall;
          this._emitter.emit(contractCalls[0].id);
        } else {
          this._logger(
            `Error: A call or more in a multicall batch of ${contractCalls.length} calls resulted in an exception. Retrying...`,
          );
          this.handleErroredCalls(contractCalls);
        }
      } else {
        throw error;
      }
    } finally {
      await this.freeProvider(provider);
    }
  }
  private async execute(
    provider: MulticallProviderWithConf,
    callbacks: ContractCallWithId[],
  ) {
    const calls = callbacks.map((c) => c.contractCall);
    const responses = await provider.provider.all(calls);
    responses.forEach((res, i) => {
      this.resolvedCalls[callbacks[i].id] = res;
    });
  }

  private handleErroredCalls(erroredCalls: ContractCallWithId[]) {
    // split pending calls into 3 chunks
    const chunkSize = Math.ceil(erroredCalls.length / 3);
    while (erroredCalls.length) {
      const tmpCallsChunk: ContractCallWithId[] = [];
      while (erroredCalls.length && tmpCallsChunk.length < chunkSize) {
        tmpCallsChunk.push(erroredCalls.shift());
      }
      this.pendingWithError.push(tmpCallsChunk);
    }
  }

  private getRandomProvider(): MulticallProviderWithConf {
    const provider =
      this._providers[~~(Math.random() * this._providers.length)];
    if (this._mpsInUse.includes(provider)) return this.getRandomProvider();
    this._mpsInUse.push(provider);
    return provider;
  }

  // frees the provider in use, emits a run to clear pending callbacks
  private async freeProvider(prov: MulticallProviderWithConf) {
    const index = this._mpsInUse.findIndex((x) => x === prov);
    this._mpsInUse.splice(index, 1);
    await timeout(prov.conf.callsDelay);
    this._emitter.emit("provider freed");
    this.run();
  }

  private awaitEventOnce(eventStr: string) {
    return new Promise((_r) => {
      this._emitter.once(eventStr, _r);
    });
  }

  public async stop() {
    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[i];
      if (provider.provider.destroy) await provider.provider.destroy();
    }
  }

  counter = 0;
}

function isEthersCall(object: any): object is EthersCall {
  return "type" in object;
}

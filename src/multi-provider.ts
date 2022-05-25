import { Provider as MulticallProvider } from "./provider";
import { Provider as EthersProvider } from "@ethersproject/abstract-provider";
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
  ProviderCallWithId,
  ProviderCall,
  ProviderCallError,
  CallType,
} from "./types";
import { getProvidersWithConfig, silentLogger, timeout } from "./helpers";
import EventEmitter from "events";
import { Network } from "@ethersproject/networks";
import { ethers } from "ethers";

export class MultiProvider {
  private _providers: MulticallProviderWithConf[];
  private _mpsInUse: MulticallProviderWithConf[] = []; // multiProviders in use
  private _emitter: EventEmitter;
  private pendingWithError: ContractCallWithId[][] = [];
  private pending: ContractCallWithId[] = [];
  private pendingEthers: EthersCallWithId[] = [];
  private pendingProviderCalls: ProviderCallWithId[] = [];
  private resolvedCalls: ResolvedCalls = {};
  private rejectedMulticalls: { [id: string]: ContractCall } = {};
  private rejectedEthersCalls: { [id: string]: EthersCall } = {};
  private rejectedProviderCalls: { [id: string]: ProviderCall } = {};
  private _logErrors: boolean;
  private _logger: Logger;

  constructor(
    providersWithConf: (EthersProvider | EthersProviderWithConf)[],
    chainId: number,
    logger: Logger = silentLogger,
  ) {
    this._logger = logger;
    this._providers = getProvidersWithConfig(providersWithConf, chainId);
    this._emitter = new EventEmitter();
  }

  public async all(calls: (ContractCall | EthersCall)[]) {
    const ids = await this.queueCallsAndWaitResolve(calls);

    return Promise.all(ids.map((id) => this.getResponse(id)));
  }
  public async allSettled(calls: ContractCall[]) {
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
    if (this.rejectedProviderCalls[id]) {
      const err = new ProviderCallError();
      err.call = this.rejectedProviderCalls[id];
      return Promise.reject(err);
    }

    return this.resolvedCalls[id];
  }
  private async queueCallsAndWaitResolve(
    calls: (ContractCall | EthersCall | ProviderCall)[],
  ) {
    const ids: string[] = [];
    const promises = calls.map((call) => {
      const id = uuid();
      const callType = "type" in call ? call.type : CallType.MULTI_CONTRACT;
      switch (callType) {
        case CallType.MULTI_CONTRACT:
          this.pending.push({ id, contractCall: <ContractCall>call });
          break;
        case CallType.ETHERS_CONTRACT:
          this.pendingEthers.push({ id, call: <EthersCall>call });
          break;
        case CallType.PROVIDER:
          this.pendingProviderCalls.push({
            id,
            providerCall: <ProviderCall>call,
          });
          break;

        default:
          throw new Error("Undetermined callType");
          break;
      }
      ids.push(id);
      return this.awaitEventOnce(id);
    });

    this.run();

    await Promise.all(promises);
    return ids;
  }

  // @TODO Group the following into a single object
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
  private runProvider() {
    return (
      this.pendingProviderCalls.length &&
      this._mpsInUse.length !== this._providers.length
    );
  }

  // @TODO turn into a switch statement
  private run() {
    if (this.runProvider()) {
      const provider = this.getRandomProvider();
      this.executeProviderWrapper(provider, this.pendingProviderCalls.shift());
      this.run();
    } else if (this.runErrored()) {
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

  private async executeProviderWrapper(
    provider: MulticallProviderWithConf,
    call: ProviderCallWithId,
  ) {
    try {
      const res = await provider.provider._execute(
        call.providerCall.callName,
        ...call.providerCall.params,
      );
      this.resolvedCalls[call.id] = res;
    } catch (error) {
      this.rejectedProviderCalls[call.id] = call.providerCall;
    } finally {
      this._emitter.emit(call.id);
      await this.freeProvider(provider);
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
    if (erroredCalls.length) this.pendingWithError.push(erroredCalls);

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
      this._providers[Math.floor(Math.random() * this._providers.length)];
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
    for (const provider of this._providers) {
      if (provider.provider.destroy) await provider.provider.destroy();
    }
  }

  // EthersProvider methods
  // Network
  async getNetwork(): Promise<Network> {
    // const id = uuid();
    const providerCall: ProviderCall = {
      type: CallType.PROVIDER,
      callName: "getNetwork",
      params: [],
    };
    // this.pendingProviderCalls.push({ id, providerCall });
    // return this.getResponse(id);
    const id = await this.queueCallsAndWaitResolve(
      [providerCall],
    );
    return this.getResponse(id[0]);
  }

  // Latest State
  // abstract getBlockNumber(): Promise<number>;
  // abstract getGasPrice(): Promise<BigNumber>;
  // async getFeeData(): Promise<FeeData> {
  //   const { block, gasPrice } = await resolveProperties({
  //     block: this.getBlock("latest"),
  //     gasPrice: this.getGasPrice().catch((error) => {
  //       // @TODO: Why is this now failing on Calaveras?
  //       //console.log(error);
  //       return null;
  //     }),
  //   });

  //   let maxFeePerGas = null,
  //     maxPriorityFeePerGas = null;

  //   if (block && block.baseFeePerGas) {
  //     // We may want to compute this more accurately in the future,
  //     // using the formula "check if the base fee is correct".
  //     // See: https://eips.ethereum.org/EIPS/eip-1559
  //     maxPriorityFeePerGas = BigNumber.from("1500000000");
  //     maxFeePerGas = block.baseFeePerGas.mul(2).add(maxPriorityFeePerGas);
  //   }

  //   return { maxFeePerGas, maxPriorityFeePerGas, gasPrice };
  // }

  // // Account
  // abstract getBalance(
  //   addressOrName: string | Promise<string>,
  //   blockTag?: BlockTag | Promise<BlockTag>,
  // ): Promise<BigNumber>;
  // abstract getTransactionCount(
  //   addressOrName: string | Promise<string>,
  //   blockTag?: BlockTag | Promise<BlockTag>,
  // ): Promise<number>;
  // abstract getCode(
  //   addressOrName: string | Promise<string>,
  //   blockTag?: BlockTag | Promise<BlockTag>,
  // ): Promise<string>;
  // abstract getStorageAt(
  //   addressOrName: string | Promise<string>,
  //   position: BigNumberish | Promise<BigNumberish>,
  //   blockTag?: BlockTag | Promise<BlockTag>,
  // ): Promise<string>;

  // // Execution
  // abstract sendTransaction(
  //   signedTransaction: string | Promise<string>,
  // ): Promise<TransactionResponse>;
  // abstract call(
  //   transaction: Deferrable<TransactionRequest>,
  //   blockTag?: BlockTag | Promise<BlockTag>,
  // ): Promise<string>;
  // abstract estimateGas(
  //   transaction: Deferrable<TransactionRequest>,
  // ): Promise<BigNumber>;

  // // Queries
  // abstract getBlock(
  //   blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>,
  // ): Promise<Block>;
  // abstract getBlockWithTransactions(
  //   blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>,
  // ): Promise<BlockWithTransactions>;
  // abstract getTransaction(
  //   transactionHash: string,
  // ): Promise<TransactionResponse>;
  // abstract getTransactionReceipt(
  //   transactionHash: string,
  // ): Promise<TransactionReceipt>;

  // // Bloom-filter Queries
  // abstract getLogs(filter: Filter): Promise<Array<Log>>;

  // // ENS
  // abstract resolveName(name: string | Promise<string>): Promise<null | string>;
  // abstract lookupAddress(
  //   address: string | Promise<string>,
  // ): Promise<null | string>;

  // Event Emitter (ish)
  // abstract on(eventName: EventType, listener: Listener): Provider;
  // abstract once(eventName: EventType, listener: Listener): Provider;
  // abstract emit(eventName: EventType, ...args: Array<any>): boolean
  // abstract listenerCount(eventName?: EventType): number;
  // abstract listeners(eventName?: EventType): Array<Listener>;
  // abstract off(eventName: EventType, listener?: Listener): Provider;
  // abstract removeAllListeners(eventName?: EventType): Provider;

  // // Alias for "on"
  // addListener(eventName: EventType, listener: Listener): Provider {
  //     return this.on(eventName, listener);
  // }

  // // Alias for "off"
  // removeListener(eventName: EventType, listener: Listener): Provider {
  //     return this.off(eventName, listener);
  // }

  // @TODO: This *could* be implemented here, but would pull in events...
  // abstract waitForTransaction(
  //   transactionHash: string,
  //   confirmations?: number,
  //   timeout?: number,
  // ): Promise<TransactionReceipt>;
}

function isEthersCall(object: any): object is EthersCall {
  return object.type === CallType.ETHERS_CONTRACT;
}

function isProviderCall(object: any): object is ProviderCall {
  return object.type === CallType.PROVIDER;
}

import {
  Provider as EthersProvider,
  FeeData,
  BlockTag,
  Block,
  BlockWithTransactions,
  TransactionResponse,
  TransactionReceipt,
  Filter,
  Log,
} from "@ethersproject/abstract-provider";
import { ContractCall } from "ethers-multicall";
import { v4 as uuid } from "uuid";
import {
  ContractCallError,
  ResolvedCalls,
  MulticallProviderWithConf,
  ContractCallWithId,
  EthersContractCallWithId,
  Logger,
  EthersProviderWithConf,
  EthersCall,
  EthersCallError,
  ProviderCallWithId,
  // ProviderCall,
  ProviderCallError,
  CallType,
  EthersContractCall,
} from "./types";
import { getProvidersWithConfig, silentLogger, timeout } from "./helpers";
import EventEmitter from "events";
import { Network } from "@ethersproject/networks";
import { BigNumber, BigNumberish, ethers } from "ethers";

export class MultiProvider {
  private _providers: MulticallProviderWithConf[];
  private _mpsInUse: MulticallProviderWithConf[] = []; // multiProviders in use
  private _emitter: EventEmitter;
  private pendingWithError: ContractCallWithId[][] = [];
  private pending: ContractCallWithId[] = [];
  private pendingEthers: EthersContractCallWithId[] = [];
  private pendingProviderCalls: ProviderCallWithId[] = [];
  private resolvedCalls: ResolvedCalls = {};
  private rejected: {
    multi: { [id: string]: ContractCall };
    ethers: { [id: string]: EthersContractCall };
    provider: { [id: string]: EthersCall };
  } = { multi: {}, ethers: {}, provider: {} };
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

  public async all(calls: (ContractCall | EthersContractCall | EthersCall)[]) {
    const ids = await this.queueCallsAndWaitResolve(calls);

    return Promise.all(ids.map((id) => this.getResponse(id)));
  }
  public async allSettled(
    calls: (ContractCall | EthersContractCall | EthersCall)[],
  ) {
    const ids = await this.queueCallsAndWaitResolve(calls);

    return Promise.allSettled(ids.map((id) => this.getResponse(id)));
  }
  private getResponse(id: string): Promise<any> {
    if (this.rejected.multi[id]) {
      const err = new ContractCallError();
      err.contractCall = this.rejected.multi[id];
      return Promise.reject(err);
    }
    if (this.rejected.ethers[id]) {
      const err = new EthersCallError();
      err.call = this.rejected.ethers[id];
      return Promise.reject(err);
    }
    if (this.rejected.provider[id]) {
      const err = new ProviderCallError();
      err.call = this.rejected.provider[id];
      return Promise.reject(err);
    }

    return this.resolvedCalls[id];
  }
  private async queueCallsAndWaitResolve(
    calls: (ContractCall | EthersContractCall | EthersCall)[],
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
          this.pendingEthers.push({ id, call: <EthersContractCall>call });
          break;
        case CallType.PROVIDER:
          this.pendingProviderCalls.push({
            id,
            providerCall: <EthersCall>call,
          });
          break;

        default:
          throw new Error("Undetermined callType");
          break;
      }
      ids.push(id);
      return this.awaitEventOnce(id);
    });

    this.runNext();

    await Promise.all(promises);
    return ids;
  }

  private runNext() {
    if (this._mpsInUse.length !== this._providers.length) {
      // Provider > ErroredMulticall > Etherscalls > Multicalls
      if (this.pendingProviderCalls.length) {
        const provider = this.getRandomProvider();
        this.executeProviderWrapper(
          provider,
          this.pendingProviderCalls.shift(),
        );
      } else if (this.pendingWithError.length) {
        const provider = this.getRandomProvider();
        this.resolveErroredCalls(provider, this.pendingWithError.shift());
      } else if (this.pendingEthers.length) {
        const provider = this.getRandomProvider();
        this.executeEthersWrapper(provider, this.pendingEthers.shift());
      } else if (this.pending.length) {
        const provider = this.getRandomProvider();
        const callbacksBatch: ContractCallWithId[] = [];
        while (
          callbacksBatch.length < provider.conf.batchSize &&
          this.pending.length
        ) {
          callbacksBatch.push(this.pending.shift());
        }
        this.executeWrapper(provider, callbacksBatch);
      } else return;

      this.runNext();
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
      this.rejected.provider[call.id] = call.providerCall;
    } finally {
      this._emitter.emit(call.id);
      await this.freeProvider(provider);
    }
  }

  private async executeEthersWrapper(
    provider: MulticallProviderWithConf,
    call: EthersContractCallWithId,
  ) {
    try {
      const res = await call.call.contract.executeEthersCall(
        call.call,
        provider.provider.ethersProvider,
      );
      this.resolvedCalls[call.id] = res;
    } catch (error) {
      this.rejected.ethers[call.id] = call.call;
    } finally {
      this._emitter.emit(call.id);
      await this.freeProvider(provider);
    }
  }

  private async resolveErroredCalls(
    provider: MulticallProviderWithConf,
    erroredCalls: ContractCallWithId[],
  ) {
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
          this.rejected.multi[contractCalls[0].id] =
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
    this.runNext();
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
  private async _execute(callName: string, ...params: any[]) {
    const providerCall: EthersCall = {
      type: CallType.PROVIDER,
      callName: callName,
      params: [...params],
    };
    const id = await this.queueCallsAndWaitResolve([providerCall]);
    return this.getResponse(id[0]);
  }
  // Network
  getNetwork(): Promise<Network> {
    return this._execute("getNetwork");
  }

  // Latest State
  getBlockNumber(): Promise<number> {
    return this._execute("getBlockNumber");
  }
  getGasPrice(): Promise<BigNumber> {
    return this._execute("getGasPrice");
  }
  getFeeData(): Promise<FeeData> {
    return this._execute("getFeeData");
  }

  // Account
  getBalance(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<BigNumber> {
    return this._execute("getBalance", addressOrName, blockTag);
  }
  getTransactionCount(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<number> {
    return this._execute("getTransactionCount", addressOrName, blockTag);
  }
  getCode(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<string> {
    return this._execute("getCode", addressOrName, blockTag);
  }
  getStorageAt(
    addressOrName: string | Promise<string>,
    position: BigNumberish | Promise<BigNumberish>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<string> {
    return this._execute("getStorageAt", addressOrName, position, blockTag);
  }

  // @TODO Execution methods require a Signer object
  // Execution
  // sendTransaction(
  //   signedTransaction: string | Promise<string>,
  // ): Promise<TransactionResponse>{
  //   return this._execute("sendTransaction", signedTransaction);
  // };
  // call(
  //   transaction: Deferrable<TransactionRequest>,
  //   blockTag?: BlockTag | Promise<BlockTag>,
  // ): Promise<string>{
  //   return this._execute("call", transaction,blockTag);
  // };
  // estimateGas(
  //   transaction: Deferrable<TransactionRequest>,
  // ): Promise<BigNumber>{
  //   return this._execute("estimateGas", transaction);
  // };

  // Queries
  getBlock(
    blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>,
  ): Promise<Block> {
    return this._execute("getBlock", blockHashOrBlockTag);
  }
  getBlockWithTransactions(
    blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>,
  ): Promise<BlockWithTransactions> {
    return this._execute("getBlockWithTransactions", blockHashOrBlockTag);
  }
  getTransaction(transactionHash: string): Promise<TransactionResponse> {
    return this._execute("getTransaction", transactionHash);
  }
  getTransactionReceipt(transactionHash: string): Promise<TransactionReceipt> {
    return this._execute("getTransactionReceipt", transactionHash);
  }

  // Bloom-filter Queries
  getLogs(filter: Filter): Promise<Array<Log>> {
    return this._execute("getLogs", filter);
  }

  // ENS
  resolveName(name: string | Promise<string>): Promise<null | string> {
    return this._execute("resolveName", name);
  }
  lookupAddress(address: string | Promise<string>): Promise<null | string> {
    return this._execute("lookupAddress", address);
  }

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

  
  waitForTransaction(
    transactionHash: string,
    confirmations?: number,
    timeout?: number,
  ): Promise<TransactionReceipt> {
    return this._execute(
      "waitForTransaction",
      transactionHash,
      confirmations,
      timeout,
    );
  }
}

function isEthersCall(object: any): object is EthersContractCall {
  return object.type === CallType.ETHERS_CONTRACT;
}

function isProviderCall(object: any): object is EthersCall {
  return object.type === CallType.PROVIDER;
}

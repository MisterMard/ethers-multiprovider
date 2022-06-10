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
} from '@ethersproject/abstract-provider';
import { ContractCall, setMulticallAddress } from 'ethers-multicall';
import { v4 as uuid } from 'uuid';
import {
  ResolvedCalls,
  MulticallProviderWithConf,
  MultiContractCallWithId,
  EthersContractCallWithId,
  Logger,
  Call,
  ProviderCallWithId,
  ProviderCall,
  CallType,
  EthersContractCall,
  OptionalConf,
  ProviderConf,
  MultiProviderError,
  MultiContractCall,
} from './types';
import {
  fetchEthersProviderList,
  fulfillWithTimeLimit,
  isDeadRPC,
  isFlakyRPC,
  isTimeoutError,
  silentLogger,
  sortCalls,
  stripError,
  timeout,
} from './helpers';
import EventEmitter from 'events';
import { Network } from '@ethersproject/networks';
import { BigNumber, BigNumberish } from 'ethers';
import { Provider as MulticallProvider } from './provider';

export class MultiProvider {
  private _providers: MulticallProviderWithConf[] = [];
  private _mpsInUse: MulticallProviderWithConf[] = []; // multiProviders in use
  private _emitter: EventEmitter;
  private pending: {
    multi: {
      new: MultiContractCallWithId[];
      error: MultiContractCallWithId[][];
    };
    ethers: EthersContractCallWithId[];
    provider: ProviderCallWithId[];
  } = { multi: { new: [], error: [] }, ethers: [], provider: [] };
  private resolvedCalls: ResolvedCalls = {};
  private rejected: { [id: string]: MultiProviderError } = {};
  private _logger: Logger;
  private _chainId: number;
  private _conf: ProviderConf = { batchSize: 10, callsDelay: 2000 };

  constructor(
    chainId: number,
    globalConf: OptionalConf = { batchSize: 10, callsDelay: 2000 },
    logger: Logger = silentLogger,
  ) {
    this._chainId = chainId;
    this._logger = logger;
    this._conf = Object.assign(this._conf, globalConf);
    if (this._conf.multicallAddress) {
      setMulticallAddress(this._chainId, this._conf.multicallAddress);
    }
    this._emitter = new EventEmitter();
  }

  /**
   * Propagates the MultiProvider instance with public providers listed on https://chainlist.org/
   */
  public async initDefault() {
    const ethersProviders: EthersProvider[] = await fetchEthersProviderList(
      this._chainId,
    );
    await Promise.all(
      ethersProviders.map((provider) => this.addProvider(provider)),
    );
  }

  public async addProvider(
    provider: EthersProvider,
    _conf: OptionalConf = this._conf,
  ) {
    const conf = Object.assign(this._conf, _conf);
    if (conf.multicallAddress) {
      setMulticallAddress(this._chainId, conf.multicallAddress);
    }

    const multicallProvider = new MulticallProvider(provider, this._chainId);
    const bound = multicallProvider.init.bind(multicallProvider);
    try {
      await fulfillWithTimeLimit(
        3000,
        'Provider took too long to respond.',
        bound,
      );
    } catch (error) {
      this._logger(`Provider: ${multicallProvider.url} is offline!\n` + error);
      await multicallProvider.destroy();
      return;
    }
    for (const p of this._providers) {
      if (p.provider.url === multicallProvider.url) {
        this._logger(`Provider: ${multicallProvider.url} already exist!`);
        await multicallProvider.destroy();
        return;
      }
    }
    this._providers.push({ provider: multicallProvider, conf });
  }

  public async stop() {
    for (const provider of this._providers) {
      await provider.provider.destroy();
    }
  }

  public async all(calls: (ContractCall | Call)[]) {
    const ids = await this.queueCallsAndWaitResolve(sortCalls(calls));

    return Promise.all(ids.map((id) => this.getResponse(id)));
  }
  public async allSettled(calls: (ContractCall | Call)[]) {
    const ids = await this.queueCallsAndWaitResolve(sortCalls(calls));

    return Promise.allSettled(ids.map((id) => this.getResponse(id)));
  }
  private getResponse(id: string): Promise<any> {
    if (this.rejected[id]) {
      return Promise.reject(this.rejected[id]);
    }

    return this.resolvedCalls[id];
  }
  private async queueCallsAndWaitResolve(calls: Call[]) {
    const ids: string[] = [];
    const promises = calls.map((call) => {
      const id = uuid();
      switch (call.type) {
        case CallType.MULTI_CONTRACT:
          this.pending.multi.new.push({
            id,
            multiCall: call as MultiContractCall,
          });
          break;
        case CallType.ETHERS_CONTRACT:
          this.pending.ethers.push({
            id,
            ethersCall: call as EthersContractCall,
          });
          break;
        case CallType.PROVIDER:
          this.pending.provider.push({
            id,
            providerCall: call as ProviderCall,
          });
          break;

        default:
          throw new Error('Undetermined callType');
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
      if (this.pending.provider.length) {
        const provider = this.getRandomProvider();
        this.executeProviderWrapper(provider, this.pending.provider.shift());
      } else if (this.pending.multi.error.length) {
        const provider = this.getRandomProvider();
        this.resolveErroredCalls(provider, this.pending.multi.error.shift());
      } else if (this.pending.ethers.length) {
        const provider = this.getRandomProvider();
        this.executeEthersWrapper(provider, this.pending.ethers.shift());
      } else if (this.pending.multi.new.length) {
        const provider = this.getRandomProvider();
        const callbacksBatch: MultiContractCallWithId[] = [];
        while (
          callbacksBatch.length < provider.conf.batchSize &&
          this.pending.multi.new.length
        ) {
          callbacksBatch.push(this.pending.multi.new.shift());
        }
        this.executeMulticallWrapper(provider, callbacksBatch);
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
        call.providerCall.methodName,
        ...call.providerCall.params,
      );
      this.resolvedCalls[call.id] = res;
      this._emitter.emit(call.id);
    } catch (error: any) {
      this.handleCaughtError(error, provider, call);
    } finally {
      await this.freeProvider(provider);
    }
  }

  private async executeEthersWrapper(
    provider: MulticallProviderWithConf,
    call: EthersContractCallWithId,
  ) {
    try {
      const res = await call.ethersCall.ethersContract.executeEthersCall(
        call.ethersCall,
        provider.provider.ethersProvider,
      );
      this.resolvedCalls[call.id] = res;
      this._emitter.emit(call.id);
    } catch (error: any) {
      this.handleCaughtError(error, provider, call);
    } finally {
      await this.freeProvider(provider);
    }
  }

  private async resolveErroredCalls(
    provider: MulticallProviderWithConf,
    erroredCalls: MultiContractCallWithId[],
  ) {
    // ensure the calls length < provider max batch size
    const callsForCurrentProvider: MultiContractCallWithId[] = [];
    while (
      callsForCurrentProvider.length <= provider.conf.batchSize &&
      erroredCalls.length
    ) {
      callsForCurrentProvider.push(erroredCalls.shift());
    }

    // put excess calls back to pending
    if (erroredCalls.length) this.pending.multi.error.push(erroredCalls);

    this.executeMulticallWrapper(provider, callsForCurrentProvider);
  }

  private async executeMulticallWrapper(
    provider: MulticallProviderWithConf,
    contractCalls: MultiContractCallWithId[],
  ) {
    try {
      await this.executeMulticall(provider, contractCalls);
      contractCalls.forEach((c) => this._emitter.emit(c.id));
    } catch (error: any) {
      this.handleCaughtError(error, provider, contractCalls);
    } finally {
      await this.freeProvider(provider);
    }
  }
  private async executeMulticall(
    provider: MulticallProviderWithConf,
    callbacks: MultiContractCallWithId[],
  ) {
    const calls = callbacks.map((c) => c.multiCall.contractCall);
    const responses = await provider.provider.all(calls);
    responses.forEach((res, i) => {
      this.resolvedCalls[callbacks[i].id] = res;
    });
  }

  private handleErroredMultiCalls(erroredCalls: MultiContractCallWithId[]) {
    // split pending calls into 3 chunks
    const chunkSize = Math.ceil(erroredCalls.length / 3);
    while (erroredCalls.length) {
      const tmpCallsChunk: MultiContractCallWithId[] = [];
      while (erroredCalls.length && tmpCallsChunk.length < chunkSize) {
        tmpCallsChunk.push(erroredCalls.shift());
      }
      this.pending.multi.error.push(tmpCallsChunk);
    }
  }

  private handleCaughtError(
    error: any,
    provider: MulticallProviderWithConf,
    callOrCalls:
      | MultiContractCallWithId[]
      | EthersContractCallWithId
      | ProviderCallWithId,
  ) {
    const err = stripError(error);
    const pushCallOrCalls = (
      callOrCalls:
        | MultiContractCallWithId[]
        | EthersContractCallWithId
        | ProviderCallWithId,
    ) => {
      if (Array.isArray(callOrCalls)) {
        this.pending.multi.new.push(...callOrCalls);
      } else if ('ethersCall' in callOrCalls) {
        this.pending.ethers.push(callOrCalls);
      } else if ('providerCall' in callOrCalls) {
        this.pending.provider.push(callOrCalls);
      }
    };

    // Catch provider errors and remove any problematic provider/increase callsDelay/lower batchSize
    // Timeout (set a timeout of 5s and increase the delay by 20%)
    if (isTimeoutError(err)) {
      this._logger(
        `Provider: ${provider.provider.url} timedout for 5s\nCurrent callsDelay: ${provider.conf.callsDelay}`,
      );
      provider.timeout = Date.now();
      provider.conf.callsDelay *= 1.2;
      pushCallOrCalls(callOrCalls);
    } else if (isDeadRPC(err)) {
      this._logger(`Provider: ${provider.provider.url} is offline\n${err}`);
      this.removeProvider(provider);
      pushCallOrCalls(callOrCalls);
    } else if (isFlakyRPC(err)) {
      this._logger(`Provider: ${provider.provider.url} is flaky\n${err}`);
      pushCallOrCalls(callOrCalls);
    } else {
      if (Array.isArray(callOrCalls)) {
        if (callOrCalls.length === 1) {
          this.rejected[callOrCalls[0].id] = new MultiProviderError(
            provider.provider,
            callOrCalls[0].multiCall,
            err.code,
            err.reason,
          );
          this._emitter.emit(callOrCalls[0].id);
        } else {
          this._logger(
            `Error: A call or more in a multicall batch of ${callOrCalls.length} calls resulted in an exception. Retrying...` +
              `\nProvider: ${provider.provider.url}`,
          );
          this.handleErroredMultiCalls(callOrCalls);
        }
      } /* if ("ethersCall" in callOrCalls) */ else {
        this.rejected[callOrCalls.id] = new MultiProviderError(
          provider.provider,
          'ethersCall' in callOrCalls
            ? callOrCalls.ethersCall
            : callOrCalls.providerCall,
          err.code,
          err.reason,
        );
        this._emitter.emit(callOrCalls.id);
      }
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
    if (prov.timeout) {
      const delta = Date.now() - prov.timeout;
      await timeout(delta);
      delete prov.timeout;
    } else {
      await timeout(prov.conf.callsDelay);
    }
    this._mpsInUse.splice(index, 1);
    this.runNext();
  }

  private removeProvider(prov: MulticallProviderWithConf) {
    const index = this._providers.findIndex((x) => x === prov);
    this._providers.splice(index, 1);
  }

  private awaitEventOnce(eventStr: string) {
    return new Promise((_r) => {
      this._emitter.once(eventStr, _r);
    });
  }

  // EthersProvider methods
  private async _execute(callName: string, ...params: any[]) {
    const providerCall: ProviderCall = {
      type: CallType.PROVIDER,
      methodName: callName,
      params: [...params],
    };
    const id = await this.queueCallsAndWaitResolve([providerCall]);
    return this.getResponse(id[0]);
  }
  // Network
  getNetwork(): Promise<Network> {
    return this._execute('getNetwork');
  }

  // Latest State
  getBlockNumber(): Promise<number> {
    return this._execute('getBlockNumber');
  }
  getGasPrice(): Promise<BigNumber> {
    return this._execute('getGasPrice');
  }
  getFeeData(): Promise<FeeData> {
    return this._execute('getFeeData');
  }

  // Account
  getBalance(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<BigNumber> {
    return this._execute('getBalance', addressOrName, blockTag);
  }
  getTransactionCount(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<number> {
    return this._execute('getTransactionCount', addressOrName, blockTag);
  }
  getCode(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<string> {
    return this._execute('getCode', addressOrName, blockTag);
  }
  getStorageAt(
    addressOrName: string | Promise<string>,
    position: BigNumberish | Promise<BigNumberish>,
    blockTag?: BlockTag | Promise<BlockTag>,
  ): Promise<string> {
    return this._execute('getStorageAt', addressOrName, position, blockTag);
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
    return this._execute('getBlock', blockHashOrBlockTag);
  }
  getBlockWithTransactions(
    blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>,
  ): Promise<BlockWithTransactions> {
    return this._execute('getBlockWithTransactions', blockHashOrBlockTag);
  }
  getTransaction(transactionHash: string): Promise<TransactionResponse> {
    return this._execute('getTransaction', transactionHash);
  }
  getTransactionReceipt(transactionHash: string): Promise<TransactionReceipt> {
    return this._execute('getTransactionReceipt', transactionHash);
  }

  // Bloom-filter Queries
  getLogs(filter: Filter): Promise<Array<Log>> {
    return this._execute('getLogs', filter);
  }

  // ENS
  resolveName(name: string | Promise<string>): Promise<null | string> {
    return this._execute('resolveName', name);
  }
  lookupAddress(address: string | Promise<string>): Promise<null | string> {
    return this._execute('lookupAddress', address);
  }

  // @TODO Event Emitter (ish)
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
      'waitForTransaction',
      transactionHash,
      confirmations,
      timeout,
    );
  }
}

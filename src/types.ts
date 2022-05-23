import { ContractCall } from "ethers-multicall";
import { Provider as MulticallProvider } from "./provider";
import {
  Provider as EthersProvider,
  BlockTag,
} from "@ethersproject/abstract-provider";
import { Contract } from "./contract";
import { EventFilter } from "@ethersproject/contracts";

// Interfaces & Types

export interface ResolvedCalls {
  [id: string]: any;
}
export interface ProviderConf {
  callsDelay: number; // time delay between calls in ms
  batchSize: number;
}
export interface MulticallProviderWithConf {
  provider: MulticallProvider;
  conf: ProviderConf;
}
export interface OptionalConf {
  callsDelay?: number;
  batchSize?: number;
}
export interface EthersProviderWithConf {
  provider: EthersProvider;
  conf: OptionalConf;
}
export interface ContractCallWithId {
  id: string;
  contractCall: ContractCall;
}

export interface QueryFilterCall {
  contract: Contract;
  event: EventFilter;
  params: [BlockTag?, BlockTag?];
}
export interface EthersCall {
  type: string;
  params: QueryFilterCall /* | any */;
}
export interface EthersCallWithId {
  id: string;
  call: EthersCall;
}
export interface Logger {
  (errorLog: string): any;
}

export interface ConsoleErrorLogger {
  logError(where: string, error: any, context?: any): void;
}

export class ContractCallError extends Error {
  contractCall: ContractCall;
  constructor() {
    super("Contract call failed!");
  }
}

export class EthersCallError extends Error {
  call: EthersCall;
  constructor() {
    super("Ethers call failed!");
  }
}

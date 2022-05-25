import { ContractCall } from 'ethers-multicall';
import { Provider as MulticallProvider } from './provider';
import { Provider as EthersProvider } from '@ethersproject/abstract-provider';
import { Contract } from './contract';

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
export interface MultiContractCallWithId {
  id: string;
  contractCall: ContractCall;
}

export interface EthersCall {
  type: CallType;
  methodName: string;
}
export interface ProviderCall extends EthersCall {
  params: any[];
}
export interface ProviderCallWithId {
  id: string;
  providerCall: ProviderCall;
}
export interface EthersContractCall extends EthersCall {
  contract: Contract;
  contractCall: ContractCall;
}
export interface EthersContractCallWithId {
  id: string;
  call: EthersContractCall;
}
export type Logger = (errorLog: string) => any;

export enum CallType {
  ETHERS_CONTRACT = 'ETHERS_CONTRACT',
  MULTI_CONTRACT = 'MULTI_CONTRACT',
  PROVIDER = 'PROVIDER',
}

export interface ConsoleErrorLogger {
  logError(where: string, error: any, context?: any): void;
}

// tslint:disable:max-classes-per-file
export class ContractCallError extends Error {
  contractCall: ContractCall;
  constructor() {
    super('Contract call failed!');
  }
}
export class EthersCallError extends Error {
  call: EthersCall;
  constructor() {
    super('Ethers call failed!');
  }
}
export class ProviderCallError extends Error {
  call: EthersCall;
  constructor() {
    super('Provider call failed!');
  }
}
// tslint:enable:max-classes-per-file

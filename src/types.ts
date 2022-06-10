// import { ContractCall } from 'ethers-multicall';
import { Provider as MulticallProvider } from './provider';
import { Contract } from './contract';
import { ParamType } from '@ethersproject/abi';

// Interfaces & Types
export interface ResolvedCalls {
  [id: string]: any;
}
export interface ProviderConf {
  callsDelay: number; // time delay between calls in ms
  batchSize: number;
  multicallAddress?: string;
}
export interface MulticallProviderWithConf {
  provider: MulticallProvider;
  conf: ProviderConf;
  timeout?: number;
}
export interface OptionalConf {
  callsDelay?: number;
  batchSize?: number;
  multicallAddress?: string;
}

export enum CallType {
  ETHERS_CONTRACT = 'ETHERS_CONTRACT',
  MULTI_CONTRACT = 'MULTI_CONTRACT',
  PROVIDER = 'PROVIDER',
}

export interface ContractCall {
  contract: {
    address: string;
  };
  name: string;
  inputs: ParamType[];
  outputs: ParamType[];
  params: any[];
}
export interface Call {
  type: CallType;
}
export interface ProviderCall extends Call {
  methodName: string;
  params: any[];
}
export interface MultiContractCall extends Call {
  contractCall: ContractCall;
}
export interface EthersContractCall extends MultiContractCall {
  ethersContract: Contract;
  contractCall: ContractCall;
}
export interface MultiContractCallWithId {
  id: string;
  multiCall: MultiContractCall;
}
export interface ProviderCallWithId {
  id: string;
  providerCall: ProviderCall;
}
export interface EthersContractCallWithId {
  id: string;
  ethersCall: EthersContractCall;
}
export type Logger = (errorLog: string) => any;

export class MultiProviderError extends Error {
  constructor(
    multicallProvider: MulticallProvider,
    call: Call,
    error: any,
  ) {
    let errStr: string;
    const reason = error.reason ?? error.message;
    switch (call.type) {
      case CallType.PROVIDER:
        const pCall = call as ProviderCall;
        errStr = `
        Provider: ${multicallProvider.url}
        Method: ${pCall.methodName}(${pCall.params.join(', ')})
        Code: ${error.code}
        Reason: ${reason}`;
        break;
      case CallType.ETHERS_CONTRACT:
        const eCall = call as EthersContractCall;
        errStr = `
        Provider: ${multicallProvider.url}
        Contract: ${eCall.ethersContract.address}
        Method: callStatic.${
          eCall.contractCall.name
        }(${eCall.contractCall.params.join(', ')})
        Code: ${error.code}
        Reason: ${reason}`;
        break;
      case CallType.MULTI_CONTRACT:
        const mCall = call as MultiContractCall;
        errStr = `
        Provider: ${multicallProvider.url}
        Contract: ${mCall.contractCall.contract.address}
        Method: ${mCall.contractCall.name}(${mCall.contractCall.params.join(
          ', ',
        )})
        Code: ${error.code}
        Reason: ${reason}`;
        break;

      default:
        errStr = 'Unknown Error!';
        break;
    }

    super(errStr);
  }
}

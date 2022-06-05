import { ContractCall, Call, MultiContractCall, CallType } from './types';
import { Provider as EthersProvider } from '@ethersproject/abstract-provider';
import fetch from 'cross-fetch';
import { ethers } from 'ethers';


export async function fetchEthersProviderList(
  chainId: number,
): Promise<EthersProvider[]> {
  const formatRpcUrl = (url: string) => {
    if (
      !(url.startsWith('https') || url.startsWith('wss')) ||
      url.includes('$')
    ) {
      return;
    }
    if (url.lastIndexOf('/') === url.length - 1) {
      return url.substring(0, url.length - 1);
    }
    return url;
  };

  // Fetch RPC urls
  const rawRpcList: any[] = await fetch('https://chainid.network/chains.json')
    .then((x) => x.json())
    .catch(() => []);
  const rawRpcObject = await fetch(
    'https://raw.githubusercontent.com/DefiLlama/chainlist/main/constants/extraRpcs.json',
  )
    .then((x) => x.json())
    // tslint:disable-next-line
    .catch(() => {});

  const unfiltered = [];
  rawRpcList
    .filter((x) => x.chainId && x.rpc && x.rpc.length)
    .forEach((f) => {
      unfiltered.push({ chainId: f.chainId, rpc: f.rpc });
    });
  Object.keys(rawRpcObject).forEach((id) => {
    if (rawRpcObject[id].rpcWorking !== false) {
      unfiltered.push({ chainId: id, rpc: rawRpcObject[id].rpcs ?? [] });
    }
  });

  // Group RPCs by chain
  const filtered = {};
  unfiltered.forEach((x) => {
    const rpcList: string[] = [];
    x.rpc.forEach((r: string) => {
      const formatted = formatRpcUrl(r);
      if (formatted) rpcList.push(formatted);
    });
    if (rpcList.length) {
      filtered[x.chainId]
        ? filtered[x.chainId].push(...rpcList)
        : (filtered[x.chainId] = rpcList);
    }
  });

  // Filter out duplicates
  Object.keys(filtered).forEach((key) => {
    filtered[key] = filtered[key].filter((x, i, arr) => arr.indexOf(x) === i);
  });

  // Instantiate & return EthersProviders
  const ethersProviderList: EthersProvider[] = [];
  if (filtered[chainId]) {
    filtered[chainId].map((rpc) => {
      if (rpc.startsWith('wss')) {
        const ethersProvider = new ethers.providers.WebSocketProvider(rpc);
        ethersProviderList.push(ethersProvider);
      } else {
        const ethersProvider = new ethers.providers.JsonRpcProvider(rpc);
        ethersProviderList.push(ethersProvider);
      }
    });
  }
  return ethersProviderList;
}

export function sortCalls(calls: (ContractCall | Call)[]) {
  return calls.map((call) => {
    if ('type' in call) return call;
    return {
      type: CallType.MULTI_CONTRACT,
      contractCall: call,
    } as MultiContractCall;
  });
}

export function timeout(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// tslint:disable-next-line
export function silentLogger(_msg: string) {}

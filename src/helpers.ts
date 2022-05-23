import {
  OptionalConf,
  ProviderConf,
  MulticallProviderWithConf,
  EthersProviderWithConf,
} from './types';
import { Provider as MulticallProvider } from './provider';
import { Provider as EthersProvider } from '@ethersproject/abstract-provider';

export const isError = (err: unknown): err is Error => err instanceof Error;

export function logError(where: string, error: any, context?: any) {
  console.log(
    'ERROR: Failed at ' +
      where +
      (context !== undefined ? ' [' + context + ']' : '') +
      '\n' +
      error,
  );
}

const defaultConfig = {
  batchSize: 10,
  callsDelay: 2000,
};

export function getProviderConfig(conf: OptionalConf): ProviderConf {
  return Object.assign(defaultConfig, conf);
}
export function getProvidersWithConfig(
  providersWithConf: (EthersProvider | EthersProviderWithConf)[],
  chainId: number,
): MulticallProviderWithConf[] {
  const multiprovidersWithConf: MulticallProviderWithConf[] = [];
  providersWithConf.forEach((providerWithConf) => {
    if (providerWithConf instanceof EthersProvider) {
      multiprovidersWithConf.push({
        provider: new MulticallProvider(providerWithConf, chainId),
        conf: defaultConfig,
      });
    } else {
      multiprovidersWithConf.push({
        provider: new MulticallProvider(providerWithConf.provider, chainId),
        conf: Object.assign(defaultConfig, providerWithConf.conf),
      });
    }
  });
  return multiprovidersWithConf;
}

export function timeout(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// tslint:disable-next-line
export function silentLogger(_msg: string) {}

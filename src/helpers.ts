import { OptionalConf, ProviderConf } from './types';

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

export function getProviderConfig(conf: OptionalConf): ProviderConf {
  const providerConf: ProviderConf = {
    batchSize: conf.batchSize ?? 10,
    callsDelay: conf.callsDelay ?? 2000,
  };
  return providerConf;
}

export function timeout(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// tslint:disable-next-line
export function silentLogger(_msg: string) {}

import { Provider as EthersProvider } from "@ethersproject/abstract-provider";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { Provider as MulticallProvider } from "ethers-multicall";

export class Provider extends MulticallProvider {
  url: string;
  ethersProvider: EthersProvider;
  _chainId: number;
  destroy: () => Promise<void>;
  constructor(provider: EthersProvider, chainId: number) {
    super(provider, chainId);
    this.ethersProvider = provider;
    this._chainId = chainId;
    this.destroy = () => {
      if (this.ethersProvider instanceof WebSocketProvider)
        return this.ethersProvider.destroy();
      return;
    };
    if (provider instanceof JsonRpcProvider) {
      this.url = provider.connection.url;
    }
    if (provider instanceof WebSocketProvider) {
      this.url = provider._websocket._url;
    }
  }

  async init(): Promise<void> {
    const [chainId] = await Promise.all([
      this.ethersProvider.getNetwork().then((x) => x.chainId),
      this.ethersProvider.getBlockNumber(),
    ]);
    if (chainId !== this._chainId) {
      throw new Error(
        `Provider: ${this.url} is not for chain [${this._chainId}]!`,
      );
    }
  }

  _execute(call: string, ..._params: any[]) {
    return this.ethersProvider[call](..._params);
  }
}

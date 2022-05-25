import { Provider as EthersProvider } from "@ethersproject/abstract-provider";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { Provider as MultiProvider } from "ethers-multicall";

export class Provider extends MultiProvider {
  url: string;
  ethersProvider: EthersProvider;
  destroy: () => Promise<void>;
  constructor(provider: EthersProvider, chainId: number) {
    super(provider, chainId);
    this.ethersProvider = provider;
    if (provider instanceof JsonRpcProvider) {
      this.url = provider.connection.url;
    }
    if (provider instanceof WebSocketProvider) {
      this.url = provider._websocket._url;
      this.destroy = () => {
        return provider.destroy();
      };
    }
  }

  _execute(call: string, ..._params: any[]) {
    return this.ethersProvider[call](..._params);
  }
}

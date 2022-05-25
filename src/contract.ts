import { Fragment, Interface, JsonFragment } from "@ethersproject/abi";
import { Contract as MultiContract, ContractCall } from "ethers-multicall";
import { BlockTag } from "@ethersproject/abstract-provider";
import {
  Event,
  EventFilter,
  Contract as EthersContract,
} from "@ethersproject/contracts";
import { EventFragment } from "ethers/lib/utils";
import { Provider as EthersProvider } from "@ethersproject/abstract-provider";
import { MultiProvider } from "./multi-provider";
import { CallType, EthersContractCall } from "./types";

export class Contract extends MultiContract {
  private _filters: { [name: string]: (...args: Array<any>) => EventFilter } =
    {};
  private _eventFragments: EventFragment[];
  private _interface: Interface;
  private _multiProvider: MultiProvider;
  private _callStatic: {
    [name: string]: (...args: Array<any>) => Promise<any>;
  } = {};

  get filters() {
    return this._filters;
  }

  get callStatic() {
    return this._callStatic;
  }

  get multiProvider() {
    return this._multiProvider;
  }

  constructor(
    address: string,
    abi: JsonFragment[] | string[] | Fragment[],
    multiProvider?: MultiProvider,
  ) {
    super(address, abi);
    this._multiProvider = multiProvider;

    this._eventFragments = toFragment(abi)
      .filter((x: { type: string }) => x.type === "event")
      .map((x) => EventFragment.from(x));

    // Save the contract interface
    this._interface = EthersContract.getInterface(abi);

    // Extract event filters
    {
      const uniqueFilters: { [name: string]: Array<string> } = {};
      Object.keys(this._interface.events).forEach((eventSignature) => {
        const event = this._interface.events[eventSignature];
        defineReadOnly(this._filters, eventSignature, (...args: Array<any>) => {
          return {
            address: this.address,
            topics: this._interface.encodeFilterTopics(event, args),
          };
        });
        if (!uniqueFilters[event.name]) {
          uniqueFilters[event.name] = [];
        }
        uniqueFilters[event.name].push(eventSignature);
      });

      Object.keys(uniqueFilters).forEach((name) => {
        const filters = uniqueFilters[name];
        if (filters.length === 1) {
          defineReadOnly(this.filters, name, this.filters[filters[0]]);
        } else {
          console.warn(
            `Duplicate definition of ${name} (${filters.join(", ")})`,
          );
        }
      });
    }

    for (const func of this.functions) {
      const { name } = func;
      const getCall = makeCallStaticFunction(this, name);
      if (!this._callStatic[name]) {
        this._callStatic[name] = getCall;
      }
    }
  }

  queryFilter(
    event: EventFilter,
    fromBlockOrBlockhash?: BlockTag | string,
    toBlock?: BlockTag,
  ) {
    if (!this._multiProvider)
      throw new Error("No MultiProvider were supplied!");
    const contractCall: ContractCall = {
      contract: { address: this.address },
      name: "",
      inputs: [],
      outputs: [],
      params: [event, fromBlockOrBlockhash, toBlock],
    };
    const ethersCall: EthersContractCall = {
      type: CallType.ETHERS_CONTRACT,
      methodName: "queryFilter",
      contract: this,
      contractCall,
    };
    return this._multiProvider.all([ethersCall]);
  }
  private async _queryFilter(
    provider: EthersProvider,
    ethersCall: EthersContractCall,
  ): Promise<Array<Event>> {
    const contract = new EthersContract(
      this.address,
      this._eventFragments,
      provider,
    );
    const { params } = ethersCall.contractCall;
    return contract["queryFilter"](params[0], params[1], params[2]);
  }
  private async _executeCallStatic(
    provider: EthersProvider,
    ethersCall: EthersContractCall,
  ) {
    const contract = new EthersContract(
      this.address,
      this._interface,
      provider,
    );
    return contract.callStatic[ethersCall.methodName](
      ...ethersCall.contractCall.params,
    );
  }

  executeEthersCall(ethersCall: EthersContractCall, provider: EthersProvider) {
    switch (ethersCall.methodName) {
      case "queryFilter":
        return this._queryFilter(provider, ethersCall);

      default:
        return this._executeCallStatic(provider, ethersCall);
    }
  }
}

function toFragment(abi: JsonFragment[] | string[] | Fragment[]): Fragment[] {
  return abi.map((item: JsonFragment | string | Fragment) =>
    Fragment.from(item),
  );
}

function makeCallStaticFunction(
  multiContract: Contract,
  name: string,
): (...args: Array<any>) => Promise<any> {
  return (...params: any[]) => {
    if (!multiContract.multiProvider)
      throw new Error("No MultiProvider were supplied!");
    const { address } = multiContract;
    const { inputs } = multiContract.functions.find((f) => f.name === name);
    const { outputs } = multiContract.functions.find((f) => f.name === name);
    const contractCall = {
      contract: {
        address,
      },
      name,
      inputs,
      outputs,
      params,
    };
    const ethersCall: EthersContractCall = {
      type: CallType.ETHERS_CONTRACT,
      methodName: name,
      contract: multiContract,
      contractCall,
    };
    return multiContract.multiProvider.all([ethersCall]).then((x) => x[0]);
  };
}

function defineReadOnly(object: object, name: string, value: unknown) {
  Object.defineProperty(object, name, {
    enumerable: true,
    value,
    writable: false,
  });
}

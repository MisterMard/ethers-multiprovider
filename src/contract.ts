import { Fragment, Interface, JsonFragment } from '@ethersproject/abi';
import { Contract as MultiContract } from 'ethers-multicall';
import { BlockTag } from '@ethersproject/abstract-provider';
import {
  Event,
  EventFilter,
  Contract as EthersContract,
} from '@ethersproject/contracts';
import { EventFragment } from 'ethers/lib/utils';
import { Provider as EthersProvider } from '@ethersproject/abstract-provider';
import { MultiProvider } from './multi-provider';
import { EthersCall, QueryFilterCall } from './types';

export class Contract extends MultiContract {
  private _filters: { [name: string]: (...args: Array<any>) => EventFilter } =
    {};
  private _eventFragments: EventFragment[];
  private _interface: Interface;
  private _multiProvider: MultiProvider;

  get filters() {
    return this._filters;
  }

  constructor(
    address: string,
    abi: JsonFragment[] | string[] | Fragment[],
    multiProvider?: MultiProvider,
  ) {
    super(address, abi);
    this._multiProvider = multiProvider;

    this._eventFragments = toFragment(abi)
      .filter((x: { type: string }) => x.type === 'event')
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
            `Duplicate definition of ${name} (${filters.join(', ')})`,
          );
        }
      });
    }
  }

  queryFilter(
    event: EventFilter,
    fromBlockOrBlockhash?: BlockTag | string,
    toBlock?: BlockTag,
  ) {
    if (!this._multiProvider) throw new Error('No MultiProvider were supplied!');
    const ethersCall: EthersCall = {
      type: 'QUERY_FILTER',
      params: {
        contract: this,
        event,
        params: [fromBlockOrBlockhash, toBlock],
      },
    };
    return this._multiProvider.all([ethersCall]);
  }
  private async _queryFilter(
    params: QueryFilterCall,
    provider: EthersProvider,
  ): Promise<Array<Event>> {
    const contract = new EthersContract(
      this.address,
      this._eventFragments,
      provider,
    );
    return contract.queryFilter(
      params.event,
      params.params[0],
      params.params[1],
    );
  }

  executeEthersCall(ethersCall: EthersCall, provider: EthersProvider) {
    switch (ethersCall.type) {
      case 'QUERY_FILTER':
        return this._queryFilter(ethersCall.params, provider);

      default:
        break;
    }
  }
}

function toFragment(abi: JsonFragment[] | string[] | Fragment[]): Fragment[] {
  return abi.map((item: JsonFragment | string | Fragment) =>
    Fragment.from(item),
  );
}

function defineReadOnly(object: object, name: string, value: unknown) {
  Object.defineProperty(object, name, {
    enumerable: true,
    value,
    writable: false,
  });
}

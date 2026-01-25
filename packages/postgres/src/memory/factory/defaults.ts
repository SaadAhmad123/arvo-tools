import type { ConnectPostgresMachineMemoryParam } from './type';

export const DEFAULT_V1_TABLE_NAMES: NonNullable<
  Extract<ConnectPostgresMachineMemoryParam, { version: 1 }>['tables']
> = {
  state: 'state',
  lock: 'lock',
  hierarchy: 'hierarchy',
};

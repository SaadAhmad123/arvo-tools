import type { ConnectPostgresMachineMemoryParam } from './type';

export const DEFAULT_V1_TABLE_NAMES: NonNullable<
  Extract<ConnectPostgresMachineMemoryParam, { version: 1 }>['tables']
> = {
  state: 'arvopg_mm_state',
  lock: 'arvopg_mm_lock',
  hierarchy: 'arvopg_mm_hierarchy',
};

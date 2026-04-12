import type { IToolDispatch } from '../Tools/interface';
import type { PromiseAble } from '../types';

export interface IToolNotExist {
  id: string;
  type: 'tool_not_exist';
  body(): PromiseAble<IToolDispatch>;
}

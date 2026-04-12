import type { IToolDispatch } from '../Tools/interface';
import type { IToolNotExist } from './interface';

export class ToolNotExist implements IToolNotExist {
  public readonly type = 'tool_not_exist' as const;

  public readonly id: string;
  private readonly dispatch: IToolDispatch;

  constructor(id: string, dispatch: IToolDispatch) {
    this.id = id;
    this.dispatch = dispatch;
  }

  body(): IToolDispatch {
    return this.dispatch;
  }
}

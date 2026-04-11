export interface IStringEncoder {
  encode(input: string): string;
  decode(input: string): string;
}

export class ToolNameEncoder implements IStringEncoder {
  private readonly SENTINEL = '_';
  private readonly BASE36_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

  private encodeCharCode(code: number): string {
    const high = Math.floor(code / 36);
    const low = code % 36;
    return this.SENTINEL + this.BASE36_DIGITS[high] + this.BASE36_DIGITS[low];
  }

  private isPassthrough(char: string): boolean {
    return char !== this.SENTINEL && /^[a-zA-Z0-9_]$/.test(char);
  }

  encode(input: string): string {
    let result = '';
    for (const char of input) {
      if (this.isPassthrough(char)) {
        result += char;
      } else {
        result += this.encodeCharCode(char.charCodeAt(0));
      }
    }
    return result;
  }

  decode(input: string): string {
    let result = '';
    let i = 0;
    while (i < input.length) {
      if (input[i] === this.SENTINEL) {
        const hStr = input[i + 1] ?? null;
        const lStr = input[i + 2] ?? null;
        if (lStr === null || hStr === null) continue;
        const high = this.BASE36_DIGITS.indexOf(hStr);
        const low = this.BASE36_DIGITS.indexOf(lStr);
        result += String.fromCharCode(high * 36 + low);
        i += 3;
      } else {
        result += input[i];
        i++;
      }
    }
    return result;
  }
}
